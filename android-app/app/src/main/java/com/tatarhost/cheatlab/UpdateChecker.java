package com.tatarhost.cheatlab;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.widget.Toast;
import android.app.AlertDialog;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

final class UpdateChecker {
    private static final String RELEASE_API =
            "https://api.github.com/repos/tatarhost/cheatlab/releases/latest";
    private static final String PREFS = "cheatlab_updater";
    private static final String PENDING_URL = "pending_url";
    private static final String PENDING_TAG = "pending_tag";
    private static final String DOWNLOAD_ID = "download_id";

    private UpdateChecker() {}

    static void check(Activity activity, boolean showUpToDate) {
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(RELEASE_API);
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(10000);
                connection.setReadTimeout(10000);
                connection.setRequestProperty("Accept", "application/vnd.github+json");
                connection.setRequestProperty("User-Agent", "CHEATLAB-Android-Updater");
                int status = connection.getResponseCode();
                if (status != 200) throw new IllegalStateException("GitHub HTTP " + status);

                StringBuilder body = new StringBuilder();
                try (InputStream in = connection.getInputStream();
                     BufferedReader reader = new BufferedReader(new InputStreamReader(in, "UTF-8"))) {
                    String line;
                    while ((line = reader.readLine()) != null) body.append(line);
                }

                JSONObject release = new JSONObject(body.toString());
                String tag = release.optString("tag_name", "");
                int remoteVersion = trailingVersion(tag);
                int localVersion;
                try {
                    android.content.pm.PackageInfo info =
                            activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
                    localVersion = Build.VERSION.SDK_INT >= 28
                            ? (int) info.getLongVersionCode() : info.versionCode;
                } catch (Exception e) {
                    localVersion = 1;
                }

                JSONArray assets = release.optJSONArray("assets");
                String apkUrl = null;
                if (assets != null) {
                    for (int i = 0; i < assets.length(); i++) {
                        JSONObject asset = assets.optJSONObject(i);
                        if (asset != null &&
                                asset.optString("name").toLowerCase(java.util.Locale.ROOT).endsWith(".apk") &&
                                !asset.optString("name").toLowerCase(java.util.Locale.ROOT).contains("unaligned")) {
                            apkUrl = asset.optString("browser_download_url", null);
                            break;
                        }
                    }
                }
                final String downloadUrl = apkUrl;
                final String releaseTag = tag;
                final boolean updateAvailable = remoteVersion > localVersion && downloadUrl != null;
                activity.runOnUiThread(() -> {
                    if (activity.isFinishing()) return;
                    if (updateAvailable) {
                        new AlertDialog.Builder(activity)
                                .setTitle("Доступно обновление CHEATLAB")
                                .setMessage("Найдена версия " + releaseTag +
                                        ". Разрешить установку обновлений из CHEATLAB и установить её?")
                                .setPositiveButton("Продолжить", (dialog, which) ->
                                        download(activity, downloadUrl, releaseTag))
                                .setNegativeButton("Позже", null)
                                .show();
                    } else if (showUpToDate) {
                        Toast.makeText(activity, "Установлена последняя доступная версия",
                                Toast.LENGTH_LONG).show();
                    }
                });
            } catch (Exception error) {
                if (showUpToDate) {
                    activity.runOnUiThread(() -> Toast.makeText(activity,
                            "Не удалось проверить обновления GitHub",
                            Toast.LENGTH_LONG).show());
                }
            } finally {
                if (connection != null) connection.disconnect();
            }
        }, "cheatlab-update-check").start();
    }

    static void resumePendingInstall(Activity activity) {
        android.content.SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String url = prefs.getString(PENDING_URL, null);
        String tag = prefs.getString(PENDING_TAG, "latest");
        if (url == null) return;
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(activity, "Разрешение не выдано. Установку можно повторить позже в обновлениях.",
                    Toast.LENGTH_LONG).show();
            return;
        }
        prefs.edit().remove(PENDING_URL).remove(PENDING_TAG).apply();
        enqueueDownload(activity, url, tag);
    }

    private static void download(Activity activity, String url, String tag) {
        Uri uri = Uri.parse(url);
        String host = uri.getHost();
        if (!"https".equals(uri.getScheme()) || host == null ||
                !(host.equalsIgnoreCase("github.com") ||
                  host.equalsIgnoreCase("objects.githubusercontent.com") ||
                  host.equalsIgnoreCase("release-assets.githubusercontent.com"))) {
            Toast.makeText(activity, "GitHub вернул недопустимую ссылку", Toast.LENGTH_LONG).show();
            return;
        }
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString(PENDING_URL, url).putString(PENDING_TAG, tag).apply();
            try {
                Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + activity.getPackageName()));
                activity.startActivityForResult(settings, MainActivity.INSTALL_PERMISSION_REQUEST);
            } catch (Exception e) {
                Toast.makeText(activity, "Откройте настройки «Установка неизвестных приложений» для CHEATLAB.",
                        Toast.LENGTH_LONG).show();
            }
            return;
        }
        enqueueDownload(activity, url, tag);
    }

    private static void enqueueDownload(Context context, String url, String tag) {
        try {
            DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) throw new IllegalStateException("DownloadManager unavailable");
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle("CHEATLAB " + tag);
            request.setDescription("Загрузка обновления из официального GitHub-релиза");
            request.setMimeType("application/vnd.android.package-archive");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                    "CHEATLAB-" + tag.replaceAll("[^A-Za-z0-9._-]", "") + ".apk");
            long id = manager.enqueue(request);
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putLong(DOWNLOAD_ID, id).apply();
            Toast.makeText(context, "APK загружается. После загрузки откроется установка.",
                    Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(context, "Не удалось начать загрузку обновления",
                    Toast.LENGTH_LONG).show();
        }
    }

    static long getPendingDownloadId(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(DOWNLOAD_ID, -1L);
    }

    static void clearPendingDownload(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(DOWNLOAD_ID).apply();
    }

    private static int trailingVersion(String tag) {
        int dot = tag.lastIndexOf('.');
        if (dot < 0 || dot == tag.length() - 1) return 0;
        try { return Integer.parseInt(tag.substring(dot + 1)); }
        catch (NumberFormatException ignored) { return 0; }
    }
}
