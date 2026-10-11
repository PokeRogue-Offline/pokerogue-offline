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
 * ORDERING NOTE: patches/mobile/node/skip-legacy-ui-duplicate-textures.js
 * (part of the memory-usage project) normally runs before this one and adds
 * an `isLegacyThemeStored() &&` guard in front of the `folder.startsWith("ui")`
 * check in loadImage. But that patch - and its sibling
 * prune-stale-pokemon-assets.js - are both gated by apply-patches.sh's
 * MEMORY_PATCHES_ENABLED kill-switch, so loadImage may or may not have that
 * guard by the time this patch runs. This patch tries both shapes (with the
 * guard, and the plain upstream shape without it) so it works either way. If
 * either patch's shape of loadImage changes again, resync both variants here.
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

// ── loadImage: two possible pristine shapes, depending on whether
//    skip-legacy-ui-duplicate-textures.js (MEMORY_PATCHES_ENABLED) ran ──────

const LEGACY_GUARD_COMMENT =
  `    // Offline: skip the Legacy-theme duplicate unless the player has actually\n` +
  `    // opted into Legacy theme (mobile only - see skip-legacy-ui-duplicate-\n` +
  `    // textures.js header for the "switching themes needs a restart" tradeoff,\n` +
  `    // and why this reads localStorage directly instead of \`settings\`).\n`;

const LOAD_IMAGE_WITH_MEMORY_PATCH = `  public loadImage(key: string, folder: string, filename = \`\${key}.png\`): this {
    const eventReplacment = timedEventManager.getEventImageReplacement(key);
    if (eventReplacment) {
      folder = "events";
      filename = \`\${eventReplacment}.png\`;
    }
    this.load.image(key, getCachedUrl(\`images/\${folder}/\${filename}\`));
${LEGACY_GUARD_COMMENT}    if (isLegacyThemeStored() && folder.startsWith("ui")) {
      folder = folder.replace("ui", "ui/legacy");
      this.load.image(\`\${key}_legacy\`, getCachedUrl(\`images/\${folder}/\${filename}\`));
    }
    return this;
  }`;

const LOAD_IMAGE_WITH_MEMORY_PATCH_REPLACEMENT = `  public loadImage(key: string, folder: string, filename = \`\${key}.png\`): this {
    const eventReplacment = timedEventManager.getEventImageReplacement(key);
    if (eventReplacment) {
      folder = "events";
      filename = \`\${eventReplacment}.png\`;
    }
    // fix-android-image-paths: avoid double slash when folder is empty
    const imgPath = (f: string) => \`images/\${f ? \`\${f}/\` : ""}\${filename}\`;
    this.load.image(key, getCachedUrl(imgPath(folder)));
${LEGACY_GUARD_COMMENT}    if (isLegacyThemeStored() && folder.startsWith("ui")) {
      folder = folder.replace("ui", "ui/legacy");
      this.load.image(\`\${key}_legacy\`, getCachedUrl(imgPath(folder)));
    }
    return this;
  }`;

const LOAD_IMAGE_PRISTINE = `  public loadImage(key: string, folder: string, filename = \`\${key}.png\`): this {
    const eventReplacment = timedEventManager.getEventImageReplacement(key);
    if (eventReplacment) {
      folder = "events";
      filename = \`\${eventReplacment}.png\`;
    }
    this.load.image(key, getCachedUrl(\`images/\${folder}/\${filename}\`));
    if (folder.startsWith("ui")) {
      folder = folder.replace("ui", "ui/legacy");
      this.load.image(\`\${key}_legacy\`, getCachedUrl(\`images/\${folder}/\${filename}\`));
    }
    return this;
  }`;

const LOAD_IMAGE_PRISTINE_REPLACEMENT = `  public loadImage(key: string, folder: string, filename = \`\${key}.png\`): this {
    const eventReplacment = timedEventManager.getEventImageReplacement(key);
    if (eventReplacment) {
      folder = "events";
      filename = \`\${eventReplacment}.png\`;
    }
    // fix-android-image-paths: avoid double slash when folder is empty
    const imgPath = (f: string) => \`images/\${f ? \`\${f}/\` : ""}\${filename}\`;
    this.load.image(key, getCachedUrl(imgPath(folder)));
    if (folder.startsWith("ui")) {
      folder = folder.replace("ui", "ui/legacy");
      this.load.image(\`\${key}_legacy\`, getCachedUrl(imgPath(folder)));
    }
    return this;
  }`;

// ── Apply ─────────────────────────────────────────────────────────────────────

if (src.includes(LOAD_IMAGE_WITH_MEMORY_PATCH)) {
  src = src.replace(LOAD_IMAGE_WITH_MEMORY_PATCH, LOAD_IMAGE_WITH_MEMORY_PATCH_REPLACEMENT);
} else if (src.includes(LOAD_IMAGE_PRISTINE)) {
  src = src.replace(LOAD_IMAGE_PRISTINE, LOAD_IMAGE_PRISTINE_REPLACEMENT);
} else {
  console.error("ERROR: Could not find loadImage pattern in scene-base.ts (checked both with and without");
  console.error("skip-legacy-ui-duplicate-textures.js's guard).");
  console.error("The file may have been updated upstream. Manual inspection required.");
  process.exit(1);
}

fs.writeFileSync(TARGET, src, "utf8");
console.log(`Patched loadImage in ${TARGET}`);
console.log("Android image path fix applied successfully.");
