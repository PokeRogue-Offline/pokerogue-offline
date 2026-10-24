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
# skip-legacy-ui-duplicate-textures.js). Set to "false" - either by editing
# this line or by exporting MEMORY_PATCHES_ENABLED=false before running this
# script - to skip both without deleting anything, e.g. if they're not ready
# yet for a given upstream release. Leaves app-settings-menu.js's "Aggressive
# Memory Saving" toggle row in place either way (harmless no-op UI row when
# prune-stale-pokemon-assets.js itself is skipped).
MEMORY_PATCHES_ENABLED="${MEMORY_PATCHES_ENABLED:-true}"

source "$(dirname "$0")/patch-lib.sh"

# ── All platforms ─────────────────────────────────────────────────────────────

# Offline client modifications
apply_patch "fix-daily-seed.js"       all
apply_patch "offline-banner.js"       all
apply_patch "update-check.js"         all
apply_patch "update-title-labels.js"  all

apply_patch "app-settings-menu.js"            all
if [[ "$MEMORY_PATCHES_ENABLED" == "true" ]]; then
  apply_patch "prune-stale-pokemon-assets.js" all
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

# ── Mobile (iOS + Android) ────────────────────────────────────────────────────
if [[ "$PLATFORM" == "mobile" || "$PLATFORM" == "android" ]]; then

  # Targeted Patches
  apply_patch "native-save-io.js"            mobile
  apply_patch "background-audio-pause.js"    mobile
  if [[ "$MEMORY_PATCHES_ENABLED" == "true" ]]; then
    apply_patch "skip-legacy-ui-duplicate-textures.js" mobile
  fi
fi

# ── Android only ──────────────────────────────────────────────────────────────
if [[ "$PLATFORM" == "android" ]]; then

  apply_patch "fix-android-image-paths.js"  android

fi

echo "All patches applied successfully (platform: $PLATFORM)."
