package com.craftagents.mobile;

import android.content.Context;
import android.content.res.AssetManager;
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
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Map;

/**
 * Owns the Bun-powered Craft Agent backend bundled in the APK.
 *
 * Android only ships the aarch64 Bun runtime. Gradle places it in the
 * extracted native library directory, while the JavaScript bundle and its
 * resources are copied from APK assets into the app-private files directory.
 */
final class LocalAgentServer {
    private static final String TAG = "CraftAgentServer";
    private static final int RPC_PORT = 9100;
    private static final long READY_TIMEOUT_MS = 30_000L;
    private static final String ASSET_ROOT = "server";

    private final Context context;
    private final SecureRandom random = new SecureRandom();
    private final Object lock = new Object();
    private Process process;
    private File serverRoot;
    private String token;
    private volatile String lastOutput = "";

    LocalAgentServer(Context context) {
        this.context = context.getApplicationContext();
    }

    String start() throws IOException {
        synchronized (lock) {
            if (process != null && process.isAlive()) return token;

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

            token = generateToken();
            File entry = new File(serverRoot, "server.js");
            if (!entry.isFile()) throw new IOException("Bundled local server entrypoint is missing");

            ProcessBuilder builder = new ProcessBuilder(bun.getAbsolutePath(), entry.getAbsolutePath());
            builder.directory(serverRoot);
            builder.redirectErrorStream(true);
            Map<String, String> environment = builder.environment();
            environment.put("CRAFT_SERVER_TOKEN", token);
            environment.put("CRAFT_RPC_HOST", "127.0.0.1");
            environment.put("CRAFT_RPC_PORT", Integer.toString(RPC_PORT));
            environment.put("CRAFT_APP_ROOT", serverRoot.getAbsolutePath());
            environment.put("CRAFT_BUNDLED_ASSETS_ROOT", serverRoot.getAbsolutePath());
            environment.put("CRAFT_RESOURCES_PATH", new File(serverRoot, "resources").getAbsolutePath());
            environment.put("CRAFT_IS_PACKAGED", "true");
            environment.put("CRAFT_ANDROID", "true");
            environment.put("CRAFT_DISABLE_MESSAGING", "true");
            environment.put("CRAFT_VERSION", BuildConfig.VERSION_NAME);
            environment.put("HOME", context.getFilesDir().getAbsolutePath());

            try {
                process = builder.start();
            } catch (IOException error) {
                process = null;
                throw new IOException("Unable to start bundled local server: " + error.getMessage(), error);
            }
            startLogReader(process);
        }

        waitUntilReady();
        return token;
    }

    boolean isRunning() {
        Process current = process;
        return current != null && current.isAlive();
    }

    void stop() {
        synchronized (lock) {
            Process current = process;
            process = null;
            if (current == null) return;
            current.destroy();
            try {
                if (!current.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) {
                    current.destroy();
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private void waitUntilReady() throws IOException {
        long deadline = System.currentTimeMillis() + READY_TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            Process current = process;
            if (current == null || !current.isAlive()) {
                throw new IOException("Local server stopped during startup: " + lastOutput);
            }
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress("127.0.0.1", RPC_PORT), 250);
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
        throw new IOException("Timed out waiting for local server" + (lastOutput.isEmpty() ? "" : ": " + lastOutput));
    }

    private void startLogReader(Process child) {
        Thread reader = new Thread(() -> {
            try (BufferedReader input = new BufferedReader(new InputStreamReader(child.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = input.readLine()) != null) {
                    lastOutput = line;
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
        if (target.isDirectory() && marker.isFile() && version.equals(readFile(marker).trim())) return;

        deleteRecursively(target);
        if (!target.mkdirs() && !target.isDirectory()) throw new IOException("Unable to create local server directory");
        copyAssetTree(assets, ASSET_ROOT, target);
        writeFile(marker, version);
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
            byte[] buffer = new byte[32 * 1024];
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
}
