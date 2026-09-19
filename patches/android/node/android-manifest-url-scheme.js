#!/usr/bin/env node
/**
 * Patch: android-manifest-url-scheme.js
 *
 * Registers a custom URL scheme on MainActivity so Android can deliver the
 * Dropbox OAuth redirect back into the app (caught at runtime by
 * `@capacitor/app`'s `appUrlOpen` event — see
 * new-files/src/system/offline/dropbox-backup.ts). No equivalent scheme
 * registration existed in this repo before Dropbox support — Google's
 * OAuth flow never needed one, since it's handled entirely inside the
 * native SocialLogin SDK.
 *
 * The scheme is read from capacitor.config.json's `appId` at the repo root
 * (pokerogue-src/), NOT hardcoded — that file is already copied from either
 * capacitor.config.json (xyz.scooom.pkr) or capacitor.config-dev.json
 * (xyz.scooom.pkrdev) by the "Configure Capacitor" workflow step, which
 * runs before this patch. This must stay in sync with dropbox-backup.ts's
 * DROPBOX_REDIRECT_URI_PLACEHOLDER substitution in build-android.yml — both
 * derive from the same dev/prod split, but neither reads the other, so a
 * future change to one needs the other updated too.
 *
 * Fix:
 *   Adds a second <intent-filter> (VIEW/DEFAULT/BROWSABLE + a
 *   android:scheme data tag) to MainActivity's <activity> element, alongside
 *   its existing MAIN/LAUNCHER intent-filter — does not touch or replace
 *   that one. Also sets android:launchMode="singleTask" on MainActivity —
 *   without it, the system browser's redirect back into the app spawns a
 *   SECOND MainActivity instance, and `@capacitor/app`'s `appUrlOpen`
 *   listener (registered on the original instance, which is still sitting
 *   there awaiting the OAuth promise) never fires on it, so the sign-in flow
 *   hangs forever. This is Capacitor's own documented recommendation for
 *   deep-link handling, not specific to this patch.
 *
 * Targets: android/app/src/main/AndroidManifest.xml
 *   (located relative to the Capacitor project root, i.e. pokerogue-src/)
 */

const fs = require("fs");
const path = require("path");

const TARGET = path.join("android", "app", "src", "main", "AndroidManifest.xml");

if (!fs.existsSync(TARGET)) {
  console.error(`ERROR: Could not find target file: ${TARGET}`);
  console.error("Make sure 'npx cap add android' has been run before this patch.");
  process.exit(1);
}

let src = fs.readFileSync(TARGET, "utf8");

const CAPACITOR_CONFIG_PATH = "capacitor.config.json";
if (!fs.existsSync(CAPACITOR_CONFIG_PATH)) {
  console.error(`ERROR: Could not find ${CAPACITOR_CONFIG_PATH}`);
  console.error("Make sure the 'Configure Capacitor' step has run before this patch.");
  process.exit(1);
}
const { appId: SCHEME } = JSON.parse(fs.readFileSync(CAPACITOR_CONFIG_PATH, "utf8"));
if (!SCHEME) {
  console.error(`ERROR: ${CAPACITOR_CONFIG_PATH} has no "appId" field.`);
  process.exit(1);
}

if (src.includes(`android:scheme="${SCHEME}"`)) {
  console.log("Dropbox OAuth URL scheme already registered, skipping.");
  process.exit(0);
}

const ACTIVITY_ANCHOR = 'android:name=".MainActivity"';
if (!src.includes(ACTIVITY_ANCHOR)) {
  console.error(`ERROR: Could not find '${ACTIVITY_ANCHOR}' in ${TARGET}`);
  console.error("AndroidManifest.xml structure may have changed. Manual inspection required.");
  process.exit(1);
}

if (src.includes("launchMode")) {
  src = src.replace(/android:launchMode="[^"]*"/, 'android:launchMode="singleTask"');
} else {
  src = src.replace(ACTIVITY_ANCHOR, `${ACTIVITY_ANCHOR}\n            android:launchMode="singleTask"`);
}

// Capacitor's default template has exactly one <activity> (MainActivity),
// containing exactly one <intent-filter> (MAIN/LAUNCHER) followed directly
// by </activity>. Insert the new intent-filter right before that closing
// tag, leaving the existing one untouched.
const CLOSE_ACTIVITY_ANCHOR = "</activity>";
if (!src.includes(CLOSE_ACTIVITY_ANCHOR)) {
  console.error(`ERROR: Could not find '${CLOSE_ACTIVITY_ANCHOR}' in ${TARGET}`);
  console.error("AndroidManifest.xml structure may have changed. Manual inspection required.");
  process.exit(1);
}

const URL_SCHEME_INTENT_FILTER =
  "            <intent-filter>\n" +
  '                <action android:name="android.intent.action.VIEW" />\n' +
  '                <category android:name="android.intent.category.DEFAULT" />\n' +
  '                <category android:name="android.intent.category.BROWSABLE" />\n' +
  `                <data android:scheme="${SCHEME}" />\n` +
  "            </intent-filter>\n" +
  "        ";

src = src.replace(CLOSE_ACTIVITY_ANCHOR, `${URL_SCHEME_INTENT_FILTER}${CLOSE_ACTIVITY_ANCHOR}`);

fs.writeFileSync(TARGET, src, "utf8");
console.log(`Patched ${TARGET}`);
console.log("Dropbox OAuth URL scheme registered successfully.");
