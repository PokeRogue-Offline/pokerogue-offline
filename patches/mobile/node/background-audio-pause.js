#!/usr/bin/env node
/**
 * Patch: background-audio-pause.js
 *
 * Pauses music (BGM) when the app is backgrounded on iOS/Android, and resumes
 * it when the app returns to the foreground.
 *
 * Problem:
 *   The game sets `pauseOnBlur` based on `isMobile()` (a user-agent check,
 *   true even for a Capacitor WebView), but on mobile that still isn't
 *   enough — backgrounding the app fires the standard `visibilitychange`
 *   event (document.hidden = true), not necessarily a window blur, so
 *   Phaser's own pauseOnBlur handling doesn't reliably catch it.
 *
 * Solution:
 *   Listen for `visibilitychange` on the document and call
 *   `audioManager.pauseBgm()` / `audioManager.resumeBgm()` accordingly. Those
 *   two methods don't exist upstream (only `fadeOutBgm()`, which destroys the
 *   track, and a private `replaceBgmUntilEnd()`-internal pause/resume) so
 *   sub-patch 1 adds them to `#audio/audio-manager.ts`, mirroring
 *   `fadeOutBgm()`'s existing shape — thin wrappers around
 *   `BackgroundMusic#pause()`/`#resume()`, which already exist and are used
 *   internally by `replaceBgmUntilEnd()`. The listener is only registered on
 *   Capacitor native platforms — desktop/web behaviour is unchanged.
 *
 * Targets: pokerogue-src/src/audio/audio-manager.ts
 *          pokerogue-src/src/main.ts
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
// Sub-patch 1: src/audio/audio-manager.ts  →  add pauseBgm()/resumeBgm()
// ─────────────────────────────────────────────────────────────────────────────

const AUDIO_MANAGER_PATH = path.join("pokerogue-src", "src", "audio", "audio-manager.ts");
let audioManagerSrc = readFile(AUDIO_MANAGER_PATH);

if (audioManagerSrc.includes("public pauseBgm")) {
  console.log("SKIP audio-manager.ts — pauseBgm/resumeBgm already present");
} else {
  const FADE_OUT_ANCHOR = `  public fadeOutBgm(duration = 500, fixed = false, destroy = true): void {
    this.currentBgm?.fadeOut(duration, fixed, destroy);
    if (destroy) {
      this.currentBgm = null;
    }
  }`;
  requireAnchor(audioManagerSrc, FADE_OUT_ANCHOR, "fadeOutBgm() method in audio-manager.ts");
  audioManagerSrc = audioManagerSrc.replace(
    FADE_OUT_ANCHOR,
    `${FADE_OUT_ANCHOR}\n\n` +
      `  /** background-audio-pause: pause the current bgm without destroying it (e.g. app backgrounded). */\n` +
      `  public pauseBgm(): void {\n` +
      `    this.currentBgm?.pause();\n` +
      `  }\n\n` +
      `  /** background-audio-pause: resume a bgm previously paused via {@linkcode pauseBgm}. */\n` +
      `  public resumeBgm(): void {\n` +
      `    this.currentBgm?.resume();\n` +
      `  }`,
  );

  writeFile(AUDIO_MANAGER_PATH, audioManagerSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 2: src/main.ts  →  pause/resume bgm on visibilitychange
// ─────────────────────────────────────────────────────────────────────────────

const MAIN_PATH = path.join("pokerogue-src", "src", "main.ts");
let mainSrc = readFile(MAIN_PATH);

if (mainSrc.includes("background-audio-pause")) {
  console.log("SKIP main.ts — background audio pause already present");
} else {
  // Upstream now sets pauseOnBlur based on isMobile() rather than hardcoding
  // false, but that alone isn't reliable for backgrounding (see doc comment
  // above) — this patch still installs its own Capacitor-gated
  // visibilitychange listener on top.
  const ANCHOR = `  game.sound.pauseOnBlur = isMobile();
}`;
  requireAnchor(mainSrc, ANCHOR, "pauseOnBlur assignment in main.ts");

  const IMPORT_ANCHOR = `import { isBeta, isDev } from "#constants/app-constants";`;
  requireAnchor(mainSrc, IMPORT_ANCHOR, "app-constants import in main.ts");
  if (!mainSrc.includes(`from "#app/global-audio-manager"`)) {
    mainSrc = mainSrc.replace(
      IMPORT_ANCHOR,
      `${IMPORT_ANCHOR}\nimport { audioManager } from "#app/global-audio-manager";`,
    );
  }

  const INJECTION = `  game.sound.pauseOnBlur = isMobile();

  // background-audio-pause: pause BGM when the app is backgrounded on mobile.
  // Only active on Capacitor native platforms — desktop/web is unchanged.
  const cap = (window as any).Capacitor;
  if (cap?.isNativePlatform?.()) {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        audioManager.pauseBgm();
      } else {
        audioManager.resumeBgm();
      }
    });
  }
}`;

  mainSrc = mainSrc.replace(ANCHOR, INJECTION);

  writeFile(MAIN_PATH, mainSrc);
}

console.log("Background audio pause applied successfully.");
