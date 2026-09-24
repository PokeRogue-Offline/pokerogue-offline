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
 *   Gated two ways: (a) the listener callback resets and returns immediately
 *   whenever touch controls are already enabled — it only ever does
 *   anything while they're off; (b) the listener isn't installed at all
 *   unless running as the native mobile app (`isCapacitor()`, imported from
 *   backup-provider.ts — see app-settings-menu.js sub-patch 2, which this
 *   patch depends on having already run, per apply-patches.sh's existing
 *   order). Without (b) this would also fire on the Electron desktop builds
 *   (Windows/macOS/Linux AppImage), where re-enabling a touch overlay via a
 *   quadruple-tap gesture doesn't make sense.
 *
 * Sub-patches, applied in order:
 *
 *   1. src/touch-controls.ts
 *        Add `enableTouchControlsOnQuadrupleTap()`, exported alongside the
 *        existing `preventDoubleTapZoom()`; import `isCapacitor` from
 *        backup-provider.ts and gate the function body on it.
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
  const IMPORT_ANCHOR = `import { globalScene } from "#app/global-scene";`;
  requireAnchor(touchControlsSrc, IMPORT_ANCHOR, "globalScene import in touch-controls.ts");
  // Depends on app-settings-menu.js sub-patch 2 having already written
  // backup-provider.ts — guaranteed by apply-patches.sh's existing order.
  touchControlsSrc = touchControlsSrc.replace(
    IMPORT_ANCHOR,
    `${IMPORT_ANCHOR}\nimport { isCapacitor } from "#system/offline/backup-provider";`,
  );

  // hasTouchscreen used to be defined locally in this file (with a doc
  // comment we anchored on); it's now imported from #utils/app-utils, so we
  // anchor on isMobile() instead — a stable, unrelated function right below
  // where preventDoubleTapZoom() ends.
  const ANCHOR = "export function isMobile(): boolean {";
  requireAnchor(touchControlsSrc, ANCHOR, "isMobile() function in touch-controls.ts");

  const INJECTION = `const QUADRUPLE_TAP_THRESHOLD_MILLIS = 500;
const QUADRUPLE_TAP_COUNT = 4;

/**
 * Installs a single document-level listener that watches for 4 taps in quick succession
 * anywhere on the page and re-enables touch controls when it sees them. This gives players
 * who accidentally disable touch controls on a touchscreen device a way to turn them back on
 * without needing to navigate the settings menu. Intended to be called once at startup.
 *
 * No-op on non-native builds (Electron desktop) - the gesture only makes sense on the real
 * mobile app.
 */
export function enableTouchControlsOnQuadrupleTap(): void {
  if (!isCapacitor()) {
    return;
  }

  let tapTimestamps: number[] = [];

  document.addEventListener(
    "touchstart",
    (event: TouchEvent) => {
      if (settings.general.enableTouchControls || event.touches.length > 1) {
        tapTimestamps = [];
        return;
      }

      const now = event.timeStamp;
      tapTimestamps = tapTimestamps.filter(timestamp => now - timestamp <= QUADRUPLE_TAP_THRESHOLD_MILLIS);
      tapTimestamps.push(now);

      if (tapTimestamps.length >= QUADRUPLE_TAP_COUNT) {
        tapTimestamps = [];
        settings.update("general", "enableTouchControls", true);
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
  const IMPORT_ANCHOR = `import { isMobile, preventDoubleTapZoom } from "#app/touch-controls";`;
  requireAnchor(mainSrc, IMPORT_ANCHOR, "preventDoubleTapZoom import in main.ts");

  const CALL_ANCHOR = "preventDoubleTapZoom();";
  requireAnchor(mainSrc, CALL_ANCHOR, "preventDoubleTapZoom() call in main.ts");

  mainSrc = mainSrc.replace(
    IMPORT_ANCHOR,
    `import { enableTouchControlsOnQuadrupleTap, isMobile, preventDoubleTapZoom } from "#app/touch-controls";`,
  );
  mainSrc = mainSrc.replace(CALL_ANCHOR, `${CALL_ANCHOR}\nenableTouchControlsOnQuadrupleTap();`);

  writeFile(MAIN_PATH, mainSrc);
}

console.log("enable-touch-controls-quad-tap applied successfully.");
