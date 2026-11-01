#!/usr/bin/env node
/**
 * Copyright (c) 2026 Scooom. All rights reserved.
 *
 * This file is not licensed for reuse, redistribution, or inclusion in
 * other projects, forked or otherwise. Contact via Discord (scooom) for
 * permission requests.
 */
/**
 * Patch: fix-continue-last-slot.js
 *
 * Makes the title screen's "Continue" option resume the most recently
 * played save slot, instead of always resuming the lowest-numbered slot
 * that merely has any data in it.
 *
 * Problem:
 *   In account.ts's updateUserInfo(), the bypassLogin (offline) branch scans
 *   slots 0-4 and sets loggedInUser.lastSessionSlot to the FIRST slot it
 *   finds with any save data, then breaks. Nothing else updates that field
 *   while offline, so "Continue" always loads that same slot forever, even
 *   after a different slot becomes the one actually being played.
 *
 * Fix:
 *   Every saved session already carries a numeric `timestamp` field
 *   (game-data.ts stamps it with Date.now() on every save). Scan all slots
 *   and keep the one with the highest timestamp instead of stopping at the
 *   first populated slot. Decoding is inlined as base64 rather than
 *   importing the shared decrypt() helper, since decrypt() degrades to
 *   plain base64 whenever bypassLogin is true anyway - this is the only
 *   branch this code ever runs in.
 *
 * Uses a regex anchor so minor upstream changes don't break the match.
 *
 * Targets: pokerogue-src/src/account.ts
 */

const fs = require("fs");
const path = require("path");

const TARGET = path.join("pokerogue-src", "src", "account.ts");

if (!fs.existsSync(TARGET)) {
  console.error(`ERROR: Could not find target file: ${TARGET}`);
  process.exit(1);
}

let src = fs.readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n");

if (src.includes("fix-continue-last-slot")) {
  console.log("Continue last-slot fix already present, skipping.");
  process.exit(0);
}

const SCAN_PATTERN =
  /([\t ]*)for \(let s = 0; s < 5; s\+\+\) \{\s*\n\s*if \(localStorage\.getItem\(getSessionDataLocalStorageKey\(s\)\)\) \{\s*\n\s*loggedInUser\.lastSessionSlot = s;\s*\n\s*break;\s*\n\s*\}\s*\n\s*\}/;

const scanMatch = src.match(SCAN_PATTERN);
if (!scanMatch) {
  console.error("ERROR: Could not find the last-session-slot scan loop in account.ts.");
  process.exit(1);
}

const i = scanMatch[1]; // indentation of the loop
const i2 = i + "  ";

const SCAN_REPLACEMENT = `${i}// fix-continue-last-slot: pick the slot with the newest saved timestamp,
${i}// not just the lowest-numbered populated slot.
${i}let mostRecentTimestamp = -1;
${i}for (let s = 0; s < 5; s++) {
${i2}const raw = localStorage.getItem(getSessionDataLocalStorageKey(s));
${i2}if (!raw) {
${i2}  continue;
${i2}}
${i2}let timestamp = 0;
${i2}try {
${i2}  const parsed = JSON.parse(decodeURIComponent(atob(raw)));
${i2}  if (typeof parsed?.timestamp === "number") {
${i2}    timestamp = parsed.timestamp;
${i2}  }
${i2}} catch {
${i2}  // Corrupted/unparseable slot data; treat as oldest rather than failing the scan.
${i2}}
${i2}if (timestamp > mostRecentTimestamp) {
${i2}  mostRecentTimestamp = timestamp;
${i2}  loggedInUser.lastSessionSlot = s;
${i2}}
${i}}`;

src = src.replace(scanMatch[0], SCAN_REPLACEMENT);

fs.writeFileSync(TARGET, src, "utf8");
console.log(`Patched continue last-slot logic in ${TARGET}`);
console.log("Continue last-slot fix applied successfully.");
