package com.craftagents.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.IOException;
import java.util.EnumMap;
import java.util.Map;

public final class MainActivity extends Activity {
    private static final String PREFS = "craft_agent_mobile";
    private static final String MODE_KEY = "server_mode";
    private static final String LEGACY_SERVER_URL_KEY = "server_url";
    private static final String LEGACY_SERVER_TOKEN_KEY = "server_token";
    private static final String LOCAL_SERVER_URL_KEY = "local_server_url";
    private static final String LOCAL_SERVER_TOKEN_KEY = "local_server_token";
    private static final String REMOTE_SERVER_URL_KEY = "remote_server_url";
    private static final String REMOTE_SERVER_TOKEN_KEY = "remote_server_token";
    private static final String DEFAULT_LOCAL_SERVER_URL = "ws://127.0.0.1:9100";

    private enum ServerMode {
        LOCAL("local"),
        REMOTE("remote");

        private final String value;

        ServerMode(String value) {
            this.value = value;
        }

        static ServerMode fromPreference(String value) {
            if (LOCAL.value.equals(value)) return LOCAL;
            if (REMOTE.value.equals(value)) return REMOTE;
            return null;
        }
    }

    private static final class ServerProfile {
        final String url;
        final String token;

        ServerProfile(String url, String token) {
            this.url = url;
            this.token = token;
        }
    }

    private SharedPreferences preferences;
    private LinearLayout root;
    private FrameLayout content;
    private WebView webView;
    private LocalWebServer localWebServer;
    private ServerMode activeMode;
    private boolean showingServerConfiguration;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        enableImmersiveMode();
        preferences = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        migrateLegacyServerProfile();
        buildUi();

        ServerMode savedMode = ServerMode.fromPreference(preferences.getString(MODE_KEY, null));
        if (savedMode == null) {
            showServerConfiguration(false);
        } else {
            connect(savedMode);
        }
    }

    private void migrateLegacyServerProfile() {
        if (preferences.contains(MODE_KEY) || !preferences.contains(LEGACY_SERVER_URL_KEY)) return;

        preferences.edit()
                .putString(MODE_KEY, ServerMode.REMOTE.value)
                .putString(REMOTE_SERVER_URL_KEY, preferences.getString(LEGACY_SERVER_URL_KEY, BuildConfig.SERVER_URL))
                .putString(REMOTE_SERVER_TOKEN_KEY, preferences.getString(LEGACY_SERVER_TOKEN_KEY, ""))
                .apply();
    }

    private void buildUi() {
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(16, 17, 20));

        content = new FrameLayout(this);
        root.addView(content, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        webView = new WebView(this);
        configureWebView(webView);
        setContentView(root);
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
        view.addJavascriptInterface(new AndroidBridge(), "CraftAgentAndroid");
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

    private void showServerConfiguration(boolean allowCancel) {
        showingServerConfiguration = true;

        ServerMode initialMode = activeMode;
        if (initialMode == null) {
            initialMode = ServerMode.fromPreference(preferences.getString(MODE_KEY, null));
        }
        if (initialMode == null) initialMode = ServerMode.REMOTE;

        Map<ServerMode, ServerProfile> drafts = new EnumMap<>(ServerMode.class);
        drafts.put(ServerMode.LOCAL, getSavedProfile(ServerMode.LOCAL));
        drafts.put(ServerMode.REMOTE, getSavedProfile(ServerMode.REMOTE));

        ScrollView scrollView = new ScrollView(this);
        scrollView.setFillViewport(true);
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setGravity(Gravity.CENTER_HORIZONTAL);
        page.setPadding(dp(24), dp(40), dp(24), dp(32));
        scrollView.addView(page, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView title = textView(R.string.server_home_title, 24, Color.WHITE);
        title.setGravity(Gravity.CENTER);
        page.addView(title, matchWrap());

        TextView subtitle = textView(R.string.server_home_description, 14, Color.rgb(166, 170, 178));
        subtitle.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subtitleParams = matchWrap();
        subtitleParams.setMargins(0, dp(10), 0, dp(28));
        page.addView(subtitle, subtitleParams);

        RadioGroup modeGroup = new RadioGroup(this);
        modeGroup.setOrientation(RadioGroup.HORIZONTAL);
        modeGroup.setGravity(Gravity.CENTER);
        RadioButton local = serverModeButton(R.string.local_server);
        local.setId(View.generateViewId());
        RadioButton remote = serverModeButton(R.string.remote_server);
        remote.setId(View.generateViewId());
        modeGroup.addView(local, new RadioGroup.LayoutParams(0, dp(52), 1f));
        modeGroup.addView(remote, new RadioGroup.LayoutParams(0, dp(52), 1f));
        page.addView(modeGroup, matchWrap());

        TextView modeDescription = textView(0, 13, Color.rgb(148, 152, 160));
        LinearLayout.LayoutParams descriptionParams = matchWrap();
        descriptionParams.setMargins(0, dp(14), 0, dp(16));
        page.addView(modeDescription, descriptionParams);

        EditText urlInput = new EditText(this);
        urlInput.setSingleLine(true);
        urlInput.setTextColor(Color.WHITE);
        urlInput.setHintTextColor(Color.rgb(115, 118, 126));
        urlInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setHint(R.string.server_url_hint);
        page.addView(urlInput, matchWrap());

        EditText tokenInput = new EditText(this);
        tokenInput.setSingleLine(true);
        tokenInput.setTextColor(Color.WHITE);
        tokenInput.setHintTextColor(Color.rgb(115, 118, 126));
        tokenInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        tokenInput.setHint(R.string.server_token_hint);
        LinearLayout.LayoutParams tokenParams = matchWrap();
        tokenParams.setMargins(0, dp(10), 0, dp(24));
        page.addView(tokenInput, tokenParams);

        final ServerMode[] editingMode = { initialMode };
        final boolean[] changingMode = { false };
        Runnable renderProfile = () -> {
            changingMode[0] = true;
            ServerProfile profile = drafts.get(editingMode[0]);
            urlInput.setText(profile == null ? "" : profile.url);
            tokenInput.setText(profile == null ? "" : profile.token);
            modeDescription.setText(editingMode[0] == ServerMode.LOCAL
                    ? R.string.local_server_description
                    : R.string.remote_server_description);
            modeGroup.check(editingMode[0] == ServerMode.LOCAL ? local.getId() : remote.getId());
            changingMode[0] = false;
        };

        modeGroup.setOnCheckedChangeListener((group, checkedId) -> {
            if (changingMode[0]) return;
            drafts.put(editingMode[0], new ServerProfile(
                    urlInput.getText().toString(), tokenInput.getText().toString()));
            editingMode[0] = checkedId == local.getId() ? ServerMode.LOCAL : ServerMode.REMOTE;
            renderProfile.run();
        });
        renderProfile.run();

        Button connectButton = new Button(this);
        connectButton.setText(R.string.save_and_connect);
        connectButton.setAllCaps(false);
        connectButton.setTextSize(15);
        connectButton.setOnClickListener(view -> {
            ServerMode mode = editingMode[0];
            String normalizedUrl = normalizeUrl(urlInput.getText().toString(), mode);
            if (normalizedUrl == null) {
                urlInput.setError(getString(R.string.server_url_invalid));
                return;
            }

            drafts.put(mode, new ServerProfile(normalizedUrl, tokenInput.getText().toString().trim()));
            saveProfiles(drafts, mode);
            connect(mode);
        });
        page.addView(connectButton, matchWrap());

        if (allowCancel && activeMode != null) {
            Button cancelButton = new Button(this);
            cancelButton.setText(android.R.string.cancel);
            cancelButton.setAllCaps(false);
            cancelButton.setOnClickListener(view -> showWebView());
            LinearLayout.LayoutParams cancelParams = matchWrap();
            cancelParams.setMargins(0, dp(8), 0, 0);
            page.addView(cancelButton, cancelParams);
        }

        replaceContent(scrollView);
    }

    private RadioButton serverModeButton(int labelRes) {
        RadioButton button = new RadioButton(this);
        button.setText(labelRes);
        button.setTextColor(Color.WHITE);
        button.setTextSize(15);
        button.setGravity(Gravity.CENTER);
        button.setBackgroundColor(Color.rgb(36, 38, 44));
        return button;
    }

    private TextView textView(int textRes, int sizeSp, int color) {
        TextView view = new TextView(this);
        if (textRes != 0) view.setText(textRes);
        view.setTextSize(sizeSp);
        view.setTextColor(color);
        return view;
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private void saveProfiles(Map<ServerMode, ServerProfile> profiles, ServerMode selectedMode) {
        ServerProfile local = profiles.get(ServerMode.LOCAL);
        ServerProfile remote = profiles.get(ServerMode.REMOTE);
        SharedPreferences.Editor editor = preferences.edit().putString(MODE_KEY, selectedMode.value);
        if (local != null) {
            editor.putString(LOCAL_SERVER_URL_KEY, local.url.trim());
            editor.putString(LOCAL_SERVER_TOKEN_KEY, local.token.trim());
        }
        if (remote != null) {
            editor.putString(REMOTE_SERVER_URL_KEY, remote.url.trim());
            editor.putString(REMOTE_SERVER_TOKEN_KEY, remote.token.trim());
        }
        editor.apply();
    }

    private ServerProfile getSavedProfile(ServerMode mode) {
        if (mode == ServerMode.LOCAL) {
            return new ServerProfile(
                    preferences.getString(LOCAL_SERVER_URL_KEY, DEFAULT_LOCAL_SERVER_URL),
                    preferences.getString(LOCAL_SERVER_TOKEN_KEY, ""));
        }
        return new ServerProfile(
                preferences.getString(REMOTE_SERVER_URL_KEY, BuildConfig.SERVER_URL),
                preferences.getString(REMOTE_SERVER_TOKEN_KEY, ""));
    }

    private void connect(ServerMode mode) {
        ServerProfile profile = getSavedProfile(mode);
        String url = normalizeUrl(profile.url, mode);
        if (url == null) {
            showServerConfiguration(activeMode != null);
            return;
        }

        activeMode = mode;
        showingServerConfiguration = false;

        try {
            int port = getLocalWebPort();
            localWebServer.setConnectionConfig(url, profile.token, mode.value);
            showWebView();
            webView.loadUrl("http://127.0.0.1:" + port + "/index.html?embedded=android");
        } catch (IOException error) {
            Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void showWebView() {
        showingServerConfiguration = false;
        replaceContent(webView);
        enableImmersiveMode();
    }

    private void replaceContent(View view) {
        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) parent.removeView(view);
        content.removeAllViews();
        content.addView(view, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private int getLocalWebPort() throws IOException {
        if (localWebServer == null) {
            localWebServer = new LocalWebServer(getAssets());
            return localWebServer.start();
        }
        return localWebServer.getPort();
    }

    private String normalizeUrl(String rawUrl, ServerMode mode) {
        if (rawUrl == null) return null;
        String value = rawUrl.trim();
        if (value.isEmpty()) return null;
        if (!value.startsWith("ws://") && !value.startsWith("wss://")) {
            value = (mode == ServerMode.LOCAL ? "ws://" : "wss://") + value;
        }
        Uri uri = Uri.parse(value);
        if (uri.getHost() == null || (!("ws".equals(uri.getScheme())) && !("wss".equals(uri.getScheme())))) {
            return null;
        }
        return value;
    }

    @Override
    public void onBackPressed() {
        if (showingServerConfiguration && activeMode != null) {
            showWebView();
        } else if (!showingServerConfiguration && webView.canGoBack()) {
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

    @Override
    protected void onResume() {
        super.onResume();
        enableImmersiveMode();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && !showingServerConfiguration) enableImmersiveMode();
    }

    /**
     * Keep the chat surface edge-to-edge by default. Android still lets users
     * reveal the system bars temporarily with an edge swipe.
     */
    private void enableImmersiveMode() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    /** Methods intentionally limited to local app navigation, exposed to the bundled UI. */
    private final class AndroidBridge {
        @JavascriptInterface
        public void reload() {
            runOnUiThread(() -> webView.reload());
        }

        @JavascriptInterface
        public void configureServer() {
            runOnUiThread(() -> showServerConfiguration(true));
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
