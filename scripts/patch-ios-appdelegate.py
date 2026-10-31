#!/usr/bin/env python3
"""
patch-ios-appdelegate.py

`npx cap add ios` generates a fresh ios/App/App/AppDelegate.swift on every
build — same disposable-native-project pattern as Android's MainActivity.java
getting overwritten each run.

Sub-patches, applied in order:

  1. Google Sign-In needs the app to hand incoming URLs (the
     ASWebAuthenticationSession redirect back from Safari) to
     GIDSignIn.sharedInstance.handle(url); without this, the sign-in flow
     opens the browser but the redirect back into the app never completes
     the flow — which matches the "opens/flashes then just stops" symptom
     this fixes.
     Reference: https://capgo.app/docs/plugins/social-login/google/ios/
     ("Using Google Login on iOS" setup section)

  2. Native crashes (e.g. an uncaught NSException from a Capacitor plugin)
     show up in Settings > Privacy & Security > Analytics & Improvements >
     Analytics Data, but iOS deliberately strips the exception's `reason`
     string from that on-device report for privacy — exactly the detail
     needed to diagnose *why* something crashed. There's no device setting
     that restores it; the normal fix is symbolicating in Xcode on a Mac.
     Absent a Mac, this installs an NSSetUncaughtExceptionHandler at launch
     that writes the exception's name/reason/call stack to a
     last-crash.log file in the app's Documents folder — already exposed
     to the Files app via the existing UIFileSharingEnabled/
     LSSupportsOpeningDocumentsInPlace Info.plist keys (see
     configure-ios-infoplist.sh), so it's readable on-device with no Mac:
     Files app > On My iPhone > PokeRogue Offline (Dev).

Usage: python3 patch-ios-appdelegate.py <path-to-AppDelegate.swift>
"""

import sys

if len(sys.argv) != 2:
    print("Usage: patch-ios-appdelegate.py <path-to-AppDelegate.swift>", file=sys.stderr)
    sys.exit(1)

path = sys.argv[1]

with open(path) as f:
    content = f.read()

# ── Sub-patch 1: Google Sign-In URL handling ────────────────────────────────

if "GIDSignIn.sharedInstance.handle(url)" in content:
    print("SKIP AppDelegate.swift — Google Sign-In URL handling already present")
else:
    IMPORT_ANCHOR = "import Capacitor"
    if IMPORT_ANCHOR not in content:
        print("ERROR: could not find 'import Capacitor' in AppDelegate.swift.", file=sys.stderr)
        print("Capacitor's generated template may have changed — manual inspection required.", file=sys.stderr)
        sys.exit(1)
    content = content.replace(IMPORT_ANCHOR, f"{IMPORT_ANCHOR}\nimport GoogleSignIn", 1)

    # This exact line is Capacitor's current default body of application(_:open:options:)
    # — confirmed against ionic-team/capacitor's ios-pods-template as of writing.
    OLD_RETURN = "return ApplicationDelegateProxy.shared.application(app, open: url, options: options)"
    NEW_RETURN = (
        "if GIDSignIn.sharedInstance.handle(url) {\n"
        "            return true\n"
        "        }\n"
        "        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)"
    )

    if OLD_RETURN not in content:
        print("ERROR: could not find the application(open:) return line in AppDelegate.swift.", file=sys.stderr)
        print("Capacitor's generated template may have changed — manual inspection required.", file=sys.stderr)
        sys.exit(1)
    content = content.replace(OLD_RETURN, NEW_RETURN, 1)

# ── Sub-patch 2: on-device uncaught-exception logging ───────────────────────

if "pkrOfflineUncaughtExceptionHandler" in content:
    print("SKIP AppDelegate.swift — uncaught-exception logging already present")
else:
    # Anchored on the last import line, not the class declaration - the class
    # is preceded by an @UIApplicationMain/@main attribute, which must be
    # immediately followed by the class, so a free function can't be inserted
    # between them. Use "import GoogleSignIn" when sub-patch 1 added it above
    # (it's the later import in that case), else fall back to "import Capacitor".
    IMPORT_ANCHOR = "import GoogleSignIn" if "import GoogleSignIn" in content else "import Capacitor"
    if IMPORT_ANCHOR not in content:
        print("ERROR: could not find an import line in AppDelegate.swift.", file=sys.stderr)
        print("Capacitor's generated template may have changed — manual inspection required.", file=sys.stderr)
        sys.exit(1)

    HANDLER_FUNC = (
        "// Writes any uncaught NSException's name/reason/call stack to\n"
        "// Documents/last-crash.log, readable on-device via the Files app (no Mac\n"
        "// needed) - see the module doc comment above for why this exists.\n"
        "func pkrOfflineUncaughtExceptionHandler(_ exception: NSException) {\n"
        "    let report = \"\"\"\n"
        "    Time: \\(Date())\n"
        "    Name: \\(exception.name.rawValue)\n"
        "    Reason: \\(exception.reason ?? \"<none>\")\n"
        "    UserInfo: \\(exception.userInfo ?? [:])\n"
        "    Call stack:\n"
        "    \\(exception.callStackSymbols.joined(separator: \"\\n\"))\n"
        "    \"\"\"\n"
        "    guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {\n"
        "        return\n"
        "    }\n"
        "    try? report.write(to: documents.appendingPathComponent(\"last-crash.log\"), atomically: true, encoding: .utf8)\n"
        "}\n"
    )
    content = content.replace(IMPORT_ANCHOR, f"{IMPORT_ANCHOR}\n\n{HANDLER_FUNC}", 1)

    OLD_LAUNCH_RETURN = "        // Override point for customization after application launch.\n        return true"
    if OLD_LAUNCH_RETURN not in content:
        print("ERROR: could not find didFinishLaunchingWithOptions's default body.", file=sys.stderr)
        print("Capacitor's generated template may have changed — manual inspection required.", file=sys.stderr)
        sys.exit(1)
    NEW_LAUNCH_RETURN = (
        "        // Override point for customization after application launch.\n"
        "        NSSetUncaughtExceptionHandler(pkrOfflineUncaughtExceptionHandler)\n"
        "        return true"
    )
    content = content.replace(OLD_LAUNCH_RETURN, NEW_LAUNCH_RETURN, 1)

with open(path, "w") as f:
    f.write(content)

print(f"Patched {path}.")
