package com.craftagents.mobile;

import android.content.res.AssetManager;
import android.net.Uri;

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
    interface OAuthCallbackListener {
        void onCallback(String code, String state, String error, String errorDescription);
    }

    private static final byte[] OAUTH_CALLBACK_PAGE = ("<!doctype html><html lang=\"zh-CN\"><head>"
            + "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            + "<title>TokenBird</title><style>body{margin:0;background:#101114;color:#f4f5f7;"
            + "font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh}"
            + "main{max-width:30rem;margin:1.5rem;padding:2rem;border:1px solid #343842;border-radius:1rem;"
            + "background:#191b20;text-align:center}h1{font-size:1.3rem;margin:.5rem 0}p{color:#a4a9b4;line-height:1.6}"
            + ".mark{display:grid;place-items:center;width:3rem;height:3rem;margin:auto;border-radius:50%;"
            + "background:#6366f1;font-size:1.5rem}</style></head><body><main><div class=\"mark\">&#10003;</div>"
            + "<h1>授权信息已返回</h1><p>请返回词元鸟，应用将继续完成登录。<br>Return to TokenBird to finish signing in.</p>"
            + "</main></body></html>").getBytes(StandardCharsets.UTF_8);

    private final AssetManager assets;
    private final OAuthCallbackListener oauthCallbackListener;
    // A WebView can request hundreds of split JS/theme assets at once. Keep a
    // small bounded worker pool so low-memory devices do not create one thread
    // per request during the first render.
    private final ExecutorService clients = Executors.newFixedThreadPool(4);
    private volatile ServerSocket serverSocket;
    private volatile ConnectionConfig connectionConfig;

    private static final class ConnectionConfig {
        final String url;
        final String token;
        final String mode;

        ConnectionConfig(String url, String token, String mode) {
            this.url = url;
            this.token = token;
            this.mode = mode;
        }
    }

    LocalWebServer(AssetManager assets, OAuthCallbackListener oauthCallbackListener) {
        this.assets = assets;
        this.oauthCallbackListener = oauthCallbackListener;
    }

    int start() throws IOException {
        ServerSocket socket = new ServerSocket(0, 20, InetAddress.getByName("127.0.0.1"));
        serverSocket = socket;
        Thread acceptThread = new Thread(() -> acceptLoop(socket), "craft-agent-local-web");
        acceptThread.setDaemon(true);
        acceptThread.start();
        return socket.getLocalPort();
    }

    int getPort() throws IOException {
        ServerSocket socket = serverSocket;
        if (socket == null || socket.isClosed()) throw new IOException("Local web server is not running");
        return socket.getLocalPort();
    }

    void setConnectionConfig(String url, String token, String mode) {
        connectionConfig = new ConnectionConfig(url, token, mode);
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

            String requestTarget = parts[1];
            String path = requestTarget.split("\\?", 2)[0];
            path = URLDecoder.decode(path, "UTF-8");
            if (path.startsWith("/")) path = path.substring(1);
            if (path.isEmpty()) path = "index.html";
            if (path.contains("..") || path.startsWith("\\")) {
                writeResponse(output, 400, "text/plain; charset=utf-8", "Invalid path".getBytes(StandardCharsets.UTF_8), false);
                return;
            }

            if ("api/mobile-config".equals(path)) {
                ConnectionConfig config = connectionConfig;
                if (config == null) {
                    writeResponse(output, 503, "application/json; charset=utf-8",
                            "{\"error\":\"Server is not configured\"}".getBytes(StandardCharsets.UTF_8), false);
                    return;
                }
                String json = "{\"wsUrl\":\"" + escapeJson(config.url)
                        + "\",\"token\":\"" + escapeJson(config.token)
                        + "\",\"mode\":\"" + escapeJson(config.mode) + "\"}";
                writeResponse(output, 200, "application/json; charset=utf-8",
                        json.getBytes(StandardCharsets.UTF_8), "HEAD".equals(parts[0]));
                return;
            }

            // The OAuth loopback callback is a synthetic route, not a bundled
            // asset. Handle it before AssetManager lookup; otherwise the
            // missing "webui/callback" file returns 404 and the WebView never
            // receives the authorization result.
            if ("callback".equals(path)) {
                writeResponse(output, 200, "text/html; charset=utf-8", OAUTH_CALLBACK_PAGE,
                        "HEAD".equals(parts[0]));
                if (!"HEAD".equals(parts[0])) notifyOAuthCallback(requestTarget);
                return;
            }

            InputStream asset;
            try {
                asset = assets.open("webui/" + path);
            } catch (IOException missing) {
                writeResponse(output, 404, "text/plain; charset=utf-8", "Not Found".getBytes(StandardCharsets.UTF_8), false);
                return;
            }

            try (InputStream content = asset) {
                writeAssetResponse(
                        output,
                        contentType(path),
                        content,
                        "HEAD".equals(parts[0]),
                        path.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
            }
        } catch (IOException ignored) {
            // Client disconnects are normal during WebView reloads.
        }
    }

    private static void writeResponse(OutputStream output, int status, String type, byte[] body, boolean headOnly) throws IOException {
        String statusText = status == 200 ? "OK" : status == 404 ? "Not Found" : status == 405 ? "Method Not Allowed" : status == 503 ? "Service Unavailable" : "Bad Request";
        String cacheControl = type.startsWith("application/json") ? "no-store" : "no-cache";
        String headers = "HTTP/1.1 " + status + " " + statusText + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: " + cacheControl + "\r\n"
                + "X-Content-Type-Options: nosniff\r\n"
                + "Connection: close\r\n\r\n";
        output.write(headers.getBytes(StandardCharsets.UTF_8));
        if (!headOnly) output.write(body);
        output.flush();
    }

    private void notifyOAuthCallback(String requestTarget) {
        try {
            Uri callback = Uri.parse("http://127.0.0.1" + requestTarget);
            oauthCallbackListener.onCallback(
                    callback.getQueryParameter("code"),
                    callback.getQueryParameter("state"),
                    callback.getQueryParameter("error"),
                    callback.getQueryParameter("error_description"));
        } catch (RuntimeException ignored) {
            oauthCallbackListener.onCallback(null, null, "invalid_callback", "Invalid OAuth callback URL");
        }
    }

    private static void writeAssetResponse(
            OutputStream output,
            String type,
            InputStream asset,
            boolean headOnly,
            String cacheControl
    ) throws IOException {
        // Static files can be several megabytes. Stream them directly from the
        // APK instead of allocating an equally large byte[] for every request.
        // Connection-close framing is valid HTTP/1.1 when Content-Length is
        // unknown for a compressed AssetManager entry.
        String headers = "HTTP/1.1 200 OK\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Cache-Control: " + cacheControl + "\r\n"
                + "X-Content-Type-Options: nosniff\r\n"
                + "Connection: close\r\n\r\n";
        output.write(headers.getBytes(StandardCharsets.UTF_8));
        if (!headOnly) {
            byte[] buffer = new byte[32 * 1024];
            int count;
            while ((count = asset.read(buffer)) != -1) output.write(buffer, 0, count);
        }
        output.flush();
    }

    private static String escapeJson(String value) {
        if (value == null) return "";
        StringBuilder escaped = new StringBuilder(value.length() + 16);
        for (int i = 0; i < value.length(); i++) {
            char character = value.charAt(i);
            switch (character) {
                case '"': escaped.append("\\\""); break;
                case '\\': escaped.append("\\\\"); break;
                case '\b': escaped.append("\\b"); break;
                case '\f': escaped.append("\\f"); break;
                case '\n': escaped.append("\\n"); break;
                case '\r': escaped.append("\\r"); break;
                case '\t': escaped.append("\\t"); break;
                default:
                    if (character < 0x20) {
                        escaped.append(String.format(Locale.ROOT, "\\u%04x", (int) character));
                    } else {
                        escaped.append(character);
                    }
            }
        }
        return escaped.toString();
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
        // ByteArrayOutputStream.toString(Charset) was added in API 33. The
        // Android client still supports API 26, so decode explicitly instead
        // of allowing a request on an older device to throw NoSuchMethodError.
        return line.size() == 0 ? null : new String(line.toByteArray(), StandardCharsets.ISO_8859_1);
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
