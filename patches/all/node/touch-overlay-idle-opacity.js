#!/usr/bin/env node
/**
 * Patch: touch-overlay-idle-opacity.js
 *
 * Makes the on-screen D-pad/action buttons' resting (non-pressed) opacity
 * configurable instead of hardcoded, so the new "Touch Button Opacity"
 * setting (patches/all/node/app-settings-menu.js) has something to actually
 * apply. Upstream's index.css hardcodes both `#dpad` and `.apad-button` to
 * `opacity: 0.8`, unrelated to the existing `--touch-control-opacity` CSS
 * var (0.6) — that one only governs the brief pressed/active-state flash
 * (`#touchControls .active` / `#configToolbar .button:active`), not the
 * buttons' persistent on-screen visibility.
 *
 * This patch introduces a second, separate CSS var
 * (`--touch-control-idle-opacity`, default 0.8 — matching the previous
 * hardcoded value exactly, so this is a no-op visually until the new
 * setting is changed) and points both elements at it instead.
 *
 * Sub-patches, applied in order:
 *
 *   1. index.css
 *        Declare --touch-control-idle-opacity: 0.8 in the #touchControls
 *        block, alongside the existing --touch-control-opacity.
 *
 *   2. index.css
 *        #dpad: opacity: 0.8 → opacity: var(--touch-control-idle-opacity)
 *
 *   3. index.css
 *        .apad-button: opacity: 0.8 → opacity: var(--touch-control-idle-opacity)
 *
 * NOTE ON TESTING: anchors below were confirmed against a fresh clone of
 * pagefaultgames/pokerogue at the time this was written. Visual verification
 * (does cycling the new setting actually change on-device button opacity)
 * has NOT been done in a running build — do that before shipping.
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

const CSS_PATH = path.join("pokerogue-src", "index.css");
let cssSrc = readFile(CSS_PATH);

if (cssSrc.includes("--touch-control-idle-opacity")) {
  console.log("SKIP index.css — --touch-control-idle-opacity already present");
} else {
  // Sub-patch 1: declare the new CSS var next to --touch-control-opacity.
  const VAR_ANCHOR = "--touch-control-opacity: 0.6;";
  requireAnchor(cssSrc, VAR_ANCHOR, "--touch-control-opacity declaration in index.css");
  cssSrc = cssSrc.replace(VAR_ANCHOR, `${VAR_ANCHOR}\n  --touch-control-idle-opacity: 0.8;`);

  // Sub-patch 2: #dpad's hardcoded idle opacity → the new var.
  const DPAD_ANCHOR = `#dpad {
  z-index: 3;
  opacity: 0.8;
}`;
  requireAnchor(cssSrc, DPAD_ANCHOR, "#dpad rule in index.css");
  cssSrc = cssSrc.replace(
    DPAD_ANCHOR,
    `#dpad {
  z-index: 3;
  opacity: var(--touch-control-idle-opacity);
}`,
  );

  // Sub-patch 3: .apad-button's hardcoded idle opacity → the new var.
  const APAD_BUTTON_ANCHOR = `.apad-button {
  background-color: var(--color-base);
  border-radius: 50%;
  display: flex;
  justify-content: center;
  align-items: center;
  right: 0;
  bottom: 0;
  width: var(--controls-size);
  height: var(--controls-size);
  opacity: 0.8;
  border-radius: 8px;
}`;
  requireAnchor(cssSrc, APAD_BUTTON_ANCHOR, ".apad-button rule in index.css");
  cssSrc = cssSrc.replace(
    APAD_BUTTON_ANCHOR,
    `.apad-button {
  background-color: var(--color-base);
  border-radius: 50%;
  display: flex;
  justify-content: center;
  align-items: center;
  right: 0;
  bottom: 0;
  width: var(--controls-size);
  height: var(--controls-size);
  opacity: var(--touch-control-idle-opacity);
  border-radius: 8px;
}`,
  );

  writeFile(CSS_PATH, cssSrc);
}

console.log("touch-overlay-idle-opacity patch applied successfully.");
