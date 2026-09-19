<?php
$pageTitle = "Privacy Policy | PokéRogue Offline";
$activeNav = '';
include __DIR__ . '/partials/head.php';
?>

  <div class="page-header">
    <p class="page-eyebrow">Legal</p>
    <h1 class="page-title">Privacy <span>Policy</span></h1>
    <p class="page-subtitle">
      How PokéRogue Offline handles data in connection with Google Sign-In / Google Drive and Dropbox access.
    </p>
    <a href="/index.php" class="back-link">← Back to Home</a>
  </div>

  <div class="divider"><span class="divider-icon">✦</span></div>

  <div class="guide-body">

    <p class="updated-note">Last updated: 2026-09-19</p>

    <div style="margin-bottom:3rem;">
      <p class="step-body">
        PokéRogue-Offline is an unofficial, offline-capable wrapper for the game PokéRogue, distributed for
        desktop (Electron) and sideloaded mobile builds (Capacitor). This document describes how the app
        handles data in connection with Google Sign-In / Google Drive access and Dropbox access. You choose
        one provider to connect at a time under <strong>Settings → Offline</strong>; everything below applies
        equally to whichever one you use.
      </p>
    </div>

    <!-- 1 -->
    <div class="guide-step">
      <div class="step-header">
        <span class="step-num">01</span>
        <h2 class="step-title">What We Access</h2>
      </div>
      <div class="step-body">
        <p>
          For <strong>Google Drive</strong>, the app requests the <code>appdata</code> scope
          (<a href="https://www.googleapis.com/auth/drive.appdata" target="_blank">https://www.googleapis.com/auth/drive.appdata</a>) only.
          For <strong>Dropbox</strong>, the app is registered with "App folder" access, Dropbox's equivalent
          sandboxing mechanism. Both grant access exclusively to a single, hidden, application-specific folder
          in the user's account. Neither grants access to:
        </p>
        <ul class="req-list">
          <li>Any other files or folders in the user's Drive or Dropbox</li>
          <li>The user's Drive or Dropbox file listing</li>
          <li>Any other account data (contacts, mail, calendar, etc.)</li>
        </ul>
      </div>
    </div>

    <!-- 2 -->
    <div class="guide-step">
      <div class="step-header">
        <span class="step-num">02</span>
        <h2 class="step-title">What We Use It For</h2>
      </div>
      <div class="step-body">
        <p>
          The sole purpose of this access is to back up and restore the user's local game save file. When the
          user chooses to back up (manually, or automatically in the background every few waves once a provider
          is connected), the save file is uploaded to their own hidden app-only folder. When the user chooses to
          restore, the save file is downloaded from that same folder.
        </p>
      </div>
    </div>

    <!-- 3 -->
    <div class="guide-step">
      <div class="step-header">
        <span class="step-num">03</span>
        <h2 class="step-title">What We Do Not Do</h2>
      </div>
      <div class="step-body">
        <ul class="req-list">
          <li>We do not operate any backend server. There is no PokéRogue-Offline server that receives, stores, or processes user data.</li>
          <li>We do not share, sell, or transmit any data to third parties.</li>
          <li>We do not use the data for analytics, tracking, advertising, or profiling of any kind.</li>
          <li>We do not read or store the contents of the user's save data outside of the user's own device and their own Google Drive appdata / Dropbox app folder.</li>
        </ul>
      </div>
    </div>

    <!-- 4 -->
    <div class="guide-step">
      <div class="step-header">
        <span class="step-num">04</span>
        <h2 class="step-title">Where Credentials Are Stored</h2>
      </div>
      <div class="step-body">
        <p>
          OAuth tokens are stored locally on the user's device (using OS-level secure storage on desktop, and
          platform-appropriate secure storage on mobile). Tokens are never transmitted to or stored on any
          server operated by us.
        </p>
      </div>
    </div>

    <!-- 5 -->
    <div class="guide-step">
      <div class="step-header">
        <span class="step-num">05</span>
        <h2 class="step-title">Data Retention &amp; Deletion</h2>
      </div>
      <div class="step-body">
        <p>
          Save data placed in the provider's app-only folder remains under the user's account and is subject to
          that provider's own retention policies. The user can revoke this app's access at any time via their
          <a href="https://myaccount.google.com/permissions" target="_blank">Google Account permissions page</a>
          or <a href="https://www.dropbox.com/account/connected_apps" target="_blank">Dropbox connected apps page</a>
          (whichever provider they connected), which also removes the app's ability to read or write to that folder.
        </p>
        <div class="callout info">
          <span class="callout-icon">ℹ️</span>
          <span>Revoking access does not delete the folder's existing contents automatically; the user may need to remove it separately if desired.</span>
        </div>
      </div>
    </div>

    <!-- 6 -->
    <div class="guide-step">
      <div class="step-header">
        <span class="step-num">06</span>
        <h2 class="step-title">Changes to This Policy</h2>
      </div>
      <div class="step-body">
        <p>
          Any future changes to what data is accessed or how it is used will be reflected on this page,
          versioned alongside the source code at
          <a href="https://github.com/PokeRogue-Offline/pokerogue-offline" target="_blank">github.com/PokeRogue-Offline/pokerogue-offline</a>.
        </p>
      </div>
    </div>

    <!-- 7 -->
    <div class="guide-step">
      <div class="step-header">
        <span class="step-num">07</span>
        <h2 class="step-title">Contact</h2>
      </div>
      <div class="step-body">
        <p>Questions about this policy or data handling: contact <strong>"scooom"</strong> on Discord.</p>
      </div>
    </div>

  </div><!-- /guide-body -->

<?php
$footerLinks = false;
include __DIR__ . '/partials/footer.php';
?>
