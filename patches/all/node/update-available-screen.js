#!/usr/bin/env node
/**
 * Patch: update-available-screen.js
 *
 * Registers the "Update Available" screen (paginated, scrollable changelog
 * viewer) as a new UiMode. This is the display half of the update-checker
 * feature; update-check.js (which must run before this, so
 * SETTINGS_OFFLINE_BACKUP/SETTINGS_OFFLINE_PREFERENCES/GACHA_CALENDAR
 * already exist as the enum's/handlers array's last entries) is what
 * actually calls `globalScene.ui.setOverlayMode(UiMode.UPDATE_AVAILABLE, releases)`.
 *
 * Sub-patches, applied in order:
 *
 *   1. src/enums/ui-mode.ts
 *        Append UPDATE_AVAILABLE (after SETTINGS_OFFLINE_PREFERENCES, the
 *        last entry at the time this patch runs).
 *
 *   2. src/ui/utils/markdown-to-bbcode.ts  (new file, plus its test)
 *        Small markdown-subset -> BBCode converter used to render the
 *        changelog text. Copied verbatim from new-files/.
 *
 *   3. src/ui/handlers/update-available-ui-handler.ts  (new file)
 *        The screen itself. Copied verbatim from new-files/.
 *
 *   4. src/ui/ui.ts
 *        Import UpdateAvailableUiHandler, register at the position matching
 *        UiMode.UPDATE_AVAILABLE (end of the handlers array, since it's the
 *        last UiMode entry), add to noTransitionModes.
 *
 * No menu-ui-handler.ts changes - this screen is only ever opened
 * programmatically from the update checker, never from the pause menu.
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

// This patch script lives at patches/all/node/update-available-screen.js in
// the pkr-offline repo. The new source files it writes are checked into this
// same repo (under new-files/) so this script and its payload stay together.
const NEW_FILES_DIR = path.join(__dirname, "..", "..", "..", "new-files");

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 1: src/enums/ui-mode.ts  →  append UPDATE_AVAILABLE
// ─────────────────────────────────────────────────────────────────────────────

const UI_MODE_PATH = path.join("pokerogue-src", "src", "enums", "ui-mode.ts");
let uiModeSrc = readFile(UI_MODE_PATH);

if (uiModeSrc.includes("UPDATE_AVAILABLE")) {
  console.log("SKIP ui-mode.ts — UPDATE_AVAILABLE already present");
} else {
  const ANCHOR = "SETTINGS_OFFLINE_PREFERENCES,";
  requireAnchor(uiModeSrc, ANCHOR, "SETTINGS_OFFLINE_PREFERENCES in ui-mode.ts");
  uiModeSrc = uiModeSrc.replace(ANCHOR, `${ANCHOR}\n  UPDATE_AVAILABLE,`);
  writeFile(UI_MODE_PATH, uiModeSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 2: src/ui/utils/markdown-to-bbcode.ts  (new file)
// ─────────────────────────────────────────────────────────────────────────────

const MARKDOWN_UTIL_PATH = path.join("pokerogue-src", "src", "ui", "utils", "markdown-to-bbcode.ts");

if (fs.existsSync(MARKDOWN_UTIL_PATH)) {
  console.log("SKIP markdown-to-bbcode.ts — already exists");
} else {
  const src = fs.readFileSync(path.join(NEW_FILES_DIR, "src", "ui", "utils", "markdown-to-bbcode.ts"), "utf8");
  writeFile(MARKDOWN_UTIL_PATH, src);
}

const MARKDOWN_UTIL_TEST_PATH = path.join("pokerogue-src", "test", "tests", "ui", "utils", "markdown-to-bbcode.test.ts");
if (fs.existsSync(MARKDOWN_UTIL_TEST_PATH)) {
  console.log("SKIP markdown-to-bbcode.test.ts — already exists");
} else {
  const src = fs.readFileSync(
    path.join(NEW_FILES_DIR, "test", "tests", "ui", "utils", "markdown-to-bbcode.test.ts"),
    "utf8",
  );
  writeFile(MARKDOWN_UTIL_TEST_PATH, src);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 3: src/ui/handlers/update-available-ui-handler.ts  (new file)
// ─────────────────────────────────────────────────────────────────────────────

const HANDLER_PATH = path.join("pokerogue-src", "src", "ui", "handlers", "update-available-ui-handler.ts");

if (fs.existsSync(HANDLER_PATH)) {
  console.log("SKIP update-available-ui-handler.ts — already exists");
} else {
  const src = fs.readFileSync(
    path.join(NEW_FILES_DIR, "src", "ui", "handlers", "update-available-ui-handler.ts"),
    "utf8",
  );
  writeFile(HANDLER_PATH, src);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 4: src/ui/ui.ts  →  import + register + noTransitionModes
// ─────────────────────────────────────────────────────────────────────────────

const UI_PATH = path.join("pokerogue-src", "src", "ui", "ui.ts");
let uiSrc = readFile(UI_PATH);

if (uiSrc.includes("UpdateAvailableUiHandler")) {
  console.log("SKIP ui.ts — UpdateAvailableUiHandler already present");
} else {
  // Import line is inserted in alphabetical order (biome organizeImports),
  // which is independent from the handlers array below - that array's
  // order is NOT stylistic, it's a functional requirement (see next comment).
  const IMPORT_ANCHOR = `import { OfflineSettingsUiHandler } from "#ui/offline-settings-ui-handler";`;
  if (uiSrc.includes(IMPORT_ANCHOR)) {
    uiSrc = uiSrc.replace(
      IMPORT_ANCHOR,
      `${IMPORT_ANCHOR}\nimport { UpdateAvailableUiHandler } from "#ui/update-available-ui-handler";`,
    );
  } else {
    // Fall back to anchoring on the FightUiHandler import (present since before
    // this fork's patches), inserting our import at the end of the import block
    // instead of alphabetically - functionally equivalent, since import order
    // doesn't matter at runtime.
    const FALLBACK_IMPORT_ANCHOR = `import { FightUiHandler } from "#ui/fight-ui-handler";`;
    requireAnchor(uiSrc, FALLBACK_IMPORT_ANCHOR, "FightUiHandler import in ui.ts");
    uiSrc = uiSrc.replace(
      FALLBACK_IMPORT_ANCHOR,
      `${FALLBACK_IMPORT_ANCHOR}\nimport { UpdateAvailableUiHandler } from "#ui/update-available-ui-handler";`,
    );
  }

  // Ui.getHandler() does `this.handlers[this.mode]` - the handlers array is
  // indexed positionally by UiMode's numeric enum value, NOT looked up by
  // type. Since UPDATE_AVAILABLE is appended as the LAST UiMode entry, its
  // handler instance MUST also be the last element of this array, matching
  // enum order exactly - not alphabetical, not import order.
  const HANDLER_ANCHOR = `new OfflinePreferencesUiHandler(),`;
  requireAnchor(uiSrc, HANDLER_ANCHOR, "new OfflinePreferencesUiHandler() in ui.ts");
  uiSrc = uiSrc.replace(HANDLER_ANCHOR, `${HANDLER_ANCHOR}\n      new UpdateAvailableUiHandler(),`);

  const NO_TRANSITION_ANCHOR = `UiMode.SETTINGS_OFFLINE_PREFERENCES,`;
  requireAnchor(uiSrc, NO_TRANSITION_ANCHOR, "UiMode.SETTINGS_OFFLINE_PREFERENCES in noTransitionModes");
  uiSrc = uiSrc.replace(NO_TRANSITION_ANCHOR, `${NO_TRANSITION_ANCHOR}\n  UiMode.UPDATE_AVAILABLE,`);

  writeFile(UI_PATH, uiSrc);
}

console.log("\nupdate-available-screen patch applied successfully.");
