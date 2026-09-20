<?php
$pageTitle = "iOS Install Guide — SideStore & LiveContainer | PokéRogue Offline";
$activeNav = 'install';
include __DIR__ . '/partials/head.php';
?>

  <div class="page-header">
    <p class="page-eyebrow">iOS Installation Guide</p>
    <h1 class="page-title">SideStore &amp; <span>LiveContainer</span></h1>
    <p class="page-subtitle">
      Unlimited sideloading on iOS — no jailbreak, no 3-app limit, no computer needed after first setup.
    </p>
    <a href="/install-ios.php" class="back-link">← Back to Install Options</a>
  </div>

  <div class="divider"><span class="divider-icon">✦</span></div>

  <div class="guide-body">

    <!-- REQUIREMENTS -->
    <div>
      <div class="req-box">
        <h3>Requirements</h3>
        <ul class="req-list">
          <li><strong>Device:</strong> iPhone or iPad running iOS / iPadOS 15.0 or higher, <strong>with a passcode set.</strong> <a href="https://support.apple.com/en-us/119586" target="_blank">How to set a passcode →</a></li>
          <li><strong>Computer:</strong> macOS, Windows, or Linux — needed only for the first install.</li>
          <li><strong>Apple ID:</strong> A standard (free) Apple ID. No developer account required.</li>
          <li><strong>Wi-Fi:</strong> Your computer and iPhone must be on the same network.</li>
          <li><strong>App Store app:</strong> Download <a href="https://apps.apple.com/app/localdevvpn/id6755608044" target="_blank">LocalDevVPN</a> from the App Store before you begin.</li>
        </ul>
      </div>
    </div>

    <!-- STEP 1 -->
    <div class="guide-step">
      <div class="step-header">
        <span class="step-num">Step 01</span>
        <h2 class="step-title">Device Preparation — LocalDevVPN</h2>
      </div>
      <div class="step-body">
        <p>
          SideStore needs a special loopback VPN tunnel running on the device to re-sign apps wirelessly.
          The SideStore team built <strong>LocalDevVPN</strong> specifically for this purpose.
        </p>

        <div class="callout warning">
          <span class="callout-icon">⚠️</span>
          <span><strong>A passcode is required.</strong> iOS will refuse to install a VPN profile on a device without a passcode. Make sure yours is set before continuing.</span>
        </div>

        <div class="steps">
          <div class="step-row"><span class="step-n">1</span><span>Download <a href="https://apps.apple.com/app/localdevvpn/id6755608044" target="_blank">LocalDevVPN</a> from the App Store.</span></div>
          <div class="step-row"><span class="step-n">2</span><span>Open the app and tap <strong>Connect</strong>. When prompted to "Allow VPN Configurations," tap <strong>Allow</strong> and enter your passcode.</span></div>
          </div>

        <div class="callout info">
          <span class="callout-icon">ℹ️</span>
          <span>You must have LocalDevVPN <strong>connected</strong> every time you want to install, update, or refresh apps in SideStore. It doesn't affect your internet connection — it only opens a local tunnel to the signing server.</span>
        </div>
      </div>
    </div>

    <!-- STEP 2 -->
    <div class="guide-step">
      <div class="step-header">
        <span class="step-num">Step 02</span>
        <h2 class="step-title">Install iLoader on Your Computer</h2>
      </div>
      <div class="step-body">
        <p>
          <a href="https://iloader.app/" target="_blank">iLoader</a> is a cross-platform sideloader used to install SideStore (and LiveContainer) onto your device from a computer. Download the version for your OS below.
        </p>

        <!-- OS Tabs -->
        <div class="os-tabs" id="os-tabs">
          <button class="os-tab active" onclick="switchOS('macos')">macOS</button>
          <button class="os-tab" onclick="switchOS('windows')">Windows</button>
          <button class="os-tab" onclick="switchOS('linux')">Linux</button>
        </div>

        <div class="os-panel active" id="os-macos">
          <div class="steps">
          <div class="step-row"><span class="step-n">1</span><span><a href="https://github.com/nab138/iloader/releases/latest/download/iloader-darwin-universal.dmg" target="_blank">Download iLoader for macOS (.dmg)</a> and open the installer to install it.</span></div>
          </div>
        </div>

        <div class="os-panel" id="os-windows">
          <div class="callout warning">
            <span class="callout-icon">⚠️</span>
            <span><strong>32-bit Windows and Windows 10 on ARM are not supported.</strong> To check: press <code>Windows + R</code>, type <code>control /name microsoft.system</code>, and look for "System type." If it says "32-bit Operating System," iLoader won't run.</span>
          </div>
          <div class="steps">
          <div class="step-row"><span class="step-n">1</span><span>Install iTunes from the <a href="https://apps.microsoft.com/store/detail/9PB2MZ1ZMB1S" target="_blank">Microsoft Store</a> or <a href="https://www.apple.com/itunes/download/win64" target="_blank">directly from Apple</a>.</span></div>
          <div class="step-row"><span class="step-n">2</span><span>Download iLoader as an <a href="https://github.com/nab138/iloader/releases/latest/download/iloader-windows-x64.msi" target="_blank">MSI installer</a> (recommended) or <a href="https://github.com/nab138/iloader/releases/latest/download/iloader-windows-x64.exe" target="_blank">EXE</a>.</span></div>
          <div class="step-row"><span class="step-n">3</span><span>Run the installer.</span></div>
          </div>
        </div>

        <div class="os-panel" id="os-linux">
          <div class="callout warning">
            <span class="callout-icon">⚠️</span>
            <span><strong>Only 64-bit distributions are supported.</strong> Run <code>uname -m</code> in a terminal to check — expected output: <code>x86_64</code>.</span>
          </div>
          <div class="steps">
          <div class="step-row"><span class="step-n">1</span><span>Install the <code>usbmuxd</code> package via your package manager (it may already be installed).</span></div>
          <div class="step-row"><span class="step-n">2</span><span>Download and install iLoader for your distribution:
            <div style="margin-top:0.5rem; display:flex; flex-direction:column; gap:0.3rem; padding-left:0.25rem;">
              <span><a href="https://github.com/nab138/iloader/releases/latest/download/iloader-linux-amd64.deb" target="_blank">DEB</a> — Debian / Ubuntu</span>
              <span><a href="https://github.com/nab138/iloader/releases/latest/download/iloader-linux-x86_64.rpm" target="_blank">RPM</a> — Fedora / openSUSE</span>
              <span><a href="https://github.com/nab138/iloader/releases/latest/download/iloader-linux-amd64.AppImage" target="_blank">AppImage</a> — all other distros</span>
              <span><a href="https://aur.archlinux.org/packages/iloader-bin" target="_blank">AUR: <code>iloader-bin</code></a> — Arch Linux</span>
            </div>
          </span></div>
          </div>
        </div>

        <!-- Installing SideStore via iLoader -->
        <div class="sub-section">
          <p class="sub-section-title">Installing SideStore with iLoader</p>

          <div class="callout warning">
            <span class="callout-icon">⚠️</span>
            <span><strong>On a brand-new iOS version (like iOS 27)?</strong> SideStore's stable release can temporarily break right after a major iOS update until it's patched — this happened with several iOS 26.x releases. If the stable build fails to install, refresh, or sign, choose the <strong>Nightly</strong> build instead, or get it manually from the <a href="https://nightly.sidestore.io/" target="_blank">SideStore Nightly page</a>.</span>
          </div>

          <div class="steps">
          <div class="step-row"><span class="step-n">1</span><span>Connect your iPhone to the computer via USB. Tap <strong>Trust</strong> on the "Trust This Computer" prompt that appears on your device.</span></div>
          <div class="step-row"><span class="step-n">2</span><span>Launch iLoader and sign in with your Apple ID.</span></div>
          <div class="step-row"><span class="step-n">3</span><span>Select your iPhone from the device list.</span></div>
          </div>

          <div class="pro-tip">
            <strong>💡 Strongly Recommended: Install the Bundle</strong><br/>
            On the installation screen, choose <strong>LiveContainer + SideStore (Nightly)</strong> — the rightmost option — rather than SideStore alone.
            <br/><br/>
            This installs both SideStore and LiveContainer under a single app slot, saving one of your 3 free slots. LiveContainer then lets you run unlimited additional apps (like PokéRogue Offline) <em>inside</em> that single slot, with no signing required and no 7-day refresh needed for those inner apps.
          </div>

          <div class="steps">
          <div class="step-row"><span class="step-n">1</span><span>On the installation screen, select <strong>LiveContainer + SideStore (Nightly)</strong> and tap install.</span></div>
          <div class="step-row"><span class="step-n">2</span><span>Wait for the installation to complete, then disconnect the USB cable.</span></div>
          </div>
        </div>
      </div>
    </div>

    <!-- STEP 3 -->
    <div class="guide-step">
      <div class="step-header">
        <span class="step-num">Step 03</span>
        <h2 class="step-title">Device-Side Activation</h2>
      </div>
      <div class="step-body">
        <p>
          LiveContainer is now on your home screen, but it needs a few on-device steps to become fully operational. Work through these in order.
        </p>

        <div class="sub-section">
          <p class="sub-section-title">1 — Trust the Certificate</p>
          <div class="steps">
          <div class="step-row"><span class="step-n">1</span><span>Open <strong>Settings → General → VPN &amp; Device Management</strong>.</span></div>
          <div class="step-row"><span class="step-n">2</span><span>Tap your Apple ID under "Developer App" and tap <strong>Trust</strong>.</span></div>
          </div>
          <div class="callout warning" style="margin-top:1rem;">
            <span class="callout-icon">⚠️</span>
            <span>Make sure the Apple ID shown under "Developer App" <strong>matches the account you used in iLoader</strong>. If you see a different account, do not trust it — go back and reinstall using the correct Apple ID.</span>
          </div>
        </div>

        <div class="sub-section">
          <p class="sub-section-title">2 — Enable Developer Mode</p>
          <div class="steps">
          <div class="step-row"><span class="step-n">1</span><span>Go to <strong>Settings → Privacy &amp; Security</strong> and scroll to the bottom.</span></div>
          <div class="step-row"><span class="step-n">2</span><span>Toggle on <strong>Developer Mode</strong>. Your device will restart.</span></div>
          <div class="step-row"><span class="step-n">3</span><span>After rebooting, tap <strong>Turn On</strong> in the warning dialog and enter your passcode.</span></div>
          </div>
        </div>

        <div class="sub-section">
          <p class="sub-section-title">3 — Start the VPN Tunnel</p>
          <div class="steps">
          <div class="step-row"><span class="step-n">1</span><span>Open <strong>LocalDevVPN</strong> and tap <strong>Connect</strong>. You'll see a "VPN" indicator appear in your status bar when it's active.</span></div>
          </div>
          <div class="callout info">
            <span class="callout-icon">ℹ️</span>
            <span>This VPN only connects to your own device (localhost) — your internet connection is not affected, and no data is sent externally.</span>
          </div>
        </div>

        <div class="sub-section">
          <p class="sub-section-title">4 — Sign in to SideStore</p>
          <div class="steps">
          <div class="step-row"><span class="step-n">1</span><span>Open the <strong>SideStore</strong> button from within LiveContainer's top-left corner on the Apps page (or launch SideStore directly if it appears as a standalone icon).</span></div>
          <div class="step-row"><span class="step-n">2</span><span>Sign in with the <strong>same Apple ID</strong> you used in iLoader.</span></div>
          </div>
        </div>

        <div class="sub-section">
          <p class="sub-section-title">5 — Refresh Certificate from SideStore</p>
          <p>This step is required to generate a valid signing certificate on the device.</p>
          <div class="steps">
          <div class="step-row"><span class="step-n">1</span><span>In SideStore, go to the <strong>My Apps</strong> tab.</span></div>
          <div class="step-row"><span class="step-n">2</span><span>Tap the <strong>7 DAYS</strong> button next to LiveContainer to trigger a certificate refresh. If prompted to revoke an existing certificate and create a new one, tap <strong>Yes</strong> or <strong>Refresh Now</strong>.</span></div>
          <div class="step-row"><span class="step-n">3</span><span>Wait for SideStore to finish refreshing, then <strong>quit SideStore</strong> from the app switcher.</span></div>
          </div>
          <div class="callout info">
            <span class="callout-icon">ℹ️</span>
            <span>LocalDevVPN must remain connected during this step. If the refresh fails, make sure the VPN is active and try again.</span>
          </div>
        </div>

        <div class="sub-section">
          <p class="sub-section-title">6 — Import Certificate into LiveContainer &amp; Verify JIT-Less Mode</p>
          <p>Now link the certificate you just generated into LiveContainer so it can sign and run apps without using any additional app slots.</p>
          <div class="steps">
          <div class="step-row"><span class="step-n">1</span><span>Re-open <strong>LiveContainer</strong> (close it from the app switcher first, then relaunch it).</span></div>
          <div class="step-row"><span class="step-n">2</span><span>Go to <strong>Settings</strong> within LiveContainer.</span></div>
          <div class="step-row"><span class="step-n">3</span><span>Tap <strong>Import Certificate from SideStore</strong>, then tap <strong>OK</strong>. If the button changes to "Remove Certificate," the import succeeded.</span></div>
          <div class="step-row"><span class="step-n">4</span><span>Tap <strong>JIT-Less Mode Diagnose</strong>, then tap <strong>Test JIT-Less Mode</strong>. The test should pass — you'll see all indicators turn green.</span></div>
          </div>

          <div class="callout tip">
            <span class="callout-icon">✅</span>
            <span>A passing JIT-Less Mode Diagnose means LiveContainer can sign and launch apps using your SideStore certificate automatically. You should see "App Group Accessible: Yes" and a valid "Certificate Last Update Date." If anything is red, ensure both LiveContainer and SideStore were installed using the same Apple ID, then repeat the refresh and import steps above.</span>
          </div>

          <div class="callout info">
            <span class="callout-icon">ℹ️</span>
            <span><strong>About pairing files:</strong> If you update or reset your device, your pairing file may expire. You'll need to reconnect to a computer and re-run iLoader to generate a new one.</span>
          </div>
        </div>

      </div>
    </div>

    <div class="divider"><span class="divider-icon">✦</span></div>

    <!-- INSTALL POKEROGUE -->
    <div class="guide-step">
      <div class="step-header">
        <span class="step-num">Done</span>
        <h2 class="step-title">Install PokéRogue Offline</h2>
      </div>
      <div class="step-body">
        <p>
          With LiveContainer fully set up, installing PokéRogue Offline is simple — and it won't count against your 3-app slot limit.
        </p>
        <div class="steps">
          <div class="step-row"><span class="step-n">1</span><span>Download <a href="https://github.com/PokeRogue-Offline/pokerogue-offline/releases/latest" target="_blank"><code>PokeRogueOffline.ipa</code></a> to your iPhone via Safari or the Files app.</span></div>
          <div class="step-row"><span class="step-n">2</span><span>Open <strong>LiveContainer</strong> and tap <strong>+</strong> in the top right.</span></div>
          <div class="step-row"><span class="step-n">3</span><span>Select the <code>PokeRogueOffline.ipa</code> file.</span></div>
          <div class="step-row"><span class="step-n">4</span><span>Tap the app icon inside LiveContainer to launch — no signing step needed.</span></div>
          </div>

        <div class="callout tip">
          <span class="callout-icon">✦</span>
          <span><strong>Ongoing maintenance:</strong> Every 7 days, open LocalDevVPN, connect, then open SideStore and tap <strong>Refresh All</strong>. This refreshes the LiveContainer certificate — any apps running inside it (including PokéRogue Offline) are renewed automatically.</span>
        </div>
      </div>
    </div>

  </div><!-- /guide-body -->

  <script>
    function switchOS(os) {
      document.querySelectorAll('.os-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.os-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('os-' + os).classList.add('active');
      event.currentTarget.classList.add('active');
    }
  </script>

<?php
$footerExtra = 'This guide is adapted from <a href="https://fr0stb1rd.gitlab.io/posts/ios-26-unlimited-sideload-sidestore-livecontainer/" target="_blank"><em>Unlimited Sideload Infrastructure on iOS 26.2.1: SideStore and LiveContainer (Nightly)</em></a>
    by <a href="https://twitter.com/fr0stb1rd" target="_blank">fr0stb1rd</a>, licensed under
    <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank">CC BY 4.0</a>.
    Changes were made: rewritten for PokéRogue Offline, restructured into dedicated sections, and expanded Step 3 with SideStore certificate refresh and JIT-Less Mode Diagnose instructions.';
$footerLinks = false;
include __DIR__ . '/partials/footer.php';
?>
