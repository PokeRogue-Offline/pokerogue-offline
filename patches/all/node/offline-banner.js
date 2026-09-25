#!/usr/bin/env node
/**
 * Patch: offline-banner.js
 *
 * Appends an offline client identifier to the version string shown on the
 * title screen.
 *
 * Changes to src/ui/handlers/title-ui-handler.ts:
 *   1. Adds `isApp` to the import from "#constants/app-constants"
 *   2. Appends " - Unofficial Offline Client (Scooom) Build #<N>" to the
 *      version text when running as the Capacitor app (isApp === true).
 *
 * BUILD_NUMBER_PLACEHOLDER is substituted by the CI workflow via sed before
 * the Vite build runs.
 *
 * Targets: pokerogue-src/src/ui/handlers/title-ui-handler.ts
 */

const fs = require("fs");
const path = require("path");

const TARGET = path.join(
  "pokerogue-src",
  "src",
  "ui",
  "handlers",
  "title-ui-handler.ts"
);

if (!fs.existsSync(TARGET)) {
  console.error(`ERROR: Could not find target file: ${TARGET}`);
  process.exit(1);
}

let src = fs.readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n");

if (src.includes("offline-banner")) {
  console.log("Offline banner already present, skipping.");
  process.exit(0);
}

// ── Patch 1: add isApp to the app-constants import ───────────────────────────

const IMPORT_PATTERN = /(isBeta, isDev)( \})/;
const importMatch = src.match(IMPORT_PATTERN);

if (!importMatch) {
  console.error(
    "ERROR: Could not find 'isBeta, isDev' import in title-ui-handler.ts."
  );
  process.exit(1);
}

src = src.replace(IMPORT_PATTERN, "$1, isApp$2");

// ── Patch 2: append offline client string to the version text ────────────────

const VERSION_TEXT_PATTERN =
  /([ \t]*)this\.appVersionText\.setText\("v" \+ version \+ betaText\);/;
const versionMatch = src.match(VERSION_TEXT_PATTERN);

if (!versionMatch) {
  console.error(
    "ERROR: Could not find appVersionText.setText line in title-ui-handler.ts."
  );
  process.exit(1);
}

const indent = versionMatch[1];
const REPLACEMENT =
  `${indent}// offline-banner: append client label when running as Capacitor app.\n` +
  `${indent}const appText = isApp ? " - Unofficial Offline Client (Scooom) Build #BUILD_NUMBER_PLACEHOLDER" : "";\n` +
  `${indent}this.appVersionText.setText("v" + version + betaText + appText);`;

src = src.replace(versionMatch[0], REPLACEMENT);

fs.writeFileSync(TARGET, src, "utf8");
console.log(`Patched offline banner in ${TARGET}`);
console.log("Offline banner applied successfully.");
