package com.tatarhost.cheatlab;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.view.Gravity;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.PermissionRequest;
import android.webkit.SafeBrowsingResponse;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    private static final String HOME = "https://cheatlab.fun/";
    private static final int FILE_CHOOSER_REQUEST = 4101;
    private static final int MEDIA_PERMISSION_REQUEST = 4102;

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermissionRequest;
    private String[] pendingAndroidPermissions = new String[0];
    private LinearLayout root;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(10, 10, 10));
        getWindow().setNavigationBarColor(Color.rgb(10, 10, 10));

        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(10, 10, 10));

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(18), 0, dp(10), 0);
        toolbar.setBackgroundColor(Color.rgb(10, 10, 10));
        TextView brand = new TextView(this);
        brand.setText("CHEATLAB");
        brand.setTextColor(Color.WHITE);
        brand.setTextSize(17);
        brand.setTypeface(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD);
        toolbar.addView(brand, new LinearLayout.LayoutParams(0, dp(54), 1));

        Button menu = new Button(this);
        menu.setText("⋯");
        menu.setTextSize(23);
        menu.setTextColor(Color.WHITE);
        menu.setBackgroundColor(Color.TRANSPARENT);
        menu.setMinWidth(dp(48));
        menu.setOnClickListener(v -> showMenu(menu));
        toolbar.addView(menu, new LinearLayout.LayoutParams(dp(52), dp(50)));
        root.addView(toolbar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(54)));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(10, 10, 10));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return routeUri(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return routeUri(Uri.parse(url));
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    Toast.makeText(MainActivity.this,
                            "Не удалось загрузить CHEATLAB. Проверь подключение к интернету.",
                            Toast.LENGTH_LONG).show();
                }
            }
        });

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadsImagesAutomatically(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            settings.setSafeBrowsingEnabled(true);
        }

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (ActivityNotFoundException ex) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "Не найден файловый менеджер", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> requestWebMediaPermission(request));
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                    android.webkit.GeolocationPermissions.Callback callback) {
                callback.invoke(origin, false, false);
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
                downloadFile(url, userAgent, contentDisposition, mimeType));

        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);

        if (savedInstanceState == null) {
            webView.loadUrl(HOME);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private void showMenu(View anchor) {
        PopupMenu popup = new PopupMenu(this, anchor);
        popup.getMenu().add("О приложении");
        popup.getMenu().add("Лицензия и уведомления");
        popup.getMenu().add("Политика конфиденциальности");
        popup.getMenu().add("Открыть сайт в браузере");
        popup.setOnMenuItemClickListener(item -> {
            String title = item.getTitle().toString();
            if (title.equals("О приложении")) {
                showInfo();
            } else if (title.equals("Лицензия и уведомления")) {
                showLicense();
            } else if (title.equals("Политика конфиденциальности")) {
                webView.loadUrl("https://cheatlab.fun/privacy");
            } else if (title.equals("Открыть сайт в браузере")) {
                openExternal(Uri.parse(HOME));
            }
            return true;
        });
        popup.show();
    }

    private void showInfo() {
        new android.app.AlertDialog.Builder(this)
                .setTitle("CHEATLAB для Android")
                .setMessage("Мобильный клиент веб-сервиса CHEATLAB.\n\n" +
                        "Версия 1.0.0\n" +
                        "Сайт: https://cheatlab.fun\n\n" +
                        "Приложение отображает сайт в защищённом Android WebView. " +
                        "Данные аккаунта и публикации обрабатываются веб-сервисом согласно его политике конфиденциальности.")
                .setPositiveButton("Лицензия", (d, w) -> showLicense())
                .setNegativeButton("Закрыть", null)
                .show();
    }

    private void showLicense() {
        String license = "CHEATLAB ANDROID CLIENT — ЛИЦЕНЗИЯ\n" +
                "Copyright © 2026 CHEATLAB / tatarhost. Все права защищены.\n\n" +
                "Пользователю предоставляется право установить и использовать эту сборку " +
                "для личного использования. Копирование, изменение, публикация и распространение " +
                "самого приложения или его исходного кода без разрешения правообладателя не допускаются.\n\n" +
                "Эта лицензия не распространяется на материалы, загруженные пользователями, " +
                "товарные знаки, сайт CHEATLAB и компоненты Android, предоставляемые производителем устройства.\n\n" +
                "Сторонние Android-библиотеки в приложение не включены. Android System WebView " +
                "предоставляется отдельно системой устройства и регулируется собственными условиями.";
        new android.app.AlertDialog.Builder(this)
                .setTitle("Лицензия и сторонние компоненты")
                .setMessage(license)
                .setPositiveButton("Условия сайта", (d, w) -> webView.loadUrl("https://cheatlab.fun/terms"))
                .setNegativeButton("Закрыть", null)
                .show();
    }

    private boolean routeUri(Uri uri) {
        if (uri == null) return true;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if ("https".equals(scheme) && isAllowedHost(uri.getHost())) return false;
        if ("http".equals(scheme) || "https".equals(scheme) ||
                "mailto".equals(scheme) || "tel".equals(scheme)) {
            openExternal(uri);
            return true;
        }
        return true;
    }

    private boolean isAllowedHost(String host) {
        if (host == null) return false;
        return host.equalsIgnoreCase("cheatlab.fun") ||
                host.equalsIgnoreCase("www.cheatlab.fun") ||
                host.equalsIgnoreCase("cheatlab.tatarhost.workers.dev") ||
                host.equalsIgnoreCase("tatarhost.github.io");
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ex) {
            Toast.makeText(this, "Не найдено приложение для открытия ссылки", Toast.LENGTH_SHORT).show();
        }
    }

    private void requestWebMediaPermission(PermissionRequest request) {
        Uri origin = request.getOrigin();
        if (origin == null || !"https".equals(origin.getScheme()) ||
                !"cheatlab.fun".equalsIgnoreCase(origin.getHost())) {
            request.deny();
            return;
        }

        List<String> needed = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                    needed.add(Manifest.permission.CAMERA);
                }
            } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    needed.add(Manifest.permission.RECORD_AUDIO);
                }
            } else {
                request.deny();
                return;
            }
        }

        if (needed.isEmpty()) {
            request.grant(request.getResources());
        } else {
            if (pendingPermissionRequest != null) pendingPermissionRequest.deny();
            pendingPermissionRequest = request;
            pendingAndroidPermissions = needed.toArray(new String[0]);
            requestPermissions(pendingAndroidPermissions, MEDIA_PERMISSION_REQUEST);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == MEDIA_PERMISSION_REQUEST && pendingPermissionRequest != null) {
            boolean granted = grantResults.length > 0;
            for (int result : grantResults) granted &= result == PackageManager.PERMISSION_GRANTED;
            if (granted) pendingPermissionRequest.grant(pendingPermissionRequest.getResources());
            else pendingPermissionRequest.deny();
            pendingPermissionRequest = null;
            pendingAndroidPermissions = new String[0];
        }
    }

    private void downloadFile(String url, String userAgent, String disposition, String mimeType) {
        if (url == null || !url.startsWith("https://")) {
            Toast.makeText(this, "Разрешены только защищённые HTTPS-загрузки", Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            String name = URLUtil.guessFileName(url, disposition, mimeType);
            request.setTitle(name);
            request.setDescription("Загрузка из CHEATLAB");
            request.setMimeType(mimeType);
            request.addRequestHeader("User-Agent", userAgent);
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) request.addRequestHeader("Cookie", cookie);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            manager.enqueue(request);
            Toast.makeText(this, "Загрузка началась", Toast.LENGTH_SHORT).show();
        } catch (Exception ex) {
            Toast.makeText(this, "Не удалось начать загрузку", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && fileCallback != null) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    result = new Uri[count];
                    for (int i = 0; i < count; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(result);
            fileCallback = null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        if (pendingPermissionRequest != null) pendingPermissionRequest.deny();
        if (webView != null) {
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
        }
        super.onDestroy();
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }
}
