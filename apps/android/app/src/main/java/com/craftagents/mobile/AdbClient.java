package com.craftagents.mobile;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.Signature;
import java.security.interfaces.RSAPublicKey;
import java.util.Arrays;
import java.util.Base64;

/** Minimal authenticated ADB-over-TCP client used only after explicit user opt-in. */
final class AdbClient {
    private static final String KEY_ALIAS = "tokenbird-network-adb";
    private static final int A_CNXN = 0x4e584e43;
    private static final int A_AUTH = 0x48545541;
    private static final int A_OPEN = 0x4e45504f;
    private static final int A_OKAY = 0x59414b4f;
    private static final int A_CLSE = 0x45534c43;
    private static final int A_WRTE = 0x45545257;
    private static final int AUTH_TOKEN = 1;
    private static final int AUTH_SIGNATURE = 2;
    private static final int AUTH_RSAPUBLICKEY = 3;
    private static final int MAX_OUTPUT_BYTES = 512 * 1024;

    static final class Result {
        final String stdout;
        final int exitCode;
        final boolean truncated;

        Result(String stdout, int exitCode, boolean truncated) {
            this.stdout = stdout;
            this.exitCode = exitCode;
            this.truncated = truncated;
        }
    }

    private static final class Message {
        final int command;
        final int arg0;
        final int arg1;
        final byte[] data;

        Message(int command, int arg0, int arg1, byte[] data) {
            this.command = command;
            this.arg0 = arg0;
            this.arg1 = arg1;
            this.data = data;
        }
    }

    private final Context context;

    AdbClient(Context context) {
        this.context = context.getApplicationContext();
    }

    Result execute(String host, int port, String command, int timeoutMs) throws Exception {
        if (command == null || command.trim().isEmpty()) throw new IOException("ADB command is empty");
        int boundedTimeout = Math.max(2_000, Math.min(timeoutMs, 120_000));
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(host, port), Math.min(boundedTimeout, 10_000));
            socket.setSoTimeout(boundedTimeout);
            DataInputStream input = new DataInputStream(socket.getInputStream());
            DataOutputStream output = new DataOutputStream(socket.getOutputStream());
            authenticate(input, output);
            return openShell(input, output, command.trim());
        }
    }

    private void authenticate(DataInputStream input, DataOutputStream output) throws Exception {
        send(output, A_CNXN, 0x01000001, 256 * 1024, bytes("host::tokenbird\0"));
        Message response = read(input);
        if (response.command == A_CNXN) return;
        if (response.command != A_AUTH || response.arg0 != AUTH_TOKEN) {
            throw new IOException("Unexpected ADB handshake response");
        }

        KeyPair keyPair = loadOrCreateKeyPair();
        send(output, A_AUTH, AUTH_SIGNATURE, 0, signToken(keyPair, response.data));
        response = read(input);
        if (response.command == A_CNXN) return;
        if (response.command != A_AUTH || response.arg0 != AUTH_TOKEN) {
            throw new IOException("ADB authentication failed");
        }

        send(output, A_AUTH, AUTH_RSAPUBLICKEY, 0, encodePublicKey((RSAPublicKey) keyPair.getPublic()));
        response = read(input);
        if (response.command != A_CNXN) {
            throw new IOException("Approve the TokenBird ADB key on the target device, then retry");
        }
    }

    private Result openShell(DataInputStream input, DataOutputStream output, String command) throws IOException {
        int localId = 1;
        String marker = "__TOKENBIRD_ADB_EXIT__";
        String wrappedCommand = command + "\n__tokenbird_exit=$?\nprintf '\\n" + marker + "%s\\n' \"$__tokenbird_exit\"";
        send(output, A_OPEN, localId, 0, bytes("shell:" + wrappedCommand + "\0"));
        Message response = read(input);
        if (response.command == A_CLSE) throw new IOException("ADB shell service rejected the command");
        if (response.command != A_OKAY || response.arg1 != localId) {
            throw new IOException("Unexpected ADB shell response");
        }
        int remoteId = response.arg0;
        ByteArrayOutputStream captured = new ByteArrayOutputStream();
        boolean truncated = false;
        while (true) {
            Message message;
            try {
                message = read(input);
            } catch (EOFException eof) {
                break;
            }
            if (message.command == A_WRTE && message.arg0 == remoteId && message.arg1 == localId) {
                int remaining = MAX_OUTPUT_BYTES - captured.size();
                if (remaining > 0) captured.write(message.data, 0, Math.min(remaining, message.data.length));
                if (message.data.length > remaining) truncated = true;
                send(output, A_OKAY, localId, remoteId, new byte[0]);
            } else if (message.command == A_CLSE) {
                send(output, A_CLSE, localId, remoteId, new byte[0]);
                break;
            }
        }
        String outputText = captured.toString(StandardCharsets.UTF_8);
        int exitCode = 0;
        int markerIndex = outputText.lastIndexOf("\n" + marker);
        if (markerIndex >= 0) {
            int valueStart = markerIndex + marker.length() + 1;
            int valueEnd = outputText.indexOf('\n', valueStart);
            if (valueEnd < 0) valueEnd = outputText.length();
            try {
                exitCode = Integer.parseInt(outputText.substring(valueStart, valueEnd).trim());
                outputText = outputText.substring(0, markerIndex);
            } catch (NumberFormatException ignored) {
                // Preserve raw output when a shell unexpectedly rewrites the marker.
            }
        }
        return new Result(outputText, exitCode, truncated);
    }

    private KeyPair loadOrCreateKeyPair() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(KEY_ALIAS)) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance(
                    KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                    .setKeySize(2048)
                    .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA1, KeyProperties.DIGEST_SHA256)
                    .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
                    .build());
            generator.generateKeyPair();
        }
        KeyStore.PrivateKeyEntry entry = (KeyStore.PrivateKeyEntry) store.getEntry(KEY_ALIAS, null);
        return new KeyPair(entry.getCertificate().getPublicKey(), entry.getPrivateKey());
    }

    private byte[] signToken(KeyPair keyPair, byte[] token) throws Exception {
        // ADB sends a SHA-1 digest and expects RSA_sign(NID_sha1, digest).
        byte[] digestInfoPrefix = hex("3021300906052b0e03021a05000414");
        byte[] digestInfo = new byte[digestInfoPrefix.length + token.length];
        System.arraycopy(digestInfoPrefix, 0, digestInfo, 0, digestInfoPrefix.length);
        System.arraycopy(token, 0, digestInfo, digestInfoPrefix.length, token.length);
        Signature signature = Signature.getInstance("NONEwithRSA");
        signature.initSign(keyPair.getPrivate());
        signature.update(digestInfo);
        return signature.sign();
    }

    private byte[] encodePublicKey(RSAPublicKey key) {
        final int words = 64;
        final int keyBytes = words * 4;
        BigInteger modulus = key.getModulus();
        BigInteger two32 = BigInteger.ONE.shiftLeft(32);
        long n0inv = modulus.mod(two32).modInverse(two32).negate().mod(two32).longValue();
        BigInteger rr = BigInteger.ONE.shiftLeft(keyBytes * 16).mod(modulus);

        ByteBuffer struct = ByteBuffer.allocate(4 + 4 + keyBytes + keyBytes + 4)
                .order(ByteOrder.LITTLE_ENDIAN);
        struct.putInt(words);
        struct.putInt((int) n0inv);
        struct.put(toLittleEndian(modulus, keyBytes));
        struct.put(toLittleEndian(rr, keyBytes));
        struct.putInt(key.getPublicExponent().intValue());
        String encoded = Base64.getEncoder().encodeToString(struct.array()) + " tokenbird@android\0";
        return encoded.getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] toLittleEndian(BigInteger value, int size) {
        byte[] bigEndian = value.toByteArray();
        if (bigEndian.length > size) bigEndian = Arrays.copyOfRange(bigEndian, bigEndian.length - size, bigEndian.length);
        byte[] littleEndian = new byte[size];
        for (int i = 0; i < bigEndian.length; i++) littleEndian[i] = bigEndian[bigEndian.length - 1 - i];
        return littleEndian;
    }

    private static void send(DataOutputStream output, int command, int arg0, int arg1, byte[] data) throws IOException {
        int checksum = 0;
        for (byte value : data) checksum += value & 0xff;
        writeLeInt(output, command);
        writeLeInt(output, arg0);
        writeLeInt(output, arg1);
        writeLeInt(output, data.length);
        writeLeInt(output, checksum);
        writeLeInt(output, command ^ 0xffffffff);
        output.write(data);
        output.flush();
    }

    private static Message read(DataInputStream input) throws IOException {
        int command = readLeInt(input);
        int arg0 = readLeInt(input);
        int arg1 = readLeInt(input);
        int length = readLeInt(input);
        int checksum = readLeInt(input);
        int magic = readLeInt(input);
        if ((command ^ 0xffffffff) != magic || length < 0 || length > 1024 * 1024) {
            throw new IOException("Invalid ADB packet header");
        }
        byte[] data = new byte[length];
        input.readFully(data);
        int actual = 0;
        for (byte value : data) actual += value & 0xff;
        // ADB 1.0.1 and newer may set the checksum field to zero after
        // negotiating ADB_VERSION_SKIP_CHECKSUM. Older peers still send a
        // checksum, so validate it whenever it is present.
        if (checksum != 0 && actual != checksum) throw new IOException("Invalid ADB packet checksum");
        return new Message(command, arg0, arg1, data);
    }

    private static void writeLeInt(DataOutputStream output, int value) throws IOException {
        output.writeInt(Integer.reverseBytes(value));
    }

    private static int readLeInt(DataInputStream input) throws IOException {
        return Integer.reverseBytes(input.readInt());
    }

    private static byte[] bytes(String value) {
        return value.getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] hex(String value) {
        byte[] result = new byte[value.length() / 2];
        for (int i = 0; i < result.length; i++) {
            result[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        }
        return result;
    }
}
