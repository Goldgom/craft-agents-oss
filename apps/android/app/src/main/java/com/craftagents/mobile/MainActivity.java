package com.craftagents.mobile;

import android.app.Activity;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
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
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONObject;

import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

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
    private static final int COLOR_BACKGROUND = Color.rgb(16, 17, 20);
    private static final int COLOR_SURFACE = Color.rgb(25, 27, 32);
    private static final int COLOR_SURFACE_ALT = Color.rgb(31, 34, 40);
    private static final int COLOR_BORDER = Color.rgb(52, 56, 66);
    private static final int COLOR_TEXT = Color.rgb(244, 245, 247);
    private static final int COLOR_MUTED = Color.rgb(164, 169, 180);
    private static final int COLOR_ACCENT = Color.rgb(99, 102, 241);
    private static final int FILE_CHOOSER_REQUEST_CODE = 2001;
    private static final String ANDROID_BACK_SCRIPT =
            "(function(){"
                    + "var guideOpen=!!document.querySelector('[data-getting-started-guide]');"
                    + "var handled=!window.dispatchEvent(new CustomEvent('craft-agent-android-back',{cancelable:true}));"
                    + "return guideOpen||handled;"
                    + "})()";
    private static final String TOKENNEST_OAUTH_CALLBACK_EVENT = "craft-agent:tokennest-oauth-callback";

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
    private LocalAgentServer localAgentServer;
    private final ExecutorService serverExecutor = Executors.newSingleThreadExecutor();
    private final AtomicInteger connectionAttempt = new AtomicInteger();
    private ServerMode activeMode;
    private boolean showingServerConfiguration;
    private boolean configurationAllowCancel;
    private ConfigurationPage configurationPage = ConfigurationPage.MODE_PICKER;
    private boolean backDispatchPending;
    private int imeBottomInset;
    private ValueCallback<Uri[]> pendingFileChooser;
    private OnBackInvokedCallback backInvokedCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        preferences = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        localAgentServer = new LocalAgentServer(this);
        migrateLegacyServerProfile();
        buildUi();
        registerBackHandler();

        // Always ask which mode should be used on a fresh launch. This avoids
        // trapping older devices in a remembered local-server startup failure.
        showServerConfiguration(false);
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
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(COLOR_BACKGROUND);

        content = new FrameLayout(this);
        root.addView(content, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        webView = new WebView(this);
        configureWebView(webView);
        setContentView(root);
        installImeResizeSupport();
    }

    /**
     * Some Android 15/OEM combinations keep an edge-to-edge WebView at its
     * full height even with SOFT_INPUT_ADJUST_RESIZE. Shrink the native WebView
     * by the authoritative IME inset so the browser viewport and composer are
     * never left underneath the keyboard. Older releases use the visible
     * display frame as the equivalent signal.
     */
    private void installImeResizeSupport() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                int bottom = insets.isVisible(WindowInsets.Type.ime())
                        ? insets.getInsets(WindowInsets.Type.ime()).bottom
                        : 0;
                updateWebViewImeInset(showingServerConfiguration ? 0 : bottom);
                return insets;
            });
            root.post(root::requestApplyInsets);
            return;
        }

        Rect visibleFrame = new Rect();
        root.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
            root.getWindowVisibleDisplayFrame(visibleFrame);
            int obscuredBottom = Math.max(0, root.getRootView().getHeight() - visibleFrame.bottom);
            int bottom = obscuredBottom > dp(120) ? obscuredBottom : 0;
            updateWebViewImeInset(showingServerConfiguration ? 0 : bottom);
        });
    }

    private void updateWebViewImeInset(int bottom) {
        imeBottomInset = Math.max(0, bottom);
        if (webView == null || webView.getParent() != content) return;
        ViewGroup.LayoutParams rawParams = webView.getLayoutParams();
        if (!(rawParams instanceof FrameLayout.LayoutParams)) return;
        FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) rawParams;
        if (params.bottomMargin == imeBottomInset) return;
        params.bottomMargin = imeBottomInset;
        webView.setLayoutParams(params);
    }

    private void dismissKeyboard() {
        View focused = getCurrentFocus();
        if (focused != null) focused.clearFocus();
        InputMethodManager inputMethodManager =
                (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (inputMethodManager != null && webView != null) {
            inputMethodManager.hideSoftInputFromWindow(webView.getWindowToken(), 0);
        }
    }

    private void configureWebView(WebView view) {
        // The app owns the full-screen surface; native WebView chrome and
        // overscroll glow only add visual noise on Android.
        view.setBackgroundColor(COLOR_BACKGROUND);
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);
        view.setVerticalScrollBarEnabled(false);
        view.setHorizontalScrollBarEnabled(false);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        // Android's Storage Access Framework returns content:// URIs for file
        // attachments. Keep direct file:// access disabled while allowing
        // those user-selected, permission-scoped content URIs.
        settings.setAllowContentAccess(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        // TokenBird supplies its own complete dark palette. Android WebView's
        // algorithmic darkening can otherwise process that palette a second
        // time and turn light text black on the already-dark surface.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            settings.setAlgorithmicDarkeningAllowed(false);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            settings.setForceDark(WebSettings.FORCE_DARK_OFF);
        }
        settings.setUserAgentString(settings.getUserAgentString() + " CraftAgentAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);
        view.addJavascriptInterface(new AndroidBridge(), "CraftAgentAndroid");
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView webView,
                    ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams
            ) {
                if (pendingFileChooser != null) {
                    pendingFileChooser.onReceiveValue(null);
                }
                pendingFileChooser = filePathCallback;

                try {
                    Intent picker = fileChooserParams.createIntent();
                    picker.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(picker, FILE_CHOOSER_REQUEST_CODE);
                    return true;
                } catch (ActivityNotFoundException | SecurityException error) {
                    pendingFileChooser.onReceiveValue(null);
                    pendingFileChooser = null;
                    Toast.makeText(MainActivity.this, R.string.file_picker_unavailable, Toast.LENGTH_LONG).show();
                    return true;
                }
            }
        });
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                if (!request.isForMainFrame() || isBundledWebUri(request.getUrl())) return false;
                openExternalUri(request.getUrl());
                return true;
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
        boolean cancelPendingLocalStart = configurationPage == ConfigurationPage.CONNECTING
                && activeMode != ServerMode.LOCAL;
        showingServerConfiguration = true;
        configurationAllowCancel = allowCancel;
        configurationPage = ConfigurationPage.MODE_PICKER;
        showSystemBars();
        connectionAttempt.incrementAndGet();
        if (cancelPendingLocalStart) serverExecutor.execute(localAgentServer::stop);

        ServerMode savedMode = ServerMode.fromPreference(preferences.getString(MODE_KEY, null));
        LinearLayout page = createConfigurationPage(
                R.string.server_home_title,
                R.string.server_home_description);

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.ic_launcher);
        logo.setScaleType(ImageView.ScaleType.CENTER_CROP);
        LinearLayout.LayoutParams logoParams = new LinearLayout.LayoutParams(dp(76), dp(76));
        logoParams.gravity = Gravity.CENTER_HORIZONTAL;
        logoParams.setMargins(0, 0, 0, dp(24));
        page.addView(logo, 0, logoParams);

        boolean localAvailable = LocalAgentServer.isSupportedOnThisDevice();
        View localCard = createModeCard(
                R.string.local_server,
                localAvailable ? R.string.local_server_description : R.string.local_server_unsupported,
                R.string.local_mode_badge,
                savedMode == ServerMode.LOCAL,
                localAvailable);
        localCard.setOnClickListener(view -> {
            if (!LocalAgentServer.isSupportedOnThisDevice()) {
                Toast.makeText(this, R.string.local_server_unsupported, Toast.LENGTH_LONG).show();
                return;
            }
            preferences.edit().putString(MODE_KEY, ServerMode.LOCAL.value).apply();
            connect(ServerMode.LOCAL);
        });
        page.addView(localCard, cardParams());

        View remoteCard = createModeCard(
                R.string.remote_server,
                R.string.remote_server_description,
                R.string.remote_mode_badge,
                savedMode == ServerMode.REMOTE,
                true);
        remoteCard.setOnClickListener(view -> showRemoteServerForm());
        page.addView(remoteCard, cardParams());

        TextView privacy = textView(R.string.connection_privacy_note, 12, COLOR_MUTED);
        privacy.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams privacyParams = matchWrap();
        privacyParams.setMargins(dp(10), dp(10), dp(10), 0);
        page.addView(privacy, privacyParams);

        if (allowCancel && activeMode != null) {
            Button cancel = secondaryButton(android.R.string.cancel);
            cancel.setOnClickListener(view -> showWebView());
            LinearLayout.LayoutParams cancelParams = matchWrap();
            cancelParams.setMargins(0, dp(18), 0, 0);
            page.addView(cancel, cancelParams);
        }

        showConfigurationPage(page);
    }

    private void showRemoteServerForm() {
        showingServerConfiguration = true;
        configurationPage = ConfigurationPage.REMOTE_FORM;
        showSystemBars();

        LinearLayout page = createConfigurationPage(
                R.string.remote_form_title,
                R.string.remote_form_description);
        ServerProfile profile = getSavedProfile(ServerMode.REMOTE);

        TextView urlLabel = fieldLabel(R.string.server_url_label);
        page.addView(urlLabel, matchWrap());
        EditText urlInput = createTextInput(
                R.string.server_url_hint,
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setText(profile.url);
        page.addView(urlInput, fieldParams(dp(8), dp(18)));

        TextView tokenLabel = fieldLabel(R.string.server_token_label);
        page.addView(tokenLabel, matchWrap());
        EditText tokenInput = createTextInput(
                R.string.server_token_hint,
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        tokenInput.setText(profile.token);
        page.addView(tokenInput, fieldParams(dp(8), dp(24)));

        Button connectButton = primaryButton(R.string.save_and_connect);
        connectButton.setOnClickListener(view -> {
            String normalizedUrl = normalizeUrl(urlInput.getText().toString(), ServerMode.REMOTE);
            if (normalizedUrl == null) {
                urlInput.setError(getString(R.string.server_url_invalid));
                urlInput.requestFocus();
                return;
            }
            preferences.edit()
                    .putString(MODE_KEY, ServerMode.REMOTE.value)
                    .putString(REMOTE_SERVER_URL_KEY, normalizedUrl)
                    .putString(REMOTE_SERVER_TOKEN_KEY, tokenInput.getText().toString().trim())
                    .apply();
            connect(ServerMode.REMOTE);
        });
        page.addView(connectButton, matchWrap());

        Button back = secondaryButton(R.string.back_to_mode_selection);
        back.setOnClickListener(view -> showServerConfiguration(configurationAllowCancel));
        LinearLayout.LayoutParams backParams = matchWrap();
        backParams.setMargins(0, dp(10), 0, 0);
        page.addView(back, backParams);

        showConfigurationPage(page);
        urlInput.post(() -> {
            urlInput.requestFocus();
            urlInput.setSelection(urlInput.length());
        });
    }

    private LinearLayout createConfigurationPage(int titleRes, int descriptionRes) {
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setGravity(Gravity.CENTER_HORIZONTAL);
        page.setPadding(dp(24), dp(44), dp(24), dp(32));
        applyServerPageInsets(page);

        TextView title = textView(titleRes, 27, COLOR_TEXT);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        page.addView(title, matchWrap());

        TextView subtitle = textView(descriptionRes, 14, COLOR_MUTED);
        subtitle.setGravity(Gravity.CENTER);
        subtitle.setLineSpacing(0f, 1.12f);
        LinearLayout.LayoutParams subtitleParams = matchWrap();
        subtitleParams.setMargins(0, dp(10), 0, dp(28));
        page.addView(subtitle, subtitleParams);
        return page;
    }

    private void showConfigurationPage(LinearLayout page) {
        ScrollView scrollView = new ScrollView(this);
        scrollView.setFillViewport(true);
        scrollView.setClipToPadding(false);
        scrollView.setBackgroundColor(COLOR_BACKGROUND);
        scrollView.addView(page, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        replaceContent(scrollView);
    }

    private View createModeCard(
            int titleRes,
            int descriptionRes,
            int badgeRes,
            boolean preferred,
            boolean available
    ) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(18), dp(17), dp(18), dp(17));
        card.setClickable(true);
        card.setFocusable(true);
        card.setAlpha(available ? 1f : 0.58f);
        card.setBackground(roundedBackground(COLOR_SURFACE, preferred ? COLOR_ACCENT : COLOR_BORDER, 16, preferred ? 2 : 1));

        LinearLayout heading = new LinearLayout(this);
        heading.setOrientation(LinearLayout.HORIZONTAL);
        heading.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = textView(titleRes, 17, COLOR_TEXT);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        heading.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView badge = textView(badgeRes, 11, preferred ? Color.WHITE : COLOR_MUTED);
        badge.setGravity(Gravity.CENTER);
        badge.setPadding(dp(9), dp(5), dp(9), dp(5));
        badge.setBackground(roundedBackground(preferred ? COLOR_ACCENT : COLOR_SURFACE_ALT, Color.TRANSPARENT, 12, 0));
        heading.addView(badge);
        card.addView(heading, matchWrap());

        TextView description = textView(descriptionRes, 13, COLOR_MUTED);
        description.setLineSpacing(0f, 1.12f);
        LinearLayout.LayoutParams descriptionParams = matchWrap();
        descriptionParams.setMargins(0, dp(9), 0, 0);
        card.addView(description, descriptionParams);
        return card;
    }

    private EditText createTextInput(int hintRes, int inputType) {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setTextColor(COLOR_TEXT);
        input.setTextSize(16);
        input.setHintTextColor(Color.rgb(112, 117, 128));
        input.setInputType(inputType);
        input.setHint(hintRes);
        input.setPadding(dp(15), 0, dp(15), 0);
        input.setMinHeight(dp(54));
        input.setBackground(roundedBackground(COLOR_SURFACE, COLOR_BORDER, 13, 1));
        return input;
    }

    private TextView fieldLabel(int labelRes) {
        TextView label = textView(labelRes, 13, COLOR_MUTED);
        label.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return label;
    }

    private Button primaryButton(int labelRes) {
        Button button = new Button(this);
        button.setText(labelRes);
        button.setAllCaps(false);
        button.setTextSize(16);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setTextColor(Color.WHITE);
        button.setMinHeight(dp(54));
        button.setBackground(roundedBackground(COLOR_ACCENT, Color.TRANSPARENT, 14, 0));
        return button;
    }

    private Button secondaryButton(int labelRes) {
        Button button = new Button(this);
        button.setText(labelRes);
        button.setAllCaps(false);
        button.setTextSize(14);
        button.setTextColor(COLOR_MUTED);
        button.setMinHeight(dp(48));
        button.setBackground(roundedBackground(Color.TRANSPARENT, Color.TRANSPARENT, 12, 0));
        return button;
    }

    private GradientDrawable roundedBackground(int fill, int stroke, int radiusDp, int strokeDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(radiusDp));
        if (strokeDp > 0) drawable.setStroke(dp(strokeDp), stroke);
        return drawable;
    }

    private LinearLayout.LayoutParams cardParams() {
        LinearLayout.LayoutParams params = matchWrap();
        params.setMargins(0, 0, 0, dp(14));
        return params;
    }

    private LinearLayout.LayoutParams fieldParams(int top, int bottom) {
        LinearLayout.LayoutParams params = matchWrap();
        params.setMargins(0, top, 0, bottom);
        return params;
    }

    private void showConnectionProgress() {
        showingServerConfiguration = true;
        configurationPage = ConfigurationPage.CONNECTING;
        showSystemBars();
        LinearLayout page = createConfigurationPage(
                R.string.preparing_local_server,
                R.string.preparing_local_server_description);

        ProgressBar progress = new ProgressBar(this);
        progress.setIndeterminateTintList(ColorStateList.valueOf(COLOR_ACCENT));
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(dp(48), dp(48));
        progressParams.gravity = Gravity.CENTER_HORIZONTAL;
        progressParams.setMargins(0, dp(14), 0, dp(30));
        page.addView(progress, progressParams);

        Button changeMode = secondaryButton(R.string.choose_another_mode);
        changeMode.setOnClickListener(view -> showServerConfiguration(configurationAllowCancel));
        page.addView(changeMode, matchWrap());
        showConfigurationPage(page);
    }

    private void showConnectionError(String details) {
        showingServerConfiguration = true;
        configurationPage = ConfigurationPage.ERROR;
        showSystemBars();
        LinearLayout page = createConfigurationPage(
                R.string.local_server_failed,
                R.string.local_server_failed_description);

        TextView error = textView(0, 12, Color.rgb(229, 156, 156));
        error.setText(details);
        error.setTextIsSelectable(true);
        error.setPadding(dp(14), dp(12), dp(14), dp(12));
        error.setBackground(roundedBackground(Color.rgb(48, 28, 31), Color.rgb(101, 53, 59), 12, 1));
        LinearLayout.LayoutParams errorParams = matchWrap();
        errorParams.setMargins(0, 0, 0, dp(22));
        page.addView(error, errorParams);

        Button retry = primaryButton(R.string.retry_local_server);
        retry.setOnClickListener(view -> connect(ServerMode.LOCAL));
        page.addView(retry, matchWrap());
        Button chooseMode = secondaryButton(R.string.choose_another_mode);
        chooseMode.setOnClickListener(view -> showServerConfiguration(configurationAllowCancel));
        LinearLayout.LayoutParams chooseParams = matchWrap();
        chooseParams.setMargins(0, dp(8), 0, 0);
        page.addView(chooseMode, chooseParams);
        showConfigurationPage(page);
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
        if (mode == ServerMode.LOCAL) {
            connectLocalServer();
            return;
        }

        connectionAttempt.incrementAndGet();
        if (localAgentServer != null && localAgentServer.isRunning()) {
            serverExecutor.execute(localAgentServer::stop);
        }
        ServerProfile profile = getSavedProfile(mode);
        String url = normalizeUrl(profile.url, mode);
        if (url == null) {
            showRemoteServerForm();
            return;
        }

        try {
            int port = getLocalWebPort();
            localWebServer.setConnectionConfig(url, profile.token, mode.value);
            activeMode = mode;
            showWebView();
            webView.loadUrl("http://127.0.0.1:" + port + "/index.html?embedded=android");
        } catch (IOException error) {
            Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show();
            showRemoteServerForm();
        }
    }

    private enum ConfigurationPage {
        MODE_PICKER,
        REMOTE_FORM,
        CONNECTING,
        ERROR
    }

    /** Start the bundled Bun backend before opening the WebView. */
    private void connectLocalServer() {
        if (!LocalAgentServer.isSupportedOnThisDevice()) {
            Toast.makeText(this, R.string.local_server_unsupported, Toast.LENGTH_LONG).show();
            showServerConfiguration(configurationAllowCancel);
            return;
        }

        int attempt = connectionAttempt.incrementAndGet();
        showConnectionProgress();

        serverExecutor.execute(() -> {
            try {
                LocalAgentServer.ConnectionInfo connection = localAgentServer.start();
                runOnUiThread(() -> {
                    if (isFinishing() || attempt != connectionAttempt.get()) return;
                    try {
                        int webPort = getLocalWebPort();
                        localWebServer.setConnectionConfig(
                                "ws://127.0.0.1:" + connection.port,
                                connection.token,
                                ServerMode.LOCAL.value);
                        preferences.edit()
                                .putString(MODE_KEY, ServerMode.LOCAL.value)
                                .putString(LOCAL_SERVER_URL_KEY, "ws://127.0.0.1:" + connection.port)
                                .apply();
                        activeMode = ServerMode.LOCAL;
                        showWebView();
                        webView.loadUrl("http://127.0.0.1:" + webPort + "/index.html?embedded=android");
                    } catch (IOException error) {
                        showConnectionError(error.getMessage());
                    }
                });
            } catch (IOException error) {
                runOnUiThread(() -> {
                    if (isFinishing() || attempt != connectionAttempt.get()) return;
                    showConnectionError(error.getMessage());
                });
            }
        });
    }

    private void showWebView() {
        showingServerConfiguration = false;
        replaceContent(webView);
        updateWebViewImeInset(imeBottomInset);
        enableImmersiveMode();
    }

    /** Keep the native configuration screen clear of cutouts and system bars. */
    private void applyServerPageInsets(View page) {
        final int horizontalPadding = dp(24);
        final int topPadding = dp(40);
        final int bottomPadding = dp(32);
        page.setOnApplyWindowInsetsListener((view, windowInsets) -> {
            int left;
            int top;
            int right;
            int bottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Insets insets = windowInsets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                left = insets.left;
                top = insets.top;
                right = insets.right;
                bottom = insets.bottom;
            } else {
                left = windowInsets.getSystemWindowInsetLeft();
                top = windowInsets.getSystemWindowInsetTop();
                right = windowInsets.getSystemWindowInsetRight();
                bottom = windowInsets.getSystemWindowInsetBottom();
            }
            view.setPadding(
                    horizontalPadding + left,
                    topPadding + top,
                    horizontalPadding + right,
                    bottomPadding + bottom);
            return windowInsets;
        });
        page.post(page::requestApplyInsets);
    }

    private boolean isBundledWebUri(Uri uri) {
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if ("about".equalsIgnoreCase(scheme)) return true;
        return "http".equalsIgnoreCase(scheme)
                && ("127.0.0.1".equals(host) || "localhost".equalsIgnoreCase(host));
    }

    private void openExternalUri(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            startActivity(intent);
        } catch (ActivityNotFoundException | SecurityException error) {
            Toast.makeText(this, R.string.external_link_unavailable, Toast.LENGTH_LONG).show();
        }
    }

    private void dispatchTokenNestOAuthCallback(
            String code,
            String state,
            String error,
            String errorDescription
    ) {
        String detail = "{\"code\":" + jsonStringOrNull(code)
                + ",\"state\":" + jsonStringOrNull(state)
                + ",\"error\":" + jsonStringOrNull(error)
                + ",\"error_description\":" + jsonStringOrNull(errorDescription) + "}";
        String script = "window.dispatchEvent(new CustomEvent("
                + JSONObject.quote(TOKENNEST_OAUTH_CALLBACK_EVENT)
                + ",{detail:" + detail + "}));";
        runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(script, null);
        });
    }

    private static String jsonStringOrNull(String value) {
        return value == null ? "null" : JSONObject.quote(value);
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
            localWebServer = new LocalWebServer(getAssets(), this::dispatchTokenNestOAuthCallback);
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

    private void registerBackHandler() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            backInvokedCallback = this::handleBackPressed;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    backInvokedCallback);
        }
    }

    private void handleBackPressed() {
        if (showingServerConfiguration) {
            if (configurationPage != ConfigurationPage.MODE_PICKER) {
                showServerConfiguration(configurationAllowCancel);
            } else if (activeMode != null) {
                showWebView();
            } else {
                super.onBackPressed();
            }
            return;
        }

        if (backDispatchPending) return;

        // Give Android-only React overlays the first chance to consume Back.
        // If nothing handles it, continue through WebView/browser history.
        backDispatchPending = true;
        webView.evaluateJavascript(ANDROID_BACK_SCRIPT, consumed -> {
            backDispatchPending = false;
            if ("true".equals(consumed)) return;
            navigateWebViewBackOrFinish();
        });
    }

    @Override
    @SuppressLint("GestureBackNavigation")
    public void onBackPressed() {
        handleBackPressed();
    }

    @SuppressLint("GestureBackNavigation")
    private void navigateWebViewBackOrFinish() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            ValueCallback<Uri[]> callback = pendingFileChooser;
            pendingFileChooser = null;
            if (callback != null) {
                callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        connectionAttempt.incrementAndGet();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && backInvokedCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backInvokedCallback);
            backInvokedCallback = null;
        }
        if (pendingFileChooser != null) {
            pendingFileChooser.onReceiveValue(null);
            pendingFileChooser = null;
        }
        serverExecutor.shutdownNow();
        if (localAgentServer != null) localAgentServer.stop();
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
        if (showingServerConfiguration) {
            showSystemBars();
        } else {
            enableImmersiveMode();
        }
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
            window.setDecorFitsSystemWindows(false);
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

    private void showSystemBars() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(true);
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
            }
        } else {
            window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
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
            runOnUiThread(() -> {
                dismissKeyboard();
                showServerConfiguration(true);
            });
        }

        @JavascriptInterface
        public void dismissKeyboard() {
            runOnUiThread(MainActivity.this::dismissKeyboard);
        }

        /** The TokenNest native OAuth client is registered for an IP-literal loopback callback. */
        @JavascriptInterface
        public String getOAuthCallbackUrl() {
            try {
                return "http://127.0.0.1:" + getLocalWebPort() + "/callback";
            } catch (IOException error) {
                return "";
            }
        }

        /** Open only the fixed TokenNest authorization endpoint in the system browser. */
        @JavascriptInterface
        public void openTokenNestOAuth(String rawUrl) {
            Uri uri = Uri.parse(rawUrl == null ? "" : rawUrl);
            boolean allowed = "https".equalsIgnoreCase(uri.getScheme())
                    && "openai.goldgom.top".equalsIgnoreCase(uri.getHost())
                    && "/oauth/authorize".equals(uri.getPath());
            if (!allowed) {
                dispatchTokenNestOAuthCallback(
                        null, null, "invalid_authorization_url", "TokenNest authorization URL was rejected");
                return;
            }
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException | SecurityException failure) {
                    Toast.makeText(MainActivity.this, R.string.external_link_unavailable, Toast.LENGTH_LONG).show();
                    dispatchTokenNestOAuthCallback(
                            null, null, "browser_unavailable", "No browser is available to open TokenNest");
                }
            });
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
