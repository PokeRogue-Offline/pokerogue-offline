#!/usr/bin/env node
/**
 * compute-native-fingerprint.js android|ios|desktop
 *
 * Prints a SHA-256 hex digest over a fixed, explicit list of this overlay
 * repo's own files that can change what the installed native shell (Capacitor
 * plugin set, MainActivity.java/AppDelegate.swift, manifest/Info.plist
 * permissions and URL schemes, etc.) requires from the web bundle.
 *
 * Used by build-android.yml/build-ios.yml to decide, per release, whether a
 * mobile OTA update is safe to hot-swap the web bundle in place (fingerprint
 * unchanged since the installed build) or needs a real reinstall
 * (fingerprint changed) - see new-files/src/system/offline/mobile-updater.ts.
 *
 * `desktop` is the same idea for the Electron builds: a hash over the shell
 * (the main-process files, the Electron/builder/runtime-dependency version
 * pins, the packaging configs). A release whose desktop fingerprint equals
 * an installed shell's is delivered to it as a content update; any other
 * release replaces the whole application - see
 * configs/desktop/electron/ota-desktop.cjs. There is ONE desktop
 * fingerprint for Windows, Linux and macOS, because there is one set of
 * desktop OTA assets for all three.
 *
 * Deliberately only reads files in THIS repo's own tree (never the upstream
 * pokerogue-src checkout, and never the Android/iOS projects Capacitor
 * generates from these inputs) - those are reproducible from what's hashed
 * here, so this never needs `pokerogue-src` cloned to run.
 *
 * Inputs are intentionally narrow: a file is only included if it's something
 * the native shell reads independently of dist/ (permissions, plugin
 * registration, URL schemes, native entry points). Files that only affect
 * content shipped inside dist/ itself (post-build HTML/JS patches, icons)
 * are excluded - every such exclusion is written down in EXCLUDED below,
 * with its reason.
 *
 * scripts/check-native-fingerprint-coverage.js (run in CI) fails when a
 * file that looks native-touching is in neither INPUTS nor EXCLUDED, so a
 * new native file cannot be forgotten silently.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO_ROOT = path.join(__dirname, "..");

// Shared across both platforms - the vendored OTA-unzip plugin's JS-facing
// metadata/contract doesn't vary per platform, but a change to it still
// means the native side's actual behavior may have changed too.
const OTA_UNZIP_PLUGIN_SHARED_INPUTS = [
  "configs/capacitor-plugins/ota-unzip/package.json",
  "configs/capacitor-plugins/ota-unzip/src/definitions.ts",
  "configs/capacitor-plugins/ota-unzip/src/index.ts",
];

const INPUTS = {
  android: [
    "configs/android/java/MainActivity.java",
    "configs/android/java/OtaBridgePlugin.java",
    "patches/android/node/android-manifest-keyboard-fix.js",
    "patches/android/node/android-manifest-url-scheme.js",
    "patches/android/node/android-manifest-storage-permissions.js",
    "patches/android/node/android-manifest-install-permission.js",
    "configs/android/capacitor/capacitor.config.json",
    "configs/android/capacitor/capacitor.config-dev.json",
    // FileProvider path spec: decides which files OtaBridgePlugin.installApk()
    // can hand to the system installer. Read by the native shell, not dist/.
    "configs/android/res/xml/file_paths.xml",
    "configs/capacitor-versions.env",
    ...OTA_UNZIP_PLUGIN_SHARED_INPUTS,
    "configs/capacitor-plugins/ota-unzip/android/build.gradle",
    "configs/capacitor-plugins/ota-unzip/android/proguard-rules.pro",
    "configs/capacitor-plugins/ota-unzip/android/src/main/AndroidManifest.xml",
    "configs/capacitor-plugins/ota-unzip/android/src/main/java/com/pokerogueoffline/plugins/otaunzip/OtaUnzipPlugin.java",
  ],
  desktop: [
    // The main process and its preload: everything that runs outside dist/.
    "configs/desktop/electron/main.cjs",
    "configs/desktop/electron/preload.cjs",
    "configs/desktop/electron/updater.cjs",
    "configs/desktop/electron/update-io.cjs",
    "configs/desktop/electron/discord-rpc.cjs",
    "configs/desktop/electron/ota-desktop.cjs",
    // Shipped to mobile as web content, but on desktop it is transpiled
    // into the shell (ota-core.cjs) and runs in the main process.
    "new-files/src/system/offline/ota-core.ts",
    "scripts/transpile-ota-core.js",
    // What gets packaged, and how, per platform.
    "configs/desktop/electron/electron-builder.windows.json",
    "configs/desktop/electron/electron-builder.appimage.json",
    "configs/desktop/electron/electron-builder.macos.json",
    // Electron itself, electron-builder, and the shell's runtime dependencies.
    "configs/desktop/versions.env",
  ],
  ios: [
    "scripts/patch-ios-appdelegate.py",
    "scripts/configure-ios-infoplist.sh",
    "configs/ios/capacitor/capacitor.config.json",
    "configs/ios/capacitor/capacitor.config.dev.json",
    "configs/capacitor-versions.env",
    ...OTA_UNZIP_PLUGIN_SHARED_INPUTS,
    "configs/capacitor-plugins/ota-unzip/OtaUnzip.podspec",
    "configs/capacitor-plugins/ota-unzip/Package.swift",
    "configs/capacitor-plugins/ota-unzip/ios/Sources/OtaUnzipPlugin/OtaUnzipPlugin.swift",
  ],
};

/**
 * Files that live next to native inputs, or are used by the native build,
 * but are deliberately NOT part of the fingerprint - each with the reason.
 * A path ending in "/" excludes everything under that directory.
 */
const EXCLUDED = {
  android: {
    "configs/android/res/mipmap-anydpi-v26/": "Launcher icon definitions. Cosmetic: no effect on what the shell needs from the web bundle.",
    "docs/": "App icon images. Cosmetic.",
    "configs/capacitor-plugins/ota-unzip/android/.gitignore": "Not part of the build.",
    "configs/capacitor-plugins/ota-unzip/ios/": "iOS half of the plugin; not compiled into the Android app.",
    "configs/capacitor-plugins/ota-unzip/OtaUnzip.podspec": "iOS packaging.",
    "configs/capacitor-plugins/ota-unzip/Package.swift": "iOS packaging.",
    "patches/android/node/android-trigger-axis-fix.js": "Post-build patch to dist/ (a JS gamepad shim). Web content, ships by OTA.",
    "patches/android/node/fix-android-image-paths.js": "Source patch to the web app's image loader. Web content, ships by OTA.",
    "scripts/apply-patches.sh": "Runs the web-content patches; the native-affecting ones are listed individually in INPUTS.",
    "scripts/apply-post-build-patches.sh": "Runs dist/ patches only.",
    "scripts/compute-native-fingerprint.js": "This script. Its output changes when INPUTS does, which is the point.",
    "scripts/split-ota-bundle.js": "Packages dist/ for OTA; does not touch the native project.",
  },
  desktop: {
    "docs/": "App icon images. Cosmetic.",
    "scripts/apply-patches.sh": "Runs the web-content patches only.",
    "scripts/apply-post-build-patches.sh": "Runs dist/ patches only.",
    "scripts/compute-native-fingerprint.js": "This script. Its output changes when INPUTS does, which is the point.",
    "scripts/split-ota-bundle.js": "Packages dist/ for OTA; does not touch the shell.",
    "scripts/sed-lib.sh": "Placeholder-substitution helpers.",
  },
  ios: {
    "docs/": "App icon images and the AltStore source. Cosmetic / distribution metadata.",
    "configs/capacitor-plugins/ota-unzip/android/": "Android half of the plugin; not compiled into the iOS app.",
    "scripts/apply-patches.sh": "Runs the web-content patches only.",
    "scripts/apply-post-build-patches.sh": "Runs dist/ patches only.",
    "scripts/compute-native-fingerprint.js": "This script. Its output changes when INPUTS does, which is the point.",
    "scripts/split-ota-bundle.js": "Packages dist/ for OTA; does not touch the native project.",
    "scripts/sed-lib.sh": "Placeholder-substitution helpers; what gets substituted is hashed where it matters.",
    "scripts/update-altstore-source.js": "Writes the AltStore source JSON; distribution metadata only.",
  },
};

function computeFingerprint(platform) {
  const inputs = [...INPUTS[platform]].sort();
  const hash = crypto.createHash("sha256");

  for (const relPath of inputs) {
    const absPath = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`fingerprint input missing: ${relPath}`);
    }
    hash.update(relPath);
    hash.update("\n");
    hash.update(fs.readFileSync(absPath));
    hash.update("\n");
  }

  return { fingerprint: hash.digest("hex"), inputs };
}

function main() {
  const platform = process.argv[2];

  if (!INPUTS[platform]) {
    console.error(`Usage: node ${path.basename(__filename)} <${Object.keys(INPUTS).join("|")}>`);
    process.exit(1);
  }

  let result;
  try {
    result = computeFingerprint(platform);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }

  // Diagnostics go to stderr so stdout stays a bare hex digest - callers in CI
  // capture stdout directly into a step output without needing to parse JSON.
  console.error(JSON.stringify({ platform, inputs: result.inputs }, null, 2));
  console.log(result.fingerprint);
}

if (require.main === module) {
  main();
}

module.exports = { INPUTS, EXCLUDED, REPO_ROOT, computeFingerprint };
