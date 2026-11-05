package com.tatarhost.cheatlab;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
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
                    if (android.os.Build.VERSION.SDK_INT >= 28) {
                        localVersion = (int) info.getLongVersionCode();
                    } else {
                        localVersion = info.versionCode;
                    }
                } catch (Exception e) {
                    localVersion = 1;
                }

                JSONArray assets = release.optJSONArray("assets");
                String apkUrl = null;
                if (assets != null) {
                    for (int i = 0; i < assets.length(); i++) {
                        JSONObject asset = assets.optJSONObject(i);
                        if (asset != null && "app-debug.apk".equals(asset.optString("name"))) {
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
                                        ". Скачать APK из официального GitHub-релиза?")
                                .setPositiveButton("Скачать", (dialog, which) ->
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

    private static int trailingVersion(String tag) {
        int dot = tag.lastIndexOf('.');
        if (dot < 0 || dot == tag.length() - 1) return 0;
        try {
            return Integer.parseInt(tag.substring(dot + 1));
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }

    private static void download(Context context, String url, String tag) {
        Uri uri = Uri.parse(url);
        String host = uri.getHost();
        if (!"https".equals(uri.getScheme()) || host == null ||
                !(host.equalsIgnoreCase("github.com") ||
                  host.equalsIgnoreCase("objects.githubusercontent.com") ||
                  host.equalsIgnoreCase("release-assets.githubusercontent.com"))) {
            Toast.makeText(context, "GitHub вернул недопустимую ссылку", Toast.LENGTH_LONG).show();
            return;
        }
        DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) {
            Toast.makeText(context, "Загрузчик Android недоступен", Toast.LENGTH_LONG).show();
            return;
        }
        DownloadManager.Request request = new DownloadManager.Request(uri);
        request.setTitle("Обновление CHEATLAB " + tag);
        request.setDescription("Загрузка APK из официального GitHub-релиза");
        request.setMimeType("application/vnd.android.package-archive");
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                "CHEATLAB-" + tag.replaceAll("[^A-Za-z0-9._-]", "") + ".apk");
        manager.enqueue(request);
        Toast.makeText(context, "Загрузка началась. APK появится в папке «Загрузки».",
                Toast.LENGTH_LONG).show();
    }
}
