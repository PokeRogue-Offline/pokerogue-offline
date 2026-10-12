#!/bin/bash
set -e
# apply-post-build-patches.sh — post-build patches (run after pnpm build, targeting dist/)
#
# Usage:
#   ./apply-post-build-patches.sh            # all platforms (default)
#   ./apply-post-build-patches.sh mobile     # all + mobile (iOS + Android)
#   ./apply-post-build-patches.sh android    # all + mobile + android

PLATFORM="${1:-all}"

source "$(dirname "$0")/patch-lib.sh"

# ── Mobile (iOS + Android) ────────────────────────────────────────────────────
if [[ "$PLATFORM" == "mobile" || "$PLATFORM" == "android" ]]; then

#  apply_patch "notch-fix.js"           mobile
  apply_patch "7728.patch"
  apply_patch "fix-browser.js"         mobile
#  apply_patch "canvas-scale-fix.js"    mobile

fi

# ── Android only ─────────────────────────────────────────────────────────────
if [[ "$PLATFORM" == "android" ]]; then

  apply_patch "android-trigger-axis-fix.js" android

fi

echo "All post-build patches applied successfully (platform: $PLATFORM)."
