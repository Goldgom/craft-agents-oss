package com.craftagents.mobile;

import android.content.res.AssetManager;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Serves the bundled web UI on loopback so the WebView has a normal HTTP origin. */
final class LocalWebServer {
    private final AssetManager assets;
    private final ExecutorService clients = Executors.newCachedThreadPool();
    private volatile ServerSocket serverSocket;

    LocalWebServer(AssetManager assets) {
        this.assets = assets;
    }

    int start() throws IOException {
        ServerSocket socket = new ServerSocket(0, 20, InetAddress.getByName("127.0.0.1"));
        serverSocket = socket;
        Thread acceptThread = new Thread(() -> acceptLoop(socket), "craft-agent-local-web");
        acceptThread.setDaemon(true);
        acceptThread.start();
        return socket.getLocalPort();
    }

    void stop() {
        ServerSocket socket = serverSocket;
        serverSocket = null;
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException ignored) {
                // The accept loop is stopping.
            }
        }
        clients.shutdownNow();
    }

    private void acceptLoop(ServerSocket socket) {
        while (!socket.isClosed()) {
            try {
                Socket client = socket.accept();
                clients.execute(() -> serve(client));
            } catch (SocketException ignored) {
                return;
            } catch (IOException ignored) {
                if (socket.isClosed()) return;
            }
        }
    }

    private void serve(Socket client) {
        try (Socket socket = client;
             BufferedInputStream input = new BufferedInputStream(socket.getInputStream());
             BufferedOutputStream output = new BufferedOutputStream(socket.getOutputStream())) {
            String requestLine = readLine(input);
            if (requestLine == null || requestLine.isEmpty()) return;
            while (true) {
                String header = readLine(input);
                if (header == null || header.isEmpty()) break;
            }

            String[] parts = requestLine.split(" ");
            if (parts.length < 2 || !("GET".equals(parts[0]) || "HEAD".equals(parts[0]))) {
                writeResponse(output, 405, "text/plain; charset=utf-8", "Method Not Allowed".getBytes(StandardCharsets.UTF_8), false);
                return;
            }

            String path = parts[1].split("\\?", 2)[0];
            path = URLDecoder.decode(path, "UTF-8");
            if (path.startsWith("/")) path = path.substring(1);
            if (path.isEmpty()) path = "index.html";
            if (path.contains("..") || path.startsWith("\\")) {
                writeResponse(output, 400, "text/plain; charset=utf-8", "Invalid path".getBytes(StandardCharsets.UTF_8), false);
                return;
            }

            byte[] content;
            String contentType;
            try (InputStream asset = assets.open("webui/" + path)) {
                content = readAll(asset);
                contentType = contentType(path);
            } catch (IOException missing) {
                writeResponse(output, 404, "text/plain; charset=utf-8", "Not Found".getBytes(StandardCharsets.UTF_8), false);
                return;
            }
            writeResponse(output, 200, contentType, content, "HEAD".equals(parts[0]));
        } catch (IOException ignored) {
            // Client disconnects are normal during WebView reloads.
        }
    }

    private static void writeResponse(OutputStream output, int status, String type, byte[] body, boolean headOnly) throws IOException {
        String statusText = status == 200 ? "OK" : status == 404 ? "Not Found" : status == 405 ? "Method Not Allowed" : "Bad Request";
        String headers = "HTTP/1.1 " + status + " " + statusText + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-cache\r\n"
                + "Connection: close\r\n\r\n";
        output.write(headers.getBytes(StandardCharsets.UTF_8));
        if (!headOnly) output.write(body);
        output.flush();
    }

    private static String readLine(InputStream input) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int previous = -1;
        int current;
        while ((current = input.read()) != -1) {
            if (previous == '\r' && current == '\n') {
                byte[] bytes = line.toByteArray();
                return new String(bytes, 0, Math.max(0, bytes.length - 1), StandardCharsets.ISO_8859_1);
            }
            line.write(current);
            previous = current;
        }
        return line.size() == 0 ? null : line.toString(StandardCharsets.ISO_8859_1);
    }

    private static byte[] readAll(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16 * 1024];
        int count;
        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        return output.toByteArray();
    }

    private static String contentType(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html")) return "text/html; charset=utf-8";
        if (lower.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (lower.endsWith(".css")) return "text/css; charset=utf-8";
        if (lower.endsWith(".json")) return "application/json; charset=utf-8";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        return "application/octet-stream";
    }
}
