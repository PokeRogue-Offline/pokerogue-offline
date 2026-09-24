#!/usr/bin/env node
/**
 * Patch: community-menu.js
 *
 * Adjusts the pause menu's "Community" submenu (src/ui/handlers/menu-ui-handler.ts)
 * for this fork:
 *   - REMOVED "Admin" — real-account admin tooling (ban/unban, link Discord,
 *     etc. against the pokerogue API) has no meaning for an offline client.
 *   - REMOVED "Donate" — points at pagefaultgames' own GitHub Sponsors page,
 *     not relevant to this fork.
 *   - ADDED "App GitHub" — opens this fork's own repo
 *     (github.com/PokeRogue-Offline/pokerogue-offline), placed right after
 *     the existing upstream "GitHub" entry so the two repo links sit
 *     together.
 *
 * Wiki/Discord/GitHub/Reddit and the Cancel entry are untouched.
 *
 * Targets: pokerogue-src/src/ui/handlers/menu-ui-handler.ts
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

const TARGET = path.join("pokerogue-src", "src", "ui", "handlers", "menu-ui-handler.ts");

let src = readFile(TARGET);

if (src.includes("App GitHub")) {
  console.log("Community menu already patched, skipping.");
  process.exit(0);
}

// ── Sub-patch 1: drop the now-unused AdminMode import ──────────────────────

const ADMIN_IMPORT_ANCHOR = `import { AdminMode, getAdminModeName } from "#enums/admin-mode";\n`;
requireAnchor(src, ADMIN_IMPORT_ANCHOR, "AdminMode import in menu-ui-handler.ts");
src = src.replace(ADMIN_IMPORT_ANCHOR, "");

// ── Sub-patch 2: communityOptions — insert "App GitHub" after "GitHub" ─────
// Upstream now uses build-time VITE_GITHUB_URL/VITE_DONATE_URL constants
// instead of local `githubUrl`/`donateUrl` consts, so there's nothing to add
// or remove at the top of the file any more — the App GitHub URL is just
// inlined directly in its own handler below.

const GITHUB_ENTRY_ANCHOR = `      {
        label: "GitHub",
        handler: () => {
          window.open(VITE_GITHUB_URL, "_blank")?.focus();
          return true;
        },
        keepOpen: true,
      },`;
requireAnchor(src, GITHUB_ENTRY_ANCHOR, "GitHub entry in communityOptions");
src = src.replace(
  GITHUB_ENTRY_ANCHOR,
  `${GITHUB_ENTRY_ANCHOR}
      {
        label: "App GitHub",
        handler: () => {
          window.open("https://github.com/PokeRogue-Offline/pokerogue-offline", "_blank")?.focus();
          return true;
        },
        keepOpen: true,
      },`,
);

// ── Sub-patch 3: communityOptions — remove "Donate" entry ──────────────────

const DONATE_ENTRY_ANCHOR = `      {
        label: i18next.t("menuUiHandler:donate"),
        handler: () => {
          window.open(VITE_DONATE_URL, "_blank")?.focus();
          return true;
        },
        keepOpen: true,
      },`;
requireAnchor(src, DONATE_ENTRY_ANCHOR, "Donate entry in communityOptions");
src = src.replace(`\n${DONATE_ENTRY_ANCHOR}`, "");

// ── Sub-patch 4: remove the whole conditional "Admin" push block ──────────

const ADMIN_BLOCK_ANCHOR = `    if (bypassLogin || loggedInUser?.hasAdminRole) {
      communityOptions.push({
        label: "Admin",
        handler: () => {
          // this is here so that we can skip the menu populating enums that aren't meant for the menu
          const skippedAdminModes: AdminMode[] = [AdminMode.ADMIN];
          const options: OptionSelectItem[] = [];
          Object.values(AdminMode)
            .filter(v => !skippedAdminModes.includes(v))
            .forEach(mode => {
              // this gets all the enums in a way we can use
              options.push({
                label: getAdminModeName(mode),
                handler: () => {
                  ui.playSelect();
                  ui.setOverlayMode(
                    UiMode.ADMIN,
                    {
                      buttonActions: [
                        // we double revert here and below to go back 2 layers of menus
                        () => {
                          ui.revertMode();
                          ui.revertMode();
                        },
                        () => {
                          ui.revertMode();
                          ui.revertMode();
                        },
                      ],
                    },
                    // mode is our AdminMode enum
                    mode,
                  );
                  return true;
                },
              });
            });
          options.push({
            label: "Cancel",
            handler: () => {
              ui.revertMode();
              return true;
            },
          });
          const yOffset = this.menuMessageBox.displayHeight + 1;
          const optionSelectConfig: OptionSelectModeConfig = { options, yOffset };
          globalScene.ui.setOverlayMode(UiMode.OPTION_SELECT, optionSelectConfig);
          return true;
        },
        keepOpen: true,
      });
    }
`;
requireAnchor(src, ADMIN_BLOCK_ANCHOR, "conditional Admin push block in menu-ui-handler.ts");
src = src.replace(ADMIN_BLOCK_ANCHOR, "");

writeFile(TARGET, src);
console.log("Community menu patch applied successfully.");
