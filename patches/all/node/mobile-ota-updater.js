#!/usr/bin/env node
/**
 * Patch: mobile-ota-updater.js
 *
 * Copies in #system/offline/mobile-updater.ts, its sibling
 * #system/offline/ota-parts.ts (the per-channel stage/activate/rollback
 * primitives mobile-updater.ts imports from), and #ui/mobile-update-
 * overlay.ts (the Capacitor OTA/native-fallback updater and its DOM
 * overlay UI - see new-files/ for the real logic), and wires
 * reapplyActiveOtaBundleIfAny()'s boot hook into main.ts, so a previously-
 * applied OTA bundle is re-activated on every cold launch (otherwise a
 * full relaunch would silently fall back to whatever was originally
 * bundled).
 *
 * Applied for ALL platforms (not just mobile), even though both files only
 * ever do anything on a real Capacitor platform: #ui/handlers/update-
 * available-ui-handler.ts (an all-platforms file) needs to reference them,
 * and Rolldown resolves every static/dynamic import specifier at build time
 * regardless of the runtime guard around it - a local file path, unlike an
 * npm package, can't be "externalized" to dodge that, so the files must
 * simply exist everywhere. Every exported function in both new files
 * already checks Capacitor.isNativePlatform()/getPlatform() and no-ops (or
 * returns null) when it isn't one.
 *
 * NOTE: the boot hook only runs AFTER the WebView's initial page load, so
 * on a cold launch the OLD bundle's main.ts briefly runs first; if a newer
 * OTA bundle is active, reapplyActiveOtaBundleIfAny() fires one reload() to
 * switch over. One extra reload per cold launch, not unsafe - a fully
 * native (pre-WebView-load) reapply hook is a possible future improvement,
 * not required for correctness.
 *
 * Targets: pokerogue-src/src/main.ts
 *          pokerogue-src/src/system/offline/mobile-updater.ts (new file)
 *          pokerogue-src/src/system/offline/ota-parts.ts (new file)
 *          pokerogue-src/src/ui/mobile-update-overlay.ts (new file)
 */

const fs = require("fs");
const path = require("path");

function readFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`ERROR: Could not find ${filePath}`);
    console.error("Make sure this script is run from the repo root and all submodules are initialised.");
    process.exit(1);
  }
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  console.log(`  Written: ${filePath}`);
}

function requireAnchor(src, anchor, label) {
  if (!src.includes(anchor)) {
    console.error(`ERROR: Could not find anchor for "${label}".`);
    console.error("The upstream file may have changed. Manual inspection required.");
    process.exit(1);
  }
}

const NEW_FILES_DIR = path.join(__dirname, "..", "..", "..", "new-files");

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 1: src/system/offline/mobile-updater.ts (new file)
// ─────────────────────────────────────────────────────────────────────────────

const UPDATER_PATH = path.join("pokerogue-src", "src", "system", "offline", "mobile-updater.ts");
if (fs.existsSync(UPDATER_PATH)) {
  console.log("SKIP mobile-updater.ts — already exists");
} else {
  const updaterSrc = fs.readFileSync(
    path.join(NEW_FILES_DIR, "src", "system", "offline", "mobile-updater.ts"),
    "utf8",
  );
  writeFile(UPDATER_PATH, updaterSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 1a: src/system/offline/ota-parts.ts (new file) - the per-channel
// stage/activate/rollback primitives mobile-updater.ts (sub-patch 1 above)
// imports from. Without this, mobile-updater.ts lands in pokerogue-src but
// imports a sibling file that was never placed next to it, and Rolldown
// fails to resolve "#system/offline/ota-parts" at build time.
// ─────────────────────────────────────────────────────────────────────────────

const OTA_PARTS_PATH = path.join("pokerogue-src", "src", "system", "offline", "ota-parts.ts");
if (fs.existsSync(OTA_PARTS_PATH)) {
  console.log("SKIP ota-parts.ts — already exists");
} else {
  const otaPartsSrc = fs.readFileSync(
    path.join(NEW_FILES_DIR, "src", "system", "offline", "ota-parts.ts"),
    "utf8",
  );
  writeFile(OTA_PARTS_PATH, otaPartsSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 1b: src/ui/mobile-update-overlay.ts (new file)
// ─────────────────────────────────────────────────────────────────────────────

const OVERLAY_PATH = path.join("pokerogue-src", "src", "ui", "mobile-update-overlay.ts");
if (fs.existsSync(OVERLAY_PATH)) {
  console.log("SKIP mobile-update-overlay.ts — already exists");
} else {
  const overlaySrc = fs.readFileSync(
    path.join(NEW_FILES_DIR, "src", "ui", "mobile-update-overlay.ts"),
    "utf8",
  );
  writeFile(OVERLAY_PATH, overlaySrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 2: src/main.ts  →  reapply a previously-applied OTA bundle on boot
// ─────────────────────────────────────────────────────────────────────────────

const MAIN_PATH = path.join("pokerogue-src", "src", "main.ts");
let mainSrc = readFile(MAIN_PATH);

if (mainSrc.includes("mobile-ota-updater")) {
  console.log("SKIP main.ts — OTA reapply hook already present");
} else {
  // Stable regardless of other mobile patches' own edits to main.ts
  // (background-audio-pause.js only appends after this same anchor, never
  // mutates the anchor text itself).
  const IMPORT_ANCHOR = `import { isBeta, isDev } from "#constants/app-constants";`;
  requireAnchor(mainSrc, IMPORT_ANCHOR, "app-constants import in main.ts");

  mainSrc = mainSrc.replace(
    IMPORT_ANCHOR,
    `${IMPORT_ANCHOR}\n` +
      `import { reapplyActiveOtaBundleIfAny } from "#system/offline/mobile-updater";\n` +
      `\n` +
      `// mobile-ota-updater: re-point the WebView at a previously-applied OTA\n` +
      `// bundle (if any) as early as possible.\n` +
      `if ((window as any).Capacitor?.isNativePlatform?.()) {\n` +
      `  reapplyActiveOtaBundleIfAny();\n` +
      `}`,
  );

  writeFile(MAIN_PATH, mainSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 3: src/ui/handlers/title-ui-handler.ts  →  confirm a successful
// boot once the title screen is reached, clearing the crash-loop counter and
// any previous (now-superseded) staged OTA version.
// ─────────────────────────────────────────────────────────────────────────────

const TITLE_UI_PATH = path.join("pokerogue-src", "src", "ui", "handlers", "title-ui-handler.ts");
let titleSrc = readFile(TITLE_UI_PATH);

if (titleSrc.includes("confirmOtaBootSuccess")) {
  console.log("SKIP title-ui-handler.ts — OTA boot confirmation already present");
} else {
  // Preserved verbatim as the prefix of update-check.js's own replacement of
  // this same line, so this anchor is stable regardless of whether
  // update-check.js has already run (both are in apply-patches.sh's "all"
  // section, update-check.js applied first).
  const TITLE_ANCHOR = `this.appVersionText.setText("v" + version + betaText + appText);`;
  requireAnchor(titleSrc, TITLE_ANCHOR, "appVersionText.setText line in title-ui-handler.ts");

  const IMPORT_ANCHOR = `import { version } from "#package.json";\n`;
  requireAnchor(titleSrc, IMPORT_ANCHOR, 'version import in title-ui-handler.ts');
  titleSrc = titleSrc.replace(
    IMPORT_ANCHOR,
    `${IMPORT_ANCHOR}import { confirmOtaBootSuccess } from "#system/offline/mobile-updater";\n`,
  );

  titleSrc = titleSrc.replace(
    TITLE_ANCHOR,
    `${TITLE_ANCHOR}\n\n` +
      `    // mobile-ota-updater: title screen reached - this boot is good.\n` +
      `    if ((window as any).Capacitor?.isNativePlatform?.()) {\n` +
      `      confirmOtaBootSuccess();\n` +
      `    }`,
  );

  writeFile(TITLE_UI_PATH, titleSrc);
}

console.log("Mobile OTA updater applied successfully.");
