#!/usr/bin/env node
/**
 * Copyright (c) 2026 Scooom. All rights reserved.
 *
 * This file is not licensed for reuse, redistribution, or inclusion in
 * other projects, forked or otherwise. Contact via Discord (scooom) for
 * permission requests.
 */
/**
 * Patch: fix-daily-seed.js
 *
 * Makes the offline daily run use the same seed as the live website.
 *
 * Problem:
 *   When bypassLogin is true (offline mode), title-phase.ts generates a seed
 *   from the local date. This differs from the server's curated seed.
 *
 * Fix:
 *   Intercept the Daily Run option handler (before save slot selection) to
 *   fetch the seed from GitHub Pages. The seed is cached in localStorage
 *   keyed by UTC date so subsequent attempts that day skip the fetch.
 *   The fetch time is also cached (daily_seed_fetched_at, epoch ms) purely
 *   for display in the Offline settings screen — not read by this patch.
 *
 *   On fetch failure, show a confirm dialog. The user is still on the title
 *   screen at this point so No simply closes the overlay cleanly.
 *
 *   initDailyRun's else-branch is also patched to read from localStorage
 *   so the cached seed flows through naturally.
 *
 * Uses regex anchors so minor upstream changes don't break the match.
 *
 * Targets: pokerogue-src/src/phases/title-phase.ts
 */

const fs = require("fs");
const path = require("path");


const TARGET = path.join("pokerogue-src", "src", "phases", "title-phase.ts");

if (!fs.existsSync(TARGET)) {
  console.error(`ERROR: Could not find target file: ${TARGET}`);
  process.exit(1);
}

let src = fs.readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n");


if (src.includes("fix-daily-seed")) {
  console.log("Daily seed fix already present, skipping.");
  process.exit(0);
}

// ── Patch 1: intercept the Daily Run option handler ───────────────────────────
// Replace the simple `this.initDailyRun()` call with a fetch-first flow.

const HANDLER_PATTERN = /([\t ]*)newGameOptions\.push\(\{\s*\n\s*label: i18next\.t\(\"menu:dailyRun\"\),\s*\n\s*handler: \(\) => \{\s*\n\s*this\.initDailyRun\(\);\s*\n\s*return true;\s*\n\s*\},\s*\n\s*\}\);/;

const handlerMatch = src.match(HANDLER_PATTERN);
if (!handlerMatch) {
  console.error("ERROR: Could not find the Daily Run option handler in title-phase.ts.");
  process.exit(1);
}

const h = handlerMatch[1]; // indentation of the opening brace
const h2 = h + "  ";

const HANDLER_REPLACEMENT = `${h}newGameOptions.push({
${h2}label: i18next.t("menu:dailyRun"),
${h2}handler: () => {
${h2}  // fix-daily-seed: fetch seed before showing save slot picker so we stay
${h2}  // on the title screen and can cleanly cancel on failure.
${h2}  const todayUtc = new Date().toISOString().slice(0, 10);
${h2}  const cachedDate = localStorage.getItem("daily_seed_date");
${h2}  const cachedSeed = localStorage.getItem("daily_seed");
${h2}  if (cachedDate === todayUtc && cachedSeed) {
${h2}    this.initDailyRun();
${h2}  } else {
${h2}    globalScene.ui.revertMode();
${h2}    globalScene.ui.setMode(UiMode.MESSAGE);
${h2}    globalScene.ui.showText("Fetching daily seed...", null, null, null, true);
${h2}    fetch("https://pokerogue-offline.github.io/pokerogue-offline/daily-seed.txt")
${h2}      .then(r => {
${h2}        if (!r.ok) throw new Error(\`HTTP \${r.status}\`);
${h2}        return r.text();
${h2}      })
${h2}      .then(fetchedSeed => {
${h2}        const seed = fetchedSeed.trim();
${h2}        localStorage.setItem("daily_seed_date", todayUtc);
${h2}        localStorage.setItem("daily_seed", seed);
${h2}        localStorage.setItem("daily_seed_fetched_at", Date.now().toString());
${h2}        globalScene.ui.clearText();
${h2}        this.initDailyRun();
${h2}      })
${h2}      .catch(err => {
${h2}        globalScene.ui.showText("Could not reach the server. Play offline daily instead?", null, () => {
${h2}          globalScene.ui.setOverlayMode(
${h2}            UiMode.CONFIRM,
${h2}            () => {
${h2}              // Yes: proceed
${h2}              globalScene.ui.revertMode();
${h2}              globalScene.ui.clearText();
${h2}              this.initDailyRun();
${h2}            },
${h2}            () => {
${h2}              // No: restart title screen cleanly
${h2}              globalScene.ui.revertMode();
${h2}              globalScene.ui.clearText();
${h2}              globalScene.phaseManager.toTitleScreen();
${h2}              super.end();
${h2}              return true;
${h2}            },
${h2}            false,
${h2}            -98,
${h2}          );
${h2}        });
${h2}      });
${h2}  }
${h2}  return true;
${h2}},
${h}});`;

src = src.replace(handlerMatch[0], HANDLER_REPLACEMENT);

// ── Patch 2: read cached seed in initDailyRun's else-branch ──────────────────

const SEED_PATTERN = /([ \t]*\} else \{\n(?:[ \t]*\/\/[^\n]*\n)*[ \t]*let seed[^\n]*btoa\(new Date[\s\S]*?generateDaily\(seed\);\n[ \t]*\})/;

const seedMatch = src.match(SEED_PATTERN);
if (!seedMatch) {
  console.error("ERROR: Could not find the offline daily seed block in title-phase.ts.");
  process.exit(1);
}

const SEED_ORIGINAL = seedMatch[1];
const indent = SEED_ORIGINAL.match(/^([ \t]*)/)[1];
const i  = indent;
const i2 = i + "  ";

const SEED_REPLACEMENT = `${i}} else {
${i2}// fix-daily-seed: read the seed cached by the Daily Run option handler.
${i2}// Falls back to date-based seed if cache is somehow missing.
${i2}const fallbackSeed: string = btoa(new Date().toISOString().slice(0, 10));
${i2}let seed: string = localStorage.getItem("daily_seed") ?? fallbackSeed;
${i2}if (activeOverrides.DAILY_RUN_SEED_OVERRIDE != null) {
${i2}  seed =
${i2}    typeof activeOverrides.DAILY_RUN_SEED_OVERRIDE === "string"
${i2}      ? activeOverrides.DAILY_RUN_SEED_OVERRIDE
${i2}      : JSON.stringify(activeOverrides.DAILY_RUN_SEED_OVERRIDE);
${i2}}
${i2}generateDaily(seed);
${i}}`;

src = src.replace(SEED_ORIGINAL, SEED_REPLACEMENT);

fs.writeFileSync(TARGET, src, "utf8");
console.log(`Patched daily seed in ${TARGET}`);
console.log("Daily seed fix applied successfully.");
