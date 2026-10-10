#!/usr/bin/env node
/**
 * Patch: fix-android-image-paths.js
 *
 * Fixes broken image loading on Android Capacitor builds where the title logo
 * (and any other root-level image) shows as a green box with a diagonal line.
 *
 * Root cause:
 *   loadImage("logo", "") builds a path like
 *   `images/${folder}/${filename}` — with an empty folder this produces
 *   "images//logo.png" (double slash).
 *
 *   The CacheBustedLoaderPlugin normalizes "//" → "/" only when a manifest
 *   exists. In an offline Capacitor build the manifest fetch may fail, leaving
 *   globalManifest undefined and the normalization branch skipped. Phaser then
 *   hands the raw "images//logo.png" URL to the WebView.
 *
 *   iOS WebViews silently collapse double slashes in local HTTP requests.
 *   Android WebViews do not — the asset 404s and Phaser renders its
 *   missing-texture placeholder (green box with a diagonal line).
 *
 * Fix:
 *   In loadImage, build the asset path through a helper
 *   that inserts the folder segment only when folder is non-empty, matching
 *   the pattern already used by loadAtlas.
 *
 * ORDERING NOTE: this patch is android-only and always runs after
 * patches/mobile/node/skip-legacy-ui-duplicate-textures.js (apply-patches.sh
 * always applies mobile before android), which adds a
 * `settings.isLegacyTheme &&` guard in front of the `folder.startsWith("ui")`
 * check in loadImage. The anchors below expect that guard to already be
 * present. If that patch's shape of loadImage changes, resync here too.
 *
 * Targets: pokerogue-src/src/scene-base.ts
 */

const fs = require("fs");
const path = require("path");

const TARGET = path.join("pokerogue-src", "src", "scene-base.ts");

if (!fs.existsSync(TARGET)) {
  console.error(`ERROR: Could not find target file: ${TARGET}`);
  console.error("Make sure this script is run from the repo root.");
  process.exit(1);
}

let src = fs.readFileSync(TARGET, "utf8");

if (src.includes("fix-android-image-paths")) {
  console.log("Android image path fix already present, skipping.");
  process.exit(0);
}

// ── loadImage ────────────────────────────────────────────────────────────────

const LOAD_IMAGE_ORIGINAL = `  public loadImage(key: string, folder: string, filename = \`\${key}.png\`): this {
    const eventReplacment = timedEventManager.getEventImageReplacement(key);
    if (eventReplacment) {
      folder = "events";
      filename = \`\${eventReplacment}.png\`;
    }
    this.load.image(key, getCachedUrl(\`images/\${folder}/\${filename}\`));
    // Offline: skip the Legacy-theme duplicate unless the player has actually
    // opted into Legacy theme (mobile only - see skip-legacy-ui-duplicate-
    // textures.js header for the "switching themes needs a restart" tradeoff).
    if (settings.isLegacyTheme && folder.startsWith("ui")) {
      folder = folder.replace("ui", "ui/legacy");
      this.load.image(\`\${key}_legacy\`, getCachedUrl(\`images/\${folder}/\${filename}\`));
    }
    return this;
  }`;

const LOAD_IMAGE_REPLACEMENT = `  public loadImage(key: string, folder: string, filename = \`\${key}.png\`): this {
    const eventReplacment = timedEventManager.getEventImageReplacement(key);
    if (eventReplacment) {
      folder = "events";
      filename = \`\${eventReplacment}.png\`;
    }
    // fix-android-image-paths: avoid double slash when folder is empty
    const imgPath = (f: string) => \`images/\${f ? \`\${f}/\` : ""}\${filename}\`;
    this.load.image(key, getCachedUrl(imgPath(folder)));
    // Offline: skip the Legacy-theme duplicate unless the player has actually
    // opted into Legacy theme (mobile only - see skip-legacy-ui-duplicate-
    // textures.js header for the "switching themes needs a restart" tradeoff).
    if (settings.isLegacyTheme && folder.startsWith("ui")) {
      folder = folder.replace("ui", "ui/legacy");
      this.load.image(\`\${key}_legacy\`, getCachedUrl(imgPath(folder)));
    }
    return this;
  }`;

// ── Apply ─────────────────────────────────────────────────────────────────────

if (!src.includes(LOAD_IMAGE_ORIGINAL)) {
  console.error("ERROR: Could not find loadImage pattern in scene-base.ts.");
  console.error("The file may have been updated upstream. Manual inspection required.");
  process.exit(1);
}

src = src.replace(LOAD_IMAGE_ORIGINAL, LOAD_IMAGE_REPLACEMENT);

fs.writeFileSync(TARGET, src, "utf8");
console.log(`Patched loadImage in ${TARGET}`);
console.log("Android image path fix applied successfully.");
