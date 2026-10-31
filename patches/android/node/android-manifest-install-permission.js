#!/usr/bin/env node
/**
 * Patch: android-manifest-install-permission.js
 *
 * Adds the permission and FileProvider wiring OtaBridgePlugin.installApk
 * needs to hand a downloaded APK to Android's system package installer
 * (new-files/src/system/offline/mobile-updater.ts's native-fallback path,
 * used when a release's native fingerprint doesn't match the installed
 * build's).
 *
 * Fix:
 *   Adds android.permission.REQUEST_INSTALL_PACKAGES, plus a FileProvider
 *   <provider> entry pointing at configs/android/res/xml/file_paths.xml
 *   (copied in alongside the app icon resources).
 *
 * Targets: android/app/src/main/AndroidManifest.xml
 *   (located relative to the Capacitor project root, i.e. pokerogue-src/)
 */

const fs = require("fs");
const path = require("path");

const TARGET = path.join("android", "app", "src", "main", "AndroidManifest.xml");

if (!fs.existsSync(TARGET)) {
  console.error(`ERROR: Could not find target file: ${TARGET}`);
  console.error("Make sure 'npx cap add android' has been run before this patch.");
  process.exit(1);
}

let src = fs.readFileSync(TARGET, "utf8");

if (src.includes("REQUEST_INSTALL_PACKAGES")) {
  console.log("Install-package permission/provider already present, skipping.");
  process.exit(0);
}

const APPLICATION_ANCHOR = "<application";

if (!src.includes(APPLICATION_ANCHOR)) {
  console.error(`ERROR: Could not find '${APPLICATION_ANCHOR}' in ${TARGET}`);
  console.error("AndroidManifest.xml structure may have changed. Manual inspection required.");
  process.exit(1);
}

src = src.replace(
  APPLICATION_ANCHOR,
  `<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />\n    ${APPLICATION_ANCHOR}`,
);

const CLOSING_APPLICATION_TAG = "</application>";

if (!src.includes(CLOSING_APPLICATION_TAG)) {
  console.error(`ERROR: Could not find '${CLOSING_APPLICATION_TAG}' in ${TARGET}`);
  console.error("AndroidManifest.xml structure may have changed. Manual inspection required.");
  process.exit(1);
}

const PROVIDER_BLOCK = `    <provider
        android:name="androidx.core.content.FileProvider"
        android:authorities="\${applicationId}.fileprovider"
        android:exported="false"
        android:grantUriPermissions="true">
        <meta-data
            android:name="android.support.FILE_PROVIDER_PATHS"
            android:resource="@xml/file_paths" />
    </provider>
`;

src = src.replace(CLOSING_APPLICATION_TAG, `${PROVIDER_BLOCK}${CLOSING_APPLICATION_TAG}`);

fs.writeFileSync(TARGET, src, "utf8");
console.log(`Patched ${TARGET}`);
console.log("Install-package permission and FileProvider applied successfully.");
