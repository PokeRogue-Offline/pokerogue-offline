#!/bin/bash
set -e
# apply-patches.sh — pre-build patches
#
# Usage:
#   ./apply-patches.sh            # all platforms (default)
#   ./apply-patches.sh mobile     # all + mobile (iOS + Android)
#   ./apply-patches.sh android    # all + mobile + android

PLATFORM="${1:-all}"

# Kill-switch for the memory-usage project (prune-stale-pokemon-assets.js,
# prune-stale-move-anim-assets.js, skip-legacy-ui-duplicate-textures.js). Set
# to "false" - either by editing this line or by exporting
# MEMORY_PATCHES_ENABLED=false before running this script - to skip all three
# without deleting anything, e.g. if they're not ready yet for a given
# upstream release. Leaves app-settings-menu.js's "Aggressive Memory Saving"
# toggle row in place either way (harmless no-op UI row when these patches
# themselves are skipped).
MEMORY_PATCHES_ENABLED="${MEMORY_PATCHES_ENABLED:-true}"

source "$(dirname "$0")/patch-lib.sh"

# ── All platforms ─────────────────────────────────────────────────────────────

# Offline client modifications
apply_patch "fix-daily-seed.js"       all
apply_patch "fix-continue-last-slot.js" all
apply_patch "offline-banner.js"       all
apply_patch "update-check.js"         all
apply_patch "update-title-labels.js"  all

apply_patch "app-settings-menu.js"            all
if [[ "$MEMORY_PATCHES_ENABLED" == "true" ]]; then
  apply_patch "prune-stale-pokemon-assets.js" all
  apply_patch "prune-stale-move-anim-assets.js" all
fi
# Stopgap for pagefaultgames/pokerogue#7819 (closed, deferred to the Phaser 4
# rewrite). Remove this line once that rewrite ships the fix upstream.
apply_patch "fix-stat-change-sprite-leak.js"  all
apply_patch "touch-overlay-idle-opacity.js"   all
apply_patch "damage-preview.js"               all
apply_patch "auto-drive-sync.js"              all
apply_patch "externalize-capacitor-imports.js" all
apply_patch "gacha-calendar.js"               all
apply_patch "community-menu.js"               all
apply_patch "enable-touch-controls-quad-tap.js" all

apply_patch "update-available-screen.js" all
# Copies in #system/offline/mobile-updater.ts and #ui/mobile-update-overlay.ts
# and wires their runtime-gated (Capacitor.isNativePlatform()) hooks into
# main.ts/title-ui-handler.ts, for ALL platforms, not just mobile - needed so
# that update-available-ui-handler.ts (an all-platforms file) can statically
# reference them without breaking desktop's bundling (Rolldown resolves
# every static/dynamic import specifier at build time regardless of runtime
# guards - see externalize-capacitor-imports.js's doc comment for the same
# constraint hitting Capacitor npm packages). Every exported function in
# both files already no-ops on non-Capacitor platforms.
apply_patch "mobile-ota-updater.js"      all

# ── Mobile (iOS + Android) ────────────────────────────────────────────────────
if [[ "$PLATFORM" == "mobile" || "$PLATFORM" == "android" ]]; then

  # Targeted Patches
  apply_patch "native-save-io.js"            mobile
  apply_patch "background-audio-pause.js"    mobile
  apply_patch "screenshot-button.js"         mobile
  if [[ "$MEMORY_PATCHES_ENABLED" == "true" ]]; then
    apply_patch "skip-legacy-ui-duplicate-textures.js" mobile
  fi
fi

# ── Android only ──────────────────────────────────────────────────────────────
if [[ "$PLATFORM" == "android" ]]; then

  apply_patch "fix-android-image-paths.js"  android

fi

echo "All patches applied successfully (platform: $PLATFORM)."
