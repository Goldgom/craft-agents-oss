package com.tokenbird.mobile;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebChromeClient;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class AttachmentFileChooserTest {
    private WebChromeClient.FileChooserParams params(int mode, String... types) {
        return new WebChromeClient.FileChooserParams() {
            public int getMode() { return mode; }
            public String[] getAcceptTypes() { return types; }
            public boolean isCaptureEnabled() { return false; }
            public CharSequence getTitle() { return null; }
            public String getFilenameHint() { return null; }
            public Intent createIntent() { throw new AssertionError("Must use system document provider"); }
        };
    }

    @Test public void chatInputAllowsMultipleFilesWithoutMediaLibraryPermission() {
        Intent picker = AttachmentFileChooser.createIntent(params(WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE, ""));
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, picker.getAction());
        assertTrue(picker.hasCategory(Intent.CATEGORY_OPENABLE));
        assertEquals("*/*", picker.getType());
        assertTrue(picker.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false));
        assertNotEquals(0, picker.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }

    @Test public void preservesImageFilterAndSingleSelection() {
        Intent picker = AttachmentFileChooser.createIntent(params(WebChromeClient.FileChooserParams.MODE_OPEN, "image/*"));
        assertEquals("image/*", picker.getType());
        assertFalse(picker.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, true));
    }

    @Test public void preservesMultipleMimeTypes() {
        Intent picker = AttachmentFileChooser.createIntent(params(0, "image/png,image/jpeg", "application/pdf"));
        assertArrayEquals(new String[]{"image/png", "image/jpeg", "application/pdf"}, picker.getStringArrayExtra(Intent.EXTRA_MIME_TYPES));
    }

    @Test public void acceptsSingleImage() {
        Uri uri = Uri.parse("content://photos/1");
        assertArrayEquals(new Uri[]{uri}, AttachmentFileChooser.parseResult(Activity.RESULT_OK, new Intent().setData(uri)));
    }

    @Test public void acceptsMultipleImagesAndDeduplicatesDataUri() {
        Uri first = Uri.parse("content://photos/1"), second = Uri.parse("content://photos/2");
        ClipData clips = ClipData.newRawUri("photos", first);
        clips.addItem(new ClipData.Item(second));
        Intent result = new Intent().setData(first);
        result.setClipData(clips);
        assertArrayEquals(new Uri[]{first, second}, AttachmentFileChooser.parseResult(Activity.RESULT_OK, result));
    }

    @Test public void cancelAndEmptyResultsReturnNull() {
        assertNull(AttachmentFileChooser.parseResult(Activity.RESULT_CANCELED, new Intent().setData(Uri.parse("content://photos/1"))));
        assertNull(AttachmentFileChooser.parseResult(Activity.RESULT_OK, null));
        assertNull(AttachmentFileChooser.parseResult(Activity.RESULT_OK, new Intent()));
    }
}
