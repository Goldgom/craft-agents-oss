package com.craftagents.mobile;

import android.content.Context;
import android.content.res.AssetManager;
import android.os.Build;
import android.util.Base64;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.InetSocketAddress;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Map;

/**
 * Owns the Bun-powered TokenBird backend bundled in the APK.
 *
 * Android only ships the aarch64 Bun runtime. Gradle places it in the
 * extracted native library directory, while the JavaScript bundle and its
 * resources are copied from APK assets into the app-private files directory.
 */
final class LocalAgentServer {
    private static final String TAG = "CraftAgentServer";
    // Bun's official Android binary currently declares API 28 in its
    // .note.android.ident section and imports libc symbols introduced in P.
    // API 26/27 can still use TokenBird in remote mode, but cannot execute this
    // bundled runtime safely.
    static final int MIN_RUNTIME_API = Build.VERSION_CODES.P;
    private static final long READY_TIMEOUT_MS = 15_000L;
    private static final String ASSET_ROOT = "server";
    private static final int OUTPUT_LIMIT = 8 * 1024;

    static final class ConnectionInfo {
        final int port;
        final String token;

        ConnectionInfo(int port, String token) {
            this.port = port;
            this.token = token;
        }
    }

    private final Context context;
    private final SecureRandom random = new SecureRandom();
    private final Object lock = new Object();
    private Process process;
    private File serverRoot;
    private String token;
    private int port;
    private final StringBuilder recentOutput = new StringBuilder();

    LocalAgentServer(Context context) {
        this.context = context.getApplicationContext();
    }

    static boolean isSupportedOnThisDevice() {
        return Build.VERSION.SDK_INT >= MIN_RUNTIME_API;
    }

    ConnectionInfo start() throws IOException {
        return start(true);
    }

    private ConnectionInfo start(boolean allowRetry) throws IOException {
        if (!isSupportedOnThisDevice()) {
            throw new IOException("The bundled local server requires Android 9 or newer");
        }

        synchronized (lock) {
            if (process != null && process.isAlive()) return new ConnectionInfo(port, token);

            process = null;
            token = null;
            port = 0;
            recentOutput.setLength(0);

            serverRoot = new File(context.getFilesDir(), "craft-agent-server");
            prepareAssets(serverRoot);

            File bun = new File(context.getApplicationInfo().nativeLibraryDir, "libbun.so");
            if (!bun.isFile()) {
                // Fallback for packaging environments that do not extract the
                // JNI file. The normal Android APK path is nativeLibraryDir.
                bun = new File(serverRoot, "bun");
                copyAsset("server/bun", bun);
            }
            if (!bun.isFile()) throw new IOException("Bundled Android Bun runtime is missing");
            bun.setExecutable(true, false);

            File seccompCompat = new File(
                    context.getApplicationInfo().nativeLibraryDir,
                    "libbun_seccomp_compat.so");
            if (!seccompCompat.isFile()) {
                throw new IOException("Bundled Android Bun compatibility library is missing");
            }

            token = generateToken();
            port = findAvailablePort();
            File entry = new File(serverRoot, "server.js");
            if (!entry.isFile()) throw new IOException("Bundled local server entrypoint is missing");

            ProcessBuilder builder = new ProcessBuilder(bun.getAbsolutePath(), entry.getAbsolutePath());
            builder.directory(serverRoot);
            builder.redirectErrorStream(true);
            Map<String, String> environment = builder.environment();
            environment.put("CRAFT_SERVER_TOKEN", token);
            environment.put("CRAFT_RPC_HOST", "127.0.0.1");
            environment.put("CRAFT_RPC_PORT", Integer.toString(port));
            environment.put("CRAFT_APP_ROOT", serverRoot.getAbsolutePath());
            environment.put("CRAFT_BUNDLED_ASSETS_ROOT", serverRoot.getAbsolutePath());
            environment.put("CRAFT_RESOURCES_PATH", new File(serverRoot, "resources").getAbsolutePath());
            environment.put("CRAFT_IS_PACKAGED", "true");
            environment.put("CRAFT_ANDROID", "true");
            environment.put("CRAFT_MINIMAL_SERVER", "true");
            environment.put("CRAFT_DISABLE_MESSAGING", "true");
            environment.put("CRAFT_VERSION", BuildConfig.VERSION_NAME);
            environment.put("HOME", context.getFilesDir().getAbsolutePath());
            environment.put("TMPDIR", context.getCacheDir().getAbsolutePath());
            environment.put("XDG_CACHE_HOME", new File(context.getCacheDir(), "xdg").getAbsolutePath());
            environment.put("XDG_CONFIG_HOME", new File(context.getFilesDir(), "config").getAbsolutePath());
            environment.put("LD_PRELOAD", seccompCompat.getAbsolutePath());

            try {
                process = builder.start();
            } catch (IOException error) {
                process = null;
                throw new IOException("Unable to start bundled local server: " + error.getMessage(), error);
            }
            startLogReader(process);
        }

        try {
            waitUntilReady();
            return new ConnectionInfo(port, token);
        } catch (IOException error) {
            stop();
            String message = error.getMessage();
            boolean transientStartupFailure = message != null
                    && (message.startsWith("Timed out waiting for local server")
                    || message.startsWith("Local server stopped during startup"));
            if (allowRetry && transientStartupFailure) {
                Log.w(TAG, "Local server did not become ready; retrying once", error);
                try {
                    Thread.sleep(250L);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IOException("Interrupted before retrying local server", interrupted);
                }
                return start(false);
            }
            throw error;
        }
    }

    boolean isRunning() {
        Process current = process;
        return current != null && current.isAlive();
    }

    void stop() {
        synchronized (lock) {
            Process current = process;
            process = null;
            token = null;
            port = 0;
            if (current != null) {
                current.destroy();
                try {
                    if (!current.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) {
                        current.destroyForcibly();
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    current.destroyForcibly();
                }
            }
        }
    }

    private void waitUntilReady() throws IOException {
        long deadline = System.currentTimeMillis() + READY_TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            Process current = process;
            if (current == null || !current.isAlive()) {
                throw new IOException("Local server stopped during startup" + formattedOutput());
            }
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress("127.0.0.1", port), 250);
                return;
            } catch (IOException ignored) {
                try {
                    Thread.sleep(100L);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IOException("Interrupted while starting local server", interrupted);
                }
            }
        }
        throw new IOException("Timed out waiting for local server" + formattedOutput());
    }

    private void startLogReader(Process child) {
        Thread reader = new Thread(() -> {
            try (BufferedReader input = new BufferedReader(new InputStreamReader(child.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = input.readLine()) != null) {
                    appendOutput(line);
                    Log.i(TAG, line);
                }
            } catch (IOException error) {
                Log.d(TAG, "Server log reader stopped: " + error.getMessage());
            }
        }, "craft-agent-server-log");
        reader.setDaemon(true);
        reader.start();
    }

    private void prepareAssets(File target) throws IOException {
        AssetManager assets = context.getAssets();
        String version = readAsset("server/version.txt").trim();
        File marker = new File(target, ".version");
        File entry = new File(target, "server.js");
        File resources = new File(target, "resources");
        if (target.isDirectory() && marker.isFile() && entry.isFile() && resources.isDirectory()
                && version.equals(readFile(marker).trim())) return;

        File staging = new File(target.getParentFile(), target.getName() + ".staging");
        File backup = new File(target.getParentFile(), target.getName() + ".previous");
        deleteRecursively(staging);
        deleteRecursively(backup);
        if (!staging.mkdirs() && !staging.isDirectory()) {
            throw new IOException("Unable to create local server staging directory");
        }
        copyAssetTree(assets, ASSET_ROOT, staging);
        writeFile(new File(staging, ".version"), version);

        if (target.exists() && !target.renameTo(backup)) {
            deleteRecursively(staging);
            throw new IOException("Unable to replace the previous local server runtime");
        }
        if (!staging.renameTo(target)) {
            if (backup.exists()) backup.renameTo(target);
            throw new IOException("Unable to activate the local server runtime");
        }
        deleteRecursively(backup);
    }

    private void copyAssetTree(AssetManager assets, String assetPath, File target) throws IOException {
        String[] children = assets.list(assetPath);
        if (children != null && children.length > 0) {
            if (!target.exists() && !target.mkdirs()) throw new IOException("Unable to create " + target);
            for (String child : children) {
                copyAssetTree(assets, assetPath + "/" + child, new File(target, child));
            }
            return;
        }
        copyAsset(assetPath, target);
    }

    private void copyAsset(String assetPath, File target) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Unable to create " + parent);
        try (InputStream input = context.getAssets().open(assetPath);
             FileOutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        }
    }

    private String readAsset(String assetPath) throws IOException {
        try (InputStream input = context.getAssets().open(assetPath)) {
            byte[] bytes = new byte[4096];
            int count = input.read(bytes);
            return new String(bytes, 0, Math.max(0, count), StandardCharsets.UTF_8);
        }
    }

    private static String readFile(File file) throws IOException {
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) Math.min(file.length(), 4096L)];
            int count = input.read(bytes);
            return new String(bytes, 0, Math.max(0, count), StandardCharsets.UTF_8);
        }
    }

    private static void writeFile(File file, String value) throws IOException {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(value.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static void deleteRecursively(File file) throws IOException {
        if (!file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursively(child);
        }
        if (!file.delete() && file.exists()) throw new IOException("Unable to remove " + file);
    }

    private String generateToken() {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        return Base64.encodeToString(bytes, Base64.NO_WRAP | Base64.NO_PADDING | Base64.URL_SAFE);
    }

    private static int findAvailablePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            return socket.getLocalPort();
        }
    }

    private void appendOutput(String line) {
        synchronized (recentOutput) {
            if (recentOutput.length() > 0) recentOutput.append('\n');
            recentOutput.append(line);
            if (recentOutput.length() > OUTPUT_LIMIT) {
                recentOutput.delete(0, recentOutput.length() - OUTPUT_LIMIT);
            }
        }
    }

    private String formattedOutput() {
        synchronized (recentOutput) {
            return recentOutput.length() == 0 ? "" : ":\n" + recentOutput;
        }
    }
}
