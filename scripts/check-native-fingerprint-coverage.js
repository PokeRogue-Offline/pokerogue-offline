#!/usr/bin/env node
/**
 * check-native-fingerprint-coverage.js
 *
 * Fails when a file that can change the native shell is missing from
 * scripts/compute-native-fingerprint.js. Run in CI (.github/workflows/
 * checks.yml).
 *
 * The fingerprint decides whether a release may be delivered as an OTA
 * content update or needs a full reinstall. A native-touching file that is
 * not hashed means a native change can ship looking like a content-only
 * release, and clients would OTA web content onto a shell that does not
 * support it.
 *
 * For each platform, every candidate file must be either
 *   - listed in INPUTS[platform], or
 *   - listed in EXCLUDED[platform] with a reason.
 *
 * Candidates are:
 *   1. every file under the platform's native config directories, and
 *   2. every repo path the platform's build workflow references - so a new
 *      "cp configs/whatever into the native project" step is caught even
 *      when the file lives somewhere unexpected.
 *
 * It also checks that every package the mobile workflows install is
 * pinned through configs/capacitor-versions.env (which IS hashed), so
 * adding, removing or bumping a native plugin always moves the fingerprint.
 */

const fs = require("fs");
const path = require("path");

const { INPUTS, EXCLUDED, REPO_ROOT } = require("./compute-native-fingerprint.js");

/** Where each platform's native-touching files live, and which workflow builds it. */
const SCAN = {
  android: {
    roots: ["configs/android", "configs/capacitor-plugins", "patches/android"],
    files: ["configs/capacitor-versions.env"],
    workflows: [".github/workflows/build-android.yml"],
    pinnedInstalls: true,
  },
  ios: {
    roots: ["configs/ios", "configs/capacitor-plugins"],
    files: ["configs/capacitor-versions.env"],
    workflows: [".github/workflows/build-ios.yml"],
    pinnedInstalls: true,
  },
  desktop: {
    roots: ["configs/desktop"],
    files: [],
    workflows: [".github/workflows/build-exe.yml", ".github/workflows/build-appimage.yml", ".github/workflows/build-macos.yml"],
    pinnedInstalls: false,
  },
};

/** Repo paths a workflow can reference: anything under these top-level directories. */
const REFERENCE_PATTERN = /(?<![\w.-])((?:configs|patches|scripts|docs|new-files)\/[A-Za-z0-9_./-]*[A-Za-z0-9_-])/g;

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function walk(relDir, out) {
  const abs = path.join(REPO_ROOT, relDir);
  if (!fs.existsSync(abs)) {
    return;
  }
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(rel, out);
    } else {
      out.add(toPosix(rel));
    }
  }
}

function workflowReferences(workflowRelPath) {
  const abs = path.join(REPO_ROOT, workflowRelPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`workflow not found: ${workflowRelPath}`);
  }
  const refs = new Set();
  for (const match of fs.readFileSync(abs, "utf8").matchAll(REFERENCE_PATTERN)) {
    refs.add(match[1]);
  }
  return refs;
}

function isCovered(relPath, inputs, excluded) {
  if (inputs.has(relPath) || Object.hasOwn(excluded, relPath)) {
    return true;
  }
  return Object.keys(excluded).some(key => key.endsWith("/") && relPath.startsWith(key));
}

/** Candidate files for one platform (see the header comment). */
function collectCandidates(scan) {
  const candidates = new Set(scan.files);
  for (const root of scan.roots) {
    walk(root, candidates);
  }
  for (const workflow of scan.workflows) {
    for (const ref of workflowReferences(workflow)) {
      const abs = path.join(REPO_ROOT, ref);
      if (!fs.existsSync(abs)) {
        // Not a real path in this repo (e.g. docs/repo.json lives on another
        // branch, or the text only looked like a path).
        continue;
      }
      if (fs.statSync(abs).isDirectory()) {
        walk(ref, candidates);
      } else {
        candidates.add(ref);
      }
    }
  }
  return candidates;
}

/** Every `name@version` a workflow installs must take its version from capacitor-versions.env. */
function checkPinnedInstalls(workflowRelPath, problems) {
  const envPath = path.join(REPO_ROOT, "configs/capacitor-versions.env");
  const defined = new Set(
    fs
      .readFileSync(envPath, "utf8")
      .split("\n")
      .map(line => line.match(/^([A-Z0-9_]+)=/))
      .filter(Boolean)
      .map(match => match[1]),
  );
  const lines = fs.readFileSync(path.join(REPO_ROOT, workflowRelPath), "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (!/\bpnpm add\b/.test(line)) {
      continue;
    }
    for (const token of line.trim().split(/\s+/)) {
      const match = token.match(/^(@?[^@\s]+)@(.+)$/);
      if (!match || !/capacitor|capgo/.test(match[1])) {
        continue;
      }
      const variable = match[2].match(/^\$\{?([A-Z0-9_]+)\}?$/);
      if (!variable) {
        problems.push(`${workflowRelPath}:${index + 1}: "${token}" hardcodes its version - pin it through configs/capacitor-versions.env so it is part of the fingerprint.`);
      } else if (!defined.has(variable[1])) {
        problems.push(`${workflowRelPath}:${index + 1}: "${token}" uses ${variable[1]}, which configs/capacitor-versions.env does not define.`);
      }
    }
  }
}

function check() {
  const problems = [];

  for (const platform of Object.keys(INPUTS)) {
    const scan = SCAN[platform];
    if (!scan) {
      problems.push(`${platform}: no scan rules in check-native-fingerprint-coverage.js for this fingerprint platform.`);
      continue;
    }
    const inputs = new Set(INPUTS[platform]);
    const excluded = EXCLUDED[platform] || {};

    for (const relPath of inputs) {
      if (!fs.existsSync(path.join(REPO_ROOT, relPath))) {
        problems.push(`${platform}: INPUTS lists "${relPath}", which does not exist.`);
      }
      if (Object.hasOwn(excluded, relPath)) {
        problems.push(`${platform}: "${relPath}" is in both INPUTS and EXCLUDED.`);
      }
    }
    for (const [key, reason] of Object.entries(excluded)) {
      if (typeof reason !== "string" || reason.trim() === "") {
        problems.push(`${platform}: EXCLUDED entry "${key}" has no reason.`);
      }
      if (!fs.existsSync(path.join(REPO_ROOT, key))) {
        problems.push(`${platform}: EXCLUDED lists "${key}", which does not exist - remove the stale entry.`);
      }
    }

    for (const relPath of [...collectCandidates(scan)].sort()) {
      if (!isCovered(relPath, inputs, excluded)) {
        problems.push(
          `${platform}: "${relPath}" is not in the native fingerprint. Add it to INPUTS.${platform} in scripts/compute-native-fingerprint.js, ` +
            `or to EXCLUDED.${platform} with the reason it cannot affect the native shell.`,
        );
      }
    }

    if (scan.pinnedInstalls) {
      for (const workflow of scan.workflows) {
        checkPinnedInstalls(workflow, problems);
      }
    }
  }

  return problems;
}

function main() {
  const problems = check();
  if (problems.length > 0) {
    console.error(`Native fingerprint coverage check FAILED (${problems.length}):\n`);
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  console.log(`Native fingerprint coverage OK (${Object.keys(INPUTS).join(", ")}).`);
}

if (require.main === module) {
  main();
}

module.exports = { check, collectCandidates, isCovered, SCAN };
