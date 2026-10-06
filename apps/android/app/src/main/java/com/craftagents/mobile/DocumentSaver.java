package com.craftagents.mobile;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** Uses the Storage Access Framework; no broad storage permission is needed. */
final class DocumentSaver {
    static final int REQUEST_CODE = 2002;
    interface Result { void send(String id, boolean success, String error, String json); }
    private final Activity activity;
    private final Result result;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private String pendingId;
    private byte[] pendingBytes;

    DocumentSaver(Activity activity, Result result) { this.activity = activity; this.result = result; }

    void save(String id, String name, String mime, String base64) {
        worker.execute(() -> {
            try {
                if (base64 == null || base64.length() > 90_000_000) throw new IllegalArgumentException("文件超过 64 MB");
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                activity.runOnUiThread(() -> {
                    if (pendingId != null) { result.send(id, false, "请先完成当前文件保存", null); return; }
                    pendingId = id; pendingBytes = bytes;
                    try {
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        intent.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                        intent.putExtra(Intent.EXTRA_TITLE, (name == null ? "TokenBird-export" : name).replaceAll("[\\\\/\\p{Cntrl}]", "_"));
                        activity.startActivityForResult(intent, REQUEST_CODE);
                    } catch (Exception error) {
                        pendingId = null; pendingBytes = null;
                        result.send(id, false, error.getMessage(), null);
                    }
                });
            } catch (Exception error) { result.send(id, false, error.getMessage(), null); }
        });
    }

    void complete(int code, Intent data) {
        final String id = pendingId;
        final byte[] bytes = pendingBytes;
        pendingId = null; pendingBytes = null;
        if (id == null) return;
        if (code != Activity.RESULT_OK || data == null || data.getData() == null) {
            result.send(id, true, null, "{\"canceled\":true}"); return;
        }
        final Uri uri = data.getData();
        worker.execute(() -> {
            try (OutputStream stream = activity.getContentResolver().openOutputStream(uri, "wt")) {
                if (stream == null) throw new IllegalStateException("无法打开保存位置");
                stream.write(bytes); stream.flush();
                result.send(id, true, null, "{\"path\":" + JSONObject.quote(uri.toString()) + "}");
            } catch (Exception error) { result.send(id, false, error.getMessage(), null); }
        });
    }
    void close() { worker.shutdown(); pendingBytes = null; pendingId = null; }
}
