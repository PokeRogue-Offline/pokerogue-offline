#!/usr/bin/env node
/**
 * Patch: enable-touch-controls-quad-tap.js
 *
 * Lets a player re-enable touch controls by tapping the screen 4 times in
 * quick succession, without needing to reach the Settings menu.
 *
 * Problem:
 *   The "Touch Controls" setting can be set to "Disabled" (accidentally or
 *   otherwise). Once disabled, the on-screen D-pad/buttons are hidden
 *   (`display: none` on #touchControls, see index.css), which makes it hard
 *   to get back into the Settings menu on a touch-only device to turn them
 *   back on.
 *
 * Solution:
 *   Register a document-level `touchstart` listener (same pattern as the
 *   existing `preventDoubleTapZoom`) that tracks a rolling window of tap
 *   timestamps. Once 4 taps land within 500ms of each other, restore the
 *   "Auto" touch-controls option via `globalScene.gameData.saveSetting`,
 *   which both flips the live flag and persists it to localStorage. The
 *   listener is a no-op once touch controls are already enabled.
 *
 * Sub-patches, applied in order:
 *
 *   1. src/touch-controls.ts
 *        Add `enableTouchControlsOnQuadrupleTap()`, exported alongside the
 *        existing `preventDoubleTapZoom()`.
 *
 *   2. src/main.ts
 *        Import and call the new function once at startup, next to the
 *        existing `preventDoubleTapZoom()` call.
 *
 * NOTE ON TESTING: anchors below were confirmed against a fresh clone of
 * pagefaultgames/pokerogue at the time this was written. In-app behavior
 * (does the gesture register reliably on a real touchscreen, does it fire
 * accidentally during normal play) has NOT been verified in a running
 * build — do that before shipping.
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

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 1: src/touch-controls.ts  →  add enableTouchControlsOnQuadrupleTap()
// ─────────────────────────────────────────────────────────────────────────────

const TOUCH_CONTROLS_PATH = path.join("pokerogue-src", "src", "touch-controls.ts");
let touchControlsSrc = readFile(TOUCH_CONTROLS_PATH);

if (touchControlsSrc.includes("enableTouchControlsOnQuadrupleTap")) {
  console.log("SKIP touch-controls.ts — enableTouchControlsOnQuadrupleTap already present");
} else {
  const ANCHOR = "/**\n * Check if the device has a touchscreen.";
  requireAnchor(touchControlsSrc, ANCHOR, "hasTouchscreen doc comment in touch-controls.ts");

  const INJECTION = `const QUADRUPLE_TAP_THRESHOLD_MILLIS = 500;
const QUADRUPLE_TAP_COUNT = 4;

/**
 * Installs a single document-level listener that watches for 4 taps in quick succession
 * anywhere on the page and re-enables touch controls when it sees them. This gives players
 * who accidentally disable touch controls on a touchscreen device a way to turn them back on
 * without needing to navigate the settings menu. Intended to be called once at startup.
 */
export function enableTouchControlsOnQuadrupleTap(): void {
  let tapTimestamps: number[] = [];

  document.addEventListener(
    "touchstart",
    (event: TouchEvent) => {
      if (!globalScene || globalScene.enableTouchControls || event.touches.length > 1) {
        tapTimestamps = [];
        return;
      }

      const now = event.timeStamp;
      tapTimestamps = tapTimestamps.filter(timestamp => now - timestamp <= QUADRUPLE_TAP_THRESHOLD_MILLIS);
      tapTimestamps.push(now);

      if (tapTimestamps.length >= QUADRUPLE_TAP_COUNT) {
        tapTimestamps = [];
        // Literal setting key ("TOUCH_CONTROLS") used instead of importing SettingKeys
        // from settings.ts, since settings.ts already imports hasTouchscreen from this
        // file — importing back would create a two-file cycle. Must match
        // SettingKeys.Touch_Controls in src/system/settings/settings.ts.
        globalScene.gameData.saveSetting("TOUCH_CONTROLS", 0);
      }
    },
    { capture: true, passive: true },
  );
}

${ANCHOR}`;

  touchControlsSrc = touchControlsSrc.replace(ANCHOR, INJECTION);
  writeFile(TOUCH_CONTROLS_PATH, touchControlsSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 2: src/main.ts  →  call enableTouchControlsOnQuadrupleTap() at startup
// ─────────────────────────────────────────────────────────────────────────────

const MAIN_PATH = path.join("pokerogue-src", "src", "main.ts");
let mainSrc = readFile(MAIN_PATH);

if (mainSrc.includes("enableTouchControlsOnQuadrupleTap")) {
  console.log("SKIP main.ts — enableTouchControlsOnQuadrupleTap already present");
} else {
  const IMPORT_ANCHOR = `import { preventDoubleTapZoom } from "#app/touch-controls";`;
  requireAnchor(mainSrc, IMPORT_ANCHOR, "preventDoubleTapZoom import in main.ts");

  const CALL_ANCHOR = "preventDoubleTapZoom();";
  requireAnchor(mainSrc, CALL_ANCHOR, "preventDoubleTapZoom() call in main.ts");

  mainSrc = mainSrc.replace(
    IMPORT_ANCHOR,
    `import { enableTouchControlsOnQuadrupleTap, preventDoubleTapZoom } from "#app/touch-controls";`,
  );
  mainSrc = mainSrc.replace(CALL_ANCHOR, `${CALL_ANCHOR}\nenableTouchControlsOnQuadrupleTap();`);

  writeFile(MAIN_PATH, mainSrc);
}

console.log("enable-touch-controls-quad-tap applied successfully.");
