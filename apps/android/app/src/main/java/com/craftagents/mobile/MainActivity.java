package com.craftagents.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.IOException;

public final class MainActivity extends Activity {
    private static final String PREFS = "craft_agent_mobile";
    private static final String SERVER_URL_KEY = "server_url";
    private static final String SERVER_TOKEN_KEY = "server_token";
    private SharedPreferences preferences;
    private WebView webView;
    private TextView serverLabel;
    private LocalWebServer localWebServer;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        preferences = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        buildUi();
        loadServerUrl(getSavedServerUrl());
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(16, 17, 20));

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(12), dp(4), dp(6), dp(4));
        toolbar.setBackgroundColor(Color.rgb(16, 17, 20));

        serverLabel = new TextView(this);
        serverLabel.setTextColor(Color.WHITE);
        serverLabel.setTextSize(14);
        serverLabel.setSingleLine(true);
        serverLabel.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        toolbar.addView(serverLabel, new LinearLayout.LayoutParams(0, dp(44), 1f));

        Button reload = toolbarButton(getString(R.string.reload));
        reload.setOnClickListener(view -> webView.reload());
        toolbar.addView(reload);

        Button server = toolbarButton(getString(R.string.change_server));
        server.setOnClickListener(view -> showServerDialog());
        toolbar.addView(server);

        root.addView(toolbar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(52)));

        webView = new WebView(this);
        configureWebView(webView);
        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
    }

    private Button toolbarButton(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(12);
        button.setTextColor(Color.WHITE);
        button.setAllCaps(false);
        button.setMinHeight(0);
        button.setMinWidth(0);
        button.setPadding(dp(8), 0, dp(8), 0);
        return button;
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setUserAgentString(settings.getUserAgentString() + " CraftAgentAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);
        view.setWebChromeClient(new WebChromeClient());
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) {
                    Toast.makeText(MainActivity.this, R.string.webview_error, Toast.LENGTH_LONG).show();
                }
            }
        });
    }

    private String getSavedServerUrl() {
        return preferences.getString(SERVER_URL_KEY, BuildConfig.SERVER_URL);
    }

    private void loadServerUrl(String rawUrl) {
        String url = normalizeUrl(rawUrl);
        if (url == null) {
            showServerDialog();
            return;
        }
        serverLabel.setText(url);
        try {
            String token = Uri.encode(getSavedServerToken());
            String pageUrl = "http://127.0.0.1:" + getLocalWebPort() + "/index.html?ws=" + Uri.encode(url) + "&token=" + token;
            webView.loadUrl(pageUrl);
        } catch (IOException error) {
            Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private int localWebPort = -1;

    private int getLocalWebPort() throws IOException {
        if (localWebServer == null) {
            localWebServer = new LocalWebServer(getAssets());
            localWebPort = localWebServer.start();
        }
        return localWebPort;
    }

    private void showServerDialog() {
        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint(R.string.server_url_hint);
        input.setText(getSavedServerUrl());
        input.setSelectAllOnFocus(true);

        final EditText tokenInput = new EditText(this);
        tokenInput.setSingleLine(true);
        tokenInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        tokenInput.setHint(R.string.server_token_hint);
        tokenInput.setText(getSavedServerToken());

        int padding = dp(24);
        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setPadding(padding, dp(8), padding, 0);
        container.addView(input, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        container.addView(tokenInput, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(R.string.change_server)
                .setView(container)
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(R.string.connect, null)
                .create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            String url = normalizeUrl(input.getText().toString());
            if (url == null) {
                input.setError(getString(R.string.server_url_invalid));
                return;
            }
            preferences.edit().putString(SERVER_URL_KEY, url).apply();
            preferences.edit().putString(SERVER_TOKEN_KEY, tokenInput.getText().toString().trim()).apply();
            dialog.dismiss();
            loadServerUrl(url);
        }));
        dialog.show();
    }

    private String normalizeUrl(String rawUrl) {
        if (rawUrl == null) return null;
        String value = rawUrl.trim();
        if (value.isEmpty()) return null;
        if (!value.startsWith("ws://") && !value.startsWith("wss://")) {
            value = "wss://" + value;
        }
        Uri uri = Uri.parse(value);
        if (uri.getHost() == null || (!"ws".equals(uri.getScheme()) && !"wss".equals(uri.getScheme()))) {
            return null;
        }
        return value;
    }

    private String getSavedServerToken() {
        return preferences.getString(SERVER_TOKEN_KEY, "");
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        if (localWebServer != null) localWebServer.stop();
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
