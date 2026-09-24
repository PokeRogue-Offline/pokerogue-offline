#!/usr/bin/env node
/**
 * Patch: android-manifest-storage-permissions.js
 *
 * Adds the storage permissions needed for native save export
 * (patches/mobile/node/native-save-io.js writes to Downloads/ via
 * Filesystem.writeFile with directory: "EXTERNAL_STORAGE" on Android).
 *
 * Fix:
 *   Adds android.permission.WRITE_EXTERNAL_STORAGE and
 *   android.permission.READ_EXTERNAL_STORAGE <uses-permission> entries to
 *   AndroidManifest.xml.
 *
 * Targets: android/app/src/main/AndroidManifest.xml
 *   (located relative to the Capacitor project root, i.e. pokerogue-src/)
 */

const fs   = require("fs");
const path = require("path");

// ── Locate AndroidManifest.xml ────────────────────────────────────────────────

const TARGET = path.join("android", "app", "src", "main", "AndroidManifest.xml");

if (!fs.existsSync(TARGET)) {
  console.error(`ERROR: Could not find target file: ${TARGET}`);
  console.error("Make sure 'npx cap add android' has been run before this patch.");
  process.exit(1);
}

// ── Read & guard ──────────────────────────────────────────────────────────────

let src = fs.readFileSync(TARGET, "utf8");

if (src.includes("WRITE_EXTERNAL_STORAGE")) {
  console.log("Storage permissions already present, skipping.");
  process.exit(0);
}

// ── Apply ─────────────────────────────────────────────────────────────────────

const APPLICATION_ANCHOR = "<application";

if (!src.includes(APPLICATION_ANCHOR)) {
  console.error(`ERROR: Could not find '${APPLICATION_ANCHOR}' in ${TARGET}`);
  console.error("AndroidManifest.xml structure may have changed. Manual inspection required.");
  process.exit(1);
}

src = src.replace(
  APPLICATION_ANCHOR,
  `<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />\n    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />\n    ${APPLICATION_ANCHOR}`,
);

// ── Write ─────────────────────────────────────────────────────────────────────

fs.writeFileSync(TARGET, src, "utf8");
console.log(`Patched ${TARGET}`);
console.log("Storage permissions applied successfully.");
