#!/usr/bin/env node
/**
 * Patch: gacha-calendar.js
 *
 * Adds a "Gacha Calendar" entry to the pause menu, directly under
 * "Egg Gacha". Opens a new offline-only screen that shows which species
 * is boosted in the Legendary gacha for any day of the currently viewed
 * month.
 *
 * This is a read-only info screen: it does not touch save data, gameplay
 * mechanics, or the egg-pulling flow itself. Every date shown reuses the
 * REAL `getLegendaryGachaSpeciesForTimestamp` export from `src/data/egg.ts`
 * (already parameterized by timestamp - no RNG/day-cycle logic is
 * reimplemented anywhere in this patch), and every timestamp constructed by
 * the new screen is built with `Date.UTC(...)`, matching how that function
 * itself treats its input (plain UTC-day math, no timezone adjustment).
 *
 * Sub-patches, applied in order:
 *
 *   1. src/enums/ui-mode.ts
 *        Append GACHA_CALENDAR (after ALERT_MODAL, the last entry).
 *
 *   2. src/ui/handlers/gacha-calendar-ui-handler.ts  (new file)
 *        The calendar screen itself. Copied verbatim from new-files/.
 *
 *   3. src/ui/ui.ts
 *        Import GachaCalendarUiHandler, register at the position matching
 *        UiMode.GACHA_CALENDAR (end of the handlers array, since
 *        GACHA_CALENDAR is the last UiMode entry), add to noTransitionModes.
 *
 *   4. src/ui/handlers/menu-ui-handler.ts
 *        - Append MenuOptions.GACHA_CALENDAR directly after EGG_GACHA.
 *        - Special-case its label to the hardcoded string "Gacha Calendar"
 *          instead of routing through i18next (same reasoning as the
 *          "Offline" settings tab: this is an offline-client-only feature,
 *          not present in the real locale files).
 *        - Add a switch-case that opens UiMode.GACHA_CALENDAR.
 *        - Add MenuOptions.GACHA_CALENDAR to the same two exclusion lists
 *          that already exclude MenuOptions.EGG_GACHA (title/command screen,
 *          and mid-battle SelectModifierPhase), so it's only ever offered
 *          in the same contexts Egg Gacha itself is offered in.
 *
 * NOTE ON TESTING: anchors below were confirmed against a fresh clone of
 * pagefaultgames/pokerogue at the time this was written. The new handler's
 * runtime behavior (grid layout, cursor math, month rollover) has NOT been
 * verified in an actual build yet - do that before shipping.
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

// This patch script lives at patches/all/node/gacha-calendar.js in the
// pkr-offline repo. The new source file it writes is checked into this
// same repo (under new-files/) so this script and its payload stay together.
const NEW_FILES_DIR = path.join(__dirname, "..", "..", "..", "new-files");

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 1: src/enums/ui-mode.ts  →  append GACHA_CALENDAR
// ─────────────────────────────────────────────────────────────────────────────

const UI_MODE_PATH = path.join("pokerogue-src", "src", "enums", "ui-mode.ts");
let uiModeSrc = readFile(UI_MODE_PATH);

if (uiModeSrc.includes("GACHA_CALENDAR")) {
  console.log("SKIP ui-mode.ts — GACHA_CALENDAR already present");
} else {
  const ANCHOR = "ALERT_MODAL,";
  requireAnchor(uiModeSrc, ANCHOR, "ALERT_MODAL in ui-mode.ts");
  uiModeSrc = uiModeSrc.replace(ANCHOR, `${ANCHOR}\n  GACHA_CALENDAR,`);
  writeFile(UI_MODE_PATH, uiModeSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 2: src/ui/handlers/gacha-calendar-ui-handler.ts  (new file)
// ─────────────────────────────────────────────────────────────────────────────

const HANDLER_PATH = path.join("pokerogue-src", "src", "ui", "handlers", "gacha-calendar-ui-handler.ts");

if (fs.existsSync(HANDLER_PATH)) {
  console.log("SKIP gacha-calendar-ui-handler.ts — already exists");
} else {
  const src = fs.readFileSync(
    path.join(NEW_FILES_DIR, "src", "ui", "handlers", "gacha-calendar-ui-handler.ts"),
    "utf8",
  );
  writeFile(HANDLER_PATH, src);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 3: src/ui/ui.ts  →  import + register + noTransitionModes
// ─────────────────────────────────────────────────────────────────────────────

const UI_PATH = path.join("pokerogue-src", "src", "ui", "ui.ts");
let uiSrc = readFile(UI_PATH);

if (uiSrc.includes("GachaCalendarUiHandler")) {
  console.log("SKIP ui.ts — GachaCalendarUiHandler already present");
} else {
  // Import line is inserted in alphabetical order (biome organizeImports),
  // which is independent from the handlers array below - that array's
  // order is NOT stylistic, it's a functional requirement (see next comment).
  const IMPORT_ANCHOR = `import { FightUiHandler } from "#ui/fight-ui-handler";`;
  requireAnchor(uiSrc, IMPORT_ANCHOR, "FightUiHandler import in ui.ts");
  uiSrc = uiSrc.replace(
    IMPORT_ANCHOR,
    `${IMPORT_ANCHOR}\nimport { GachaCalendarUiHandler } from "#ui/gacha-calendar-ui-handler";`,
  );

  // Ui.getHandler() does `this.handlers[this.mode]` - the handlers array is
  // indexed positionally by UiMode's numeric enum value, NOT looked up by
  // type. Since GACHA_CALENDAR is appended as the LAST UiMode entry, its
  // handler instance MUST also be the last element of this array, matching
  // enum order exactly - not alphabetical, not import order.
  const HANDLER_ANCHOR = `new AlertModalUiHandler(),`;
  requireAnchor(uiSrc, HANDLER_ANCHOR, "new AlertModalUiHandler() in ui.ts");
  uiSrc = uiSrc.replace(HANDLER_ANCHOR, `${HANDLER_ANCHOR}\n      new GachaCalendarUiHandler(),`);

  const NO_TRANSITION_ANCHOR = `UiMode.ALERT_MODAL,`;
  requireAnchor(uiSrc, NO_TRANSITION_ANCHOR, "UiMode.ALERT_MODAL in noTransitionModes");
  uiSrc = uiSrc.replace(NO_TRANSITION_ANCHOR, `${NO_TRANSITION_ANCHOR}\n  UiMode.GACHA_CALENDAR,`);

  writeFile(UI_PATH, uiSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-patch 4: src/ui/handlers/menu-ui-handler.ts
// ─────────────────────────────────────────────────────────────────────────────

const MENU_PATH = path.join("pokerogue-src", "src", "ui", "handlers", "menu-ui-handler.ts");
let menuSrc = readFile(MENU_PATH);

if (menuSrc.includes("GACHA_CALENDAR")) {
  console.log("SKIP menu-ui-handler.ts — GACHA_CALENDAR already present");
} else {
  // 4a. MenuOptions enum — insert right after EGG_GACHA.
  const ENUM_ANCHOR = `  EGG_GACHA,\n  POKEDEX,`;
  requireAnchor(menuSrc, ENUM_ANCHOR, "EGG_GACHA in MenuOptions enum");
  menuSrc = menuSrc.replace(ENUM_ANCHOR, `  EGG_GACHA,\n  GACHA_CALENDAR,\n  POKEDEX,`);

  // 4b. Label rendering — special-case GACHA_CALENDAR to a hardcoded label
  //     instead of an i18next lookup (offline-client-only feature, same
  //     reasoning as the "Offline" settings tab label). Upstream now builds
  //     the options array via a per-option .map() (returning {label, handler,
  //     keepOpen}) instead of joining one big label string, so we special-case
  //     the `label:` field of that map instead.
  const LABEL_ANCHOR =
    `      return {\n` +
    `        label: \`\${i18next.t(\`menuUiHandler:\${toCamelCase(MenuOptions[option])}\`)}\`,\n` +
    `        handler: () => this.optionSelected(option),\n` +
    `        keepOpen: true,\n` +
    `      };`;
  requireAnchor(menuSrc, LABEL_ANCHOR, "menuOptions label map in menu-ui-handler.ts");
  menuSrc = menuSrc.replace(
    LABEL_ANCHOR,
    `      return {\n` +
      `        label:\n` +
      `          option === MenuOptions.GACHA_CALENDAR\n` +
      `            ? "Gacha Calendar"\n` +
      `            : \`\${i18next.t(\`menuUiHandler:\${toCamelCase(MenuOptions[option])}\`)}\`,\n` +
      `        handler: () => this.optionSelected(option),\n` +
      `        keepOpen: true,\n` +
      `      };`,
  );

  // 4c. Switch-case — open the new screen, same pattern as EGG_GACHA.
  const CASE_ANCHOR = `      case MenuOptions.EGG_GACHA:
        ui.revertMode();
        ui.setOverlayMode(UiMode.EGG_GACHA);
        success = true;
        break;`;
  requireAnchor(menuSrc, CASE_ANCHOR, "MenuOptions.EGG_GACHA switch-case in menu-ui-handler.ts");
  menuSrc = menuSrc.replace(
    CASE_ANCHOR,
    `${CASE_ANCHOR}
      case MenuOptions.GACHA_CALENDAR:
        ui.revertMode();
        ui.setOverlayMode(UiMode.GACHA_CALENDAR);
        success = true;
        break;`,
  );

  // 4d. Exclusion list — hide it in the same contexts EGG_GACHA is hidden in.
  // (Upstream now has a single excludedMenus entry covering EGG_GACHA/EGG_LIST;
  // the separate title/command-screen exclusion list from earlier versions of
  // this patch no longer exists.)
  const EXCLUSION_ANCHOR = `options: [MenuOptions.EGG_GACHA, MenuOptions.EGG_LIST],`;
  requireAnchor(menuSrc, EXCLUSION_ANCHOR, "constructor excludedMenus in menu-ui-handler.ts");
  menuSrc = menuSrc.replace(
    EXCLUSION_ANCHOR,
    `options: [MenuOptions.EGG_GACHA, MenuOptions.EGG_LIST, MenuOptions.GACHA_CALENDAR],`,
  );

  writeFile(MENU_PATH, menuSrc);
}

console.log("\ngacha-calendar patch applied successfully.");
