# CHEATLAB for Android

Native Android shell for https://cheatlab.fun, built with the Android SDK and
the system WebView. The site remains the source of account, publication, mail,
and other service data.

## Features

- Mobile CHEATLAB site in WebView with JavaScript, DOM storage, and cookies.
- Android back navigation.
- File selection for site uploads and HTTPS downloads to Downloads.
- Camera and microphone permission prompts only when the trusted CHEATLAB
  origin requests them.
- External links open in the system browser.
- In-app app information, license, third-party notices, terms, and privacy links.
- No location, contacts, SMS, accessibility, or package-install permissions.

## Build

Requires JDK 17, Android SDK Platform 35, and Gradle 8.9.

```sh
gradle -p android-app :app:assembleDebug
```

APK output:
`android-app/app/build/outputs/apk/debug/app-debug.apk`

The debug build uses application ID `com.tatarhost.cheatlab.debug`.
