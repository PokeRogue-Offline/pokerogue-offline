#!/usr/bin/env node
/**
 * Patch: screenshot-button.js
 *
 * Adds a new touch-control button ("apadScreenshot") that takes a clean
 * screenshot of the game (no D-pad/action buttons in it) and saves it into
 * a "PKROffline" photo album via @capacitor-community/media. Mobile only
 * (Android + iOS) - the button only exists in the DOM at all on these
 * builds, since this patch lives under patches/mobile/node/.
 *
 * Unlike the existing D-pad/apad-button elements, the new button has no
 * data-key attribute - it isn't a game-button mapping, so
 * TouchControl.init() (src/touch-controls.ts) never touches it; it gets its
 * own independent touchstart listener instead.
 *
 * Sub-patches, applied in order:
 *
 *   0. src/system/offline/screenshot-saver.ts (new file)
 *        Copies in the capture/hide/restore/save logic, same convention as
 *        update-check.js's update-check-api.ts sub-patch.
 *
 *   1. index.html
 *        Injects the button markup as a sibling of #apadMenu inside
 *        #control-group-extra-1, reusing its existing apad-button/
 *        apad-rectangle/apad-small styling - no new CSS needed.
 *
 *   2. src/touch-controls.ts
 *        Adds wireScreenshotButton(), exported alongside isMobile()/
 *        preventDoubleTapZoom(), wiring a touchstart listener on the new
 *        button to #system/offline/screenshot-saver's
 *        captureAndSaveScreenshot() (which does its own isCapacitor() check
 *        internally - no gating needed here).
 *
 *   3. main.ts
 *        Calls wireScreenshotButton() once at startup. Depends on
 *        enable-touch-controls-quad-tap.js having already run (guaranteed by
 *        apply-patches.sh's fixed order: that "all"-platform patch runs
 *        before this mobile-only one) - this sub-patch's anchor is the exact
 *        import line that patch leaves behind.
 *
 * NOTE ON TESTING: anchors below were confirmed against a fresh clone of
 * pagefaultgames/pokerogue at the time this was written. In-app behavior
 * (does the save actually land in a "PKROffline" album on a real device,
 * does the permission prompt behave as expected) has NOT been verified in a
 * running build - do that before shipping.
 *
 * Targets: pokerogue-src/index.html
 *          pokerogue-src/src/touch-controls.ts
 *          pokerogue-src/src/main.ts
 *          pokerogue-src/src/system/offline/screenshot-saver.ts (new file)
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

// This patch script lives at patches/mobile/node/screenshot-button.js in the
// pkr-offline repo. The new source file it writes is checked into this same
// repo (under new-files/) so this script and its payload stay together.
const NEW_FILES_DIR = path.join(__dirname, "..", "..", "..", "new-files");

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 0: src/system/offline/screenshot-saver.ts (new file)
// ─────────────────────────────────────────────────────────────────────────────

const SAVER_PATH = path.join("pokerogue-src", "src", "system", "offline", "screenshot-saver.ts");
if (fs.existsSync(SAVER_PATH)) {
  console.log("SKIP screenshot-saver.ts — already exists");
} else {
  const saverSrc = fs.readFileSync(
    path.join(NEW_FILES_DIR, "src", "system", "offline", "screenshot-saver.ts"),
    "utf8",
  );
  writeFile(SAVER_PATH, saverSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 1: index.html  →  inject the button markup
// ─────────────────────────────────────────────────────────────────────────────

const HTML_PATH = path.join("pokerogue-src", "index.html");
let htmlSrc = readFile(HTML_PATH);

if (htmlSrc.includes("apadScreenshot")) {
  console.log("SKIP index.html — apadScreenshot already present");
} else {
  const MENU_BUTTON_ANCHOR =
    `\t\t\t\t<!-- main menu button -->\n` +
    `\t\t\t\t<div id="apadMenu" class="apad-button apad-rectangle apad-small" data-key="MENU">\n` +
    `\t\t\t\t\t<span class="apad-label">Menu</span>\n` +
    `\t\t\t\t</div>`;
  requireAnchor(htmlSrc, MENU_BUTTON_ANCHOR, "#apadMenu button block in index.html");

  const SCREENSHOT_BUTTON =
    `\n\t\t\t\t<!-- screenshot button: no data-key - not a game-button mapping, see touch-controls.ts -->\n` +
    `\t\t\t\t<div id="apadScreenshot" class="apad-button apad-rectangle apad-small">\n` +
    `\t\t\t\t\t<span class="apad-label">📷</span>\n` +
    `\t\t\t\t</div>`;

  htmlSrc = htmlSrc.replace(MENU_BUTTON_ANCHOR, `${MENU_BUTTON_ANCHOR}${SCREENSHOT_BUTTON}`);
  writeFile(HTML_PATH, htmlSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 2: src/touch-controls.ts  →  add wireScreenshotButton()
// ─────────────────────────────────────────────────────────────────────────────

const TOUCH_CONTROLS_PATH = path.join("pokerogue-src", "src", "touch-controls.ts");
let touchControlsSrc = readFile(TOUCH_CONTROLS_PATH);

if (touchControlsSrc.includes("wireScreenshotButton")) {
  console.log("SKIP touch-controls.ts — wireScreenshotButton already present");
} else {
  const IMPORT_ANCHOR = `import { globalScene } from "#app/global-scene";`;
  requireAnchor(touchControlsSrc, IMPORT_ANCHOR, "globalScene import in touch-controls.ts");
  touchControlsSrc = touchControlsSrc.replace(
    IMPORT_ANCHOR,
    `${IMPORT_ANCHOR}\nimport { captureAndSaveScreenshot } from "#system/offline/screenshot-saver";`,
  );

  // Same reusable anchor enable-touch-controls-quad-tap.js anchors on - each
  // patch that injects a new exported function here re-appends this exact
  // text at the end of its own injection, so it stays available for the
  // next patch to anchor on too, regardless of application order.
  const ANCHOR = "export function isMobile(): boolean {";
  requireAnchor(touchControlsSrc, ANCHOR, "isMobile() function in touch-controls.ts");

  const INJECTION = `/**
 * Wires the screenshot touch-control button's tap handler. Intended to be
 * called once at startup. The button only exists in the DOM on mobile
 * builds (see screenshot-button.js), and captureAndSaveScreenshot() itself
 * no-ops on non-Capacitor platforms, so no isCapacitor() gate is needed here.
 */
export function wireScreenshotButton(): void {
  const button = document.getElementById("apadScreenshot");
  console.log(\`[touch-controls] wireScreenshotButton(): button element \${button ? "found" : "NOT FOUND"}\`);
  button?.addEventListener(
    "touchstart",
    (event: TouchEvent) => {
      console.log("[touch-controls] apadScreenshot touchstart fired");
      event.preventDefault();
      captureAndSaveScreenshot();
    },
    { passive: false },
  );
}

${ANCHOR}`;

  touchControlsSrc = touchControlsSrc.replace(ANCHOR, INJECTION);
  writeFile(TOUCH_CONTROLS_PATH, touchControlsSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 3: main.ts  →  call wireScreenshotButton() at startup
// ─────────────────────────────────────────────────────────────────────────────

const MAIN_PATH = path.join("pokerogue-src", "src", "main.ts");
let mainSrc = readFile(MAIN_PATH);

if (mainSrc.includes("wireScreenshotButton")) {
  console.log("SKIP main.ts — wireScreenshotButton already present");
} else {
  // Depends on enable-touch-controls-quad-tap.js (all-platform) having
  // already rewritten this import line - guaranteed by apply-patches.sh's
  // fixed order (that patch runs before any mobile-only one).
  const IMPORT_ANCHOR = `import { enableTouchControlsOnQuadrupleTap, isMobile, preventDoubleTapZoom } from "#app/touch-controls";`;
  requireAnchor(mainSrc, IMPORT_ANCHOR, "touch-controls import in main.ts (after enable-touch-controls-quad-tap.js)");

  const CALL_ANCHOR = "preventDoubleTapZoom();";
  requireAnchor(mainSrc, CALL_ANCHOR, "preventDoubleTapZoom() call in main.ts");

  mainSrc = mainSrc.replace(
    IMPORT_ANCHOR,
    `import { enableTouchControlsOnQuadrupleTap, isMobile, preventDoubleTapZoom, wireScreenshotButton } from "#app/touch-controls";`,
  );
  mainSrc = mainSrc.replace(CALL_ANCHOR, `${CALL_ANCHOR}\nwireScreenshotButton();`);

  writeFile(MAIN_PATH, mainSrc);
}

console.log("screenshot-button applied successfully.");
