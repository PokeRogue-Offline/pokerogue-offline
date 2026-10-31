#!/bin/bash
set -e
# configure-ios-infoplist.sh <path-to-Info.plist>
#
# All of this repo's fixed Info.plist edits (status bar behavior, the .prsv
# document-type registration, and the Google/Dropbox URL-scheme entries),
# extracted out of build-ios.yml's inline PlistBuddy steps into one tracked
# file. This is a prerequisite for scripts/compute-native-fingerprint.js: a
# fingerprint can only see *files*, and before this extraction these edits
# lived only as workflow-YAML step bodies, invisible to any file-based hash -
# a native-shell-affecting change made purely in build-ios.yml would have
# silently bypassed the fingerprint entirely.
#
# GOOGLE_SCHEME and DROPBOX_SCHEME must be set in the environment by the
# caller (build-ios.yml resolves which dev/prod secret or app id to use
# before calling this script - that resolution stays in the workflow since
# it depends on GitHub Secrets, not something this script should read).

PLIST="$1"

if [ -z "$PLIST" ]; then
  echo "Usage: $0 <path-to-Info.plist>" >&2
  exit 1
fi
if [ -z "$GOOGLE_SCHEME" ] || [ -z "$DROPBOX_SCHEME" ]; then
  echo "ERROR: GOOGLE_SCHEME and DROPBOX_SCHEME must be set in the environment." >&2
  exit 1
fi

# ── Status bar / safe-area / misc app behavior ──────────────────────────────
/usr/libexec/PlistBuddy -c "Add :UIStatusBarHidden bool true" "$PLIST" || true
/usr/libexec/PlistBuddy -c "Add :UIViewControllerBasedStatusBarAppearance bool false" "$PLIST" || true
/usr/libexec/PlistBuddy -c "Add :UIRequiresFullScreen bool true" "$PLIST" || true
/usr/libexec/PlistBuddy -c "Set :LSApplicationCategoryType public.app-category.games" "$PLIST" || true
/usr/libexec/PlistBuddy -c "Add :LSApplicationCategoryType string public.app-category.games" "$PLIST" || true
/usr/libexec/PlistBuddy -c "Add :UIHomeIndicatorAutoHidden bool true" "$PLIST" || true
/usr/libexec/PlistBuddy -c "Add :NSDocumentsFolderUsageDescription string 'Required to save your exported game data file.'" "$PLIST" || true
/usr/libexec/PlistBuddy -c "Add :NSPhotoLibraryAddUsageDescription string 'Required to save your screenshots to Photos.'" "$PLIST" || true
/usr/libexec/PlistBuddy -c "Add :UIFileSharingEnabled bool true" "$PLIST" || true
/usr/libexec/PlistBuddy -c "Add :LSSupportsOpeningDocumentsInPlace bool true" "$PLIST" || true

# ── Register .prsv UTI so iOS preserves the save-data file extension ────────
/usr/libexec/PlistBuddy -c "Add :CFBundleDocumentTypes array" "$PLIST" || true
/usr/libexec/PlistBuddy -c "Add :CFBundleDocumentTypes:0 dict" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleDocumentTypes:0:CFBundleTypeName string PokéRogue Save Data" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes:0 string xyz.scooom.pkr.prsv" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleDocumentTypes:0:LSHandlerRank string Owner" "$PLIST"

/usr/libexec/PlistBuddy -c "Add :UTExportedTypeDeclarations array" "$PLIST" || true
/usr/libexec/PlistBuddy -c "Add :UTExportedTypeDeclarations:0 dict" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :UTExportedTypeDeclarations:0:UTTypeIdentifier string xyz.scooom.pkr.prsv" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :UTExportedTypeDeclarations:0:UTTypeDescription string PokéRogue Save Data" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :UTExportedTypeDeclarations:0:UTTypeConformsTo array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :UTExportedTypeDeclarations:0:UTTypeConformsTo:0 string public.data" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :UTExportedTypeDeclarations:0:UTTypeTagSpecification dict" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :UTExportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :UTExportedTypeDeclarations:0:UTTypeTagSpecification:public.filename-extension:0 string prsv" "$PLIST"

# ── Register Google Sign-In URL scheme ──────────────────────────────────────
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "$PLIST" || true
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0 dict" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string ${GOOGLE_SCHEME}" "$PLIST"

# ── Register Dropbox OAuth URL scheme ────────────────────────────────────────
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:1 dict" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:1:CFBundleURLSchemes array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:1:CFBundleURLSchemes:0 string ${DROPBOX_SCHEME}" "$PLIST"

echo "Configured Info.plist at $PLIST"
