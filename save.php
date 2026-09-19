<?php
$pageTitle = "Save Data | PokéRogue Offline";
$activeNav = 'save';
include __DIR__ . '/partials/head.php';
?>

  <div class="page-header">
    <p class="page-eyebrow">Save Data</p>
    <h1 class="page-title">Import Your <span>Online Save</span></h1>
    <p class="page-subtitle">Already have progress on pokerogue.net? Bring it into the app.</p>
    <a href="/index.php" class="back-link">← Back to Home</a>
  </div>

  <div class="divider"><span class="divider-icon">✦</span></div>

  <section>
    <div class="install-card">
      <div class="steps">
        <div class="step-row"><span class="step-n">1</span><span>Go to <a href="https://pokerogue.net" target="_blank">pokerogue.net</a> in a browser and log in</span></div>
        <div class="step-row"><span class="step-n">2</span><span>Navigate to <strong>Menu → Manage Data → Export Data</strong></span></div>
        <div class="step-row"><span class="step-n">3</span><span>Open PokéRogue Offline on your device</span></div>
        <div class="step-row"><span class="step-n">4</span><span>Navigate to <strong>Menu → Manage Data → Import Data</strong></span></div>
        <div class="step-row"><span class="step-n">5</span><span>Select the exported file — your save will load immediately</span></div>
      </div>
    </div>

    <div class="install-card" style="margin-top:1.5rem;">
      <div class="card-header">
        <div>
          <h3 class="card-title">☁️ Or Back Up to the Cloud</h3>
        </div>
        <span class="badge badge-recommended">New</span>
      </div>
      <p style="margin-bottom:1.25rem; color: var(--text-dim); font-size:0.97rem;">
        Prefer not to shuttle files around? Connect either Google Drive or Dropbox from the in-game Settings menu and back up or restore your save straight from a private, app-only folder. Once connected, a backup also runs automatically in the background every few waves — no need to remember to do it yourself.
      </p>
      <div class="steps">
        <div class="step-row"><span class="step-n">1</span><span>Open <strong>Settings → Offline</strong> (the tab next to General/Display/Audio)</span></div>
        <div class="step-row"><span class="step-n">2</span><span>Choose a <strong>Backup Provider</strong> — Google Drive or Dropbox — then tap <strong>Connect Account</strong> and sign in</span></div>
        <div class="step-row"><span class="step-n">3</span><span>Tap <strong>Backup Save</strong> to upload manually anytime, or <strong>Restore Backup</strong> to pull it down on another device</span></div>
      </div>
      <div class="card-note">
        Only the app's own hidden app folder is used on either provider — see the <a href="/privacy.php">Privacy Policy</a> for exactly what's accessed and how to revoke it.
      </div>
    </div>
  </section>

<?php include __DIR__ . '/partials/footer.php'; ?>
