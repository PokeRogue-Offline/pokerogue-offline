#!/usr/bin/env node
/**
 * Patch: externalize-capacitor-imports.js
 *
 * Fixes a real build break: `src/system/offline/google-drive-backup.ts` and
 * `src/system/offline/dropbox-backup.ts` each dynamically `import()` a
 * native-only Capacitor plugin (`@capgo/capacitor-social-login`,
 * `@capacitor/browser`, `@capacitor/app`) behind a runtime `isCapacitor()`
 * check — never reached outside a real Capacitor (Android/iOS) build.
 * Rolldown still tries to statically resolve every `import()` specifier at
 * build time regardless of the surrounding runtime guard, and those three
 * packages are only ever installed for the two mobile workflows (each
 * workflow's "Install Capacitor" step — the Electron/desktop workflows
 * never run it). Building for desktop therefore hard-fails with "Rolldown
 * failed to resolve import" unless these are explicitly externalized.
 *
 * Fix:
 *   Adds `rolldownOptions.external` to vite.config.ts, listing exactly those
 *   three packages — but ONLY when capacitor.config.json isn't present in
 *   the working directory. That file is written by every mobile workflow's
 *   "Configure Capacitor" step (and never by desktop's), so its presence is
 *   already the authoritative, pre-existing signal for "this is a Capacitor
 *   build" — no new env var or workflow wiring needed. On mobile, where
 *   these packages ARE actually installed and must be bundled for real
 *   (the Dropbox/Google sign-in flows genuinely run there), nothing is
 *   externalized and they build normally.
 *
 * Targets: vite.config.ts
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

const TARGET = path.join("pokerogue-src", "vite.config.ts");
let src = readFile(TARGET);

if (src.includes("CAPACITOR_ONLY_PACKAGES")) {
  console.log("Capacitor import externalization already present, skipping.");
  process.exit(0);
}

// ── Sub-patch 1: new import + module-scope constants ───────────────────────

const IMPORT_ANCHOR = `import { defineConfig, loadEnv, type PluginOption, type UserConfig, type UserConfigFnPromise } from "vite";\n`;
requireAnchor(src, IMPORT_ANCHOR, "vite import in vite.config.ts");
src = src.replace(
  IMPORT_ANCHOR,
  `import { existsSync } from "node:fs";\n` +
    IMPORT_ANCHOR +
    `\n` +
    `// Native-only Capacitor plugins, dynamically imported (never statically) from\n` +
    `// src/system/offline/{google-drive-backup,dropbox-backup}.ts, each behind a\n` +
    `// runtime isCapacitor() check that's only ever true inside a real Capacitor\n` +
    `// (Android/iOS) build. Not installed for Electron/desktop builds, so Rolldown\n` +
    `// can't resolve them there — externalize on desktop only. Mobile builds must\n` +
    `// NOT externalize these; they're genuinely bundled and used there.\n` +
    `const CAPACITOR_ONLY_PACKAGES = ["@capacitor/browser", "@capacitor/app", "@capgo/capacitor-social-login"];\n` +
    `// capacitor.config.json is written by every mobile workflow's "Configure\n` +
    `// Capacitor" step and never by desktop's — an already-existing, reliable\n` +
    `// signal for "this is a Capacitor build" with no new env var needed.\n` +
    `const isCapacitorBuild = existsSync("capacitor.config.json");\n`,
);

// ── Sub-patch 2: rolldownOptions.external ───────────────────────────────────

const ROLLDOWN_OPTIONS_ANCHOR = `      rolldownOptions: {\n        // TODO: Review if we even need this anymore in v8.0`;
requireAnchor(src, ROLLDOWN_OPTIONS_ANCHOR, "rolldownOptions block in vite.config.ts");
src = src.replace(
  ROLLDOWN_OPTIONS_ANCHOR,
  `      rolldownOptions: {\n` +
    // Empty array (not undefined) for the capacitor-build case — the project's
    // exactOptionalPropertyTypes: true rejects explicitly assigning undefined
    // to rolldownOptions.external; an empty array is functionally identical
    // (nothing externalized).
    `        external: isCapacitorBuild ? [] : CAPACITOR_ONLY_PACKAGES,\n` +
    `        // TODO: Review if we even need this anymore in v8.0`,
);

writeFile(TARGET, src);
console.log("Capacitor import externalization applied successfully.");
