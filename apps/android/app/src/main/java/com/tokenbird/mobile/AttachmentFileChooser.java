package com.tokenbird.mobile;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebChromeClient;
import java.util.ArrayList;
import java.util.LinkedHashSet;

/** Use the system document provider for local and cloud-backed attachments. */
final class AttachmentFileChooser {
    private AttachmentFileChooser() {}

    static Intent createIntent(WebChromeClient.FileChooserParams params) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,
                params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE);
        ArrayList<String> types = new ArrayList<>();
        for (String accept : params.getAcceptTypes()) {
            if (accept == null) continue;
            for (String type : accept.split(",")) {
                type = type.trim();
                if (type.contains("/")) types.add(type);
            }
        }
        intent.setType(types.size() == 1 ? types.get(0) : "*/*");
        if (types.size() > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
        return intent;
    }

    static Uri[] parseResult(int resultCode, Intent data) {
        if (resultCode != Activity.RESULT_OK || data == null) return null;
        LinkedHashSet<Uri> uris = new LinkedHashSet<>();
        ClipData clips = data.getClipData();
        if (clips != null) {
            for (int i = 0; i < clips.getItemCount(); i++) {
                Uri uri = clips.getItemAt(i).getUri();
                if (uri != null) uris.add(uri);
            }
        }
        if (data.getData() != null) uris.add(data.getData());
        return uris.isEmpty() ? null : uris.toArray(new Uri[0]);
    }
}
