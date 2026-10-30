#!/usr/bin/env node
/**
 * compute-native-fingerprint.js android|ios
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
 * Deliberately only reads files in THIS repo's own tree (never the upstream
 * pokerogue-src checkout, and never the Android/iOS projects Capacitor
 * generates from these inputs) - those are reproducible from what's hashed
 * here, so this never needs `pokerogue-src` cloned to run.
 *
 * Inputs are intentionally narrow: a file is only included if it's something
 * the native shell reads independently of dist/ (permissions, plugin
 * registration, URL schemes, native entry points). Files that only affect
 * content shipped inside dist/ itself (post-build HTML/JS patches, icons)
 * are excluded - see the "Native fingerprint" section of the mobile
 * auto-update plan for the audit behind each exclusion.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO_ROOT = path.join(__dirname, "..");

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
    "configs/capacitor-versions.env",
  ],
  ios: [
    "scripts/patch-ios-appdelegate.py",
    "scripts/configure-ios-infoplist.sh",
    "configs/ios/capacitor/capacitor.config.json",
    "configs/ios/capacitor/capacitor.config.dev.json",
    "configs/capacitor-versions.env",
  ],
};

const platform = process.argv[2];

if (!INPUTS[platform]) {
  console.error(`Usage: node ${path.basename(__filename)} <${Object.keys(INPUTS).join("|")}>`);
  process.exit(1);
}

const inputs = [...INPUTS[platform]].sort();
const hash = crypto.createHash("sha256");

for (const relPath of inputs) {
  const absPath = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(absPath)) {
    console.error(`ERROR: fingerprint input missing: ${relPath}`);
    process.exit(1);
  }
  hash.update(relPath);
  hash.update("\n");
  hash.update(fs.readFileSync(absPath));
  hash.update("\n");
}

const fingerprint = hash.digest("hex");

// Diagnostics go to stderr so stdout stays a bare hex digest - callers in CI
// capture stdout directly into a step output without needing to parse JSON.
console.error(JSON.stringify({ platform, inputs }, null, 2));
console.log(fingerprint);
