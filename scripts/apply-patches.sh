#!/bin/bash
set -e
# apply-patches.sh — pre-build patches
#
# Usage:
#   ./apply-patches.sh            # all platforms (default)
#   ./apply-patches.sh mobile     # all + mobile (iOS + Android)
#   ./apply-patches.sh android    # all + mobile + android

PLATFORM="${1:-all}"

source "$(dirname "$0")/patch-lib.sh"

# ── All platforms ─────────────────────────────────────────────────────────────

# Offline client modifications
apply_patch "fix-daily-seed.js"       all
apply_patch "offline-banner.js"       all
apply_patch "update-check.js"         all
apply_patch "update-title-labels.js"  all

apply_patch "app-settings-menu.js"            all
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
fi

# ── Android only ──────────────────────────────────────────────────────────────
if [[ "$PLATFORM" == "android" ]]; then

  apply_patch "fix-android-image-paths.js"  android

fi

echo "All patches applied successfully (platform: $PLATFORM)."
