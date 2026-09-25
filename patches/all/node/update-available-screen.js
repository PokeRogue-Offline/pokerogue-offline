#!/usr/bin/env node
/**
 * Patch: update-available-screen.js
 *
 * Registers the "Update Available" screen (paginated, scrollable changelog
 * viewer) as a new UiMode. This is the display half of the update-checker
 * feature; update-check.js is what actually calls
 * `globalScene.ui.setOverlayMode(UiMode.UPDATE_AVAILABLE, releases)`.
 *
 * Independent of app-settings-menu.js/gacha-calendar.js: like those two
 * patches, this one anchors on the stable upstream `ALERT_MODAL,` /
 * `new AlertModalUiHandler(),` markers rather than on whatever the
 * previously-run offline patch happened to append last, so it can be
 * added or removed in any order relative to them.
 *
 * Sub-patches, applied in order:
 *
 *   1. src/enums/ui-mode.ts
 *        Append UPDATE_AVAILABLE (after ALERT_MODAL, a stable upstream
 *        entry - same anchor app-settings-menu.js/gacha-calendar.js use).
 *
 *   2. src/ui/utils/markdown-to-bbcode.ts  (new file, plus its test)
 *        Small markdown-subset -> BBCode converter used to render the
 *        changelog text. Copied verbatim from new-files/.
 *
 *   3. src/ui/handlers/update-available-ui-handler.ts  (new file)
 *        The screen itself. Copied verbatim from new-files/.
 *
 *   4. src/ui/ui.ts
 *        Import UpdateAvailableUiHandler, register right after
 *        AlertModalUiHandler in the handlers array (must land at the same
 *        relative position as UPDATE_AVAILABLE in the enum - see comment
 *        at the handler-array anchor below), add to noTransitionModes.
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
  const ANCHOR = "ALERT_MODAL,";
  requireAnchor(uiModeSrc, ANCHOR, "ALERT_MODAL in ui-mode.ts");
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
  // Import order is stylistic (biome organizeImports) and doesn't matter at
  // runtime, unlike the handlers array below - anchor on the same stable
  // AlertModalUiHandler import app-settings-menu.js/gacha-calendar.js use.
  const IMPORT_ANCHOR = `import { AlertModalUiHandler } from "#ui/alert-modal-ui-handler";`;
  requireAnchor(uiSrc, IMPORT_ANCHOR, "AlertModalUiHandler import in ui.ts");
  uiSrc = uiSrc.replace(
    IMPORT_ANCHOR,
    `${IMPORT_ANCHOR}\nimport { UpdateAvailableUiHandler } from "#ui/update-available-ui-handler";`,
  );

  // Ui.getHandler() does `this.handlers[this.mode]` - the handlers array is
  // indexed positionally by UiMode's numeric enum value, NOT looked up by
  // type. UPDATE_AVAILABLE is inserted right after ALERT_MODAL in the enum
  // (sub-patch 1), so its handler instance MUST also be inserted right after
  // AlertModalUiHandler here, to stay at the matching position - not
  // alphabetical, not import order, not "end of array".
  const HANDLER_ANCHOR = `new AlertModalUiHandler(),`;
  requireAnchor(uiSrc, HANDLER_ANCHOR, "new AlertModalUiHandler() in ui.ts");
  uiSrc = uiSrc.replace(HANDLER_ANCHOR, `${HANDLER_ANCHOR}\n      new UpdateAvailableUiHandler(),`);

  const NO_TRANSITION_ANCHOR = `UiMode.ALERT_MODAL,`;
  requireAnchor(uiSrc, NO_TRANSITION_ANCHOR, "UiMode.ALERT_MODAL in noTransitionModes");
  uiSrc = uiSrc.replace(NO_TRANSITION_ANCHOR, `${NO_TRANSITION_ANCHOR}\n  UiMode.UPDATE_AVAILABLE,`);

  writeFile(UI_PATH, uiSrc);
}

console.log("\nupdate-available-screen patch applied successfully.");
