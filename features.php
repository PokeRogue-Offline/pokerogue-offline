<?php
$pageTitle = "Features | PokéRogue Offline";
$activeNav = 'features';
include __DIR__ . '/partials/head.php';
?>

  <div class="page-header">
    <p class="page-eyebrow">What's Included</p>
    <h1 class="page-title">Features</h1>
    <p class="page-subtitle">Everything from the official game, plus exclusive additions you won't find anywhere else.</p>
    <a href="/index.php" class="back-link">← Back to Home</a>
  </div>

  <div class="divider"><span class="divider-icon">✦</span></div>

  <section>
    <div class="features-grid">
      <div class="feature-card">
        <span class="feature-icon">📵</span>
        <p class="feature-title">Fully Offline</p>
        <p class="feature-desc">No internet required after install. Play anywhere, anytime — airplane mode included.</p>
      </div>
      <div class="feature-card">
        <span class="feature-icon">💾</span>
        <p class="feature-title">Local Save Data</p>
        <p class="feature-desc">Saves persist between sessions, stored entirely on your device.</p>
      </div>
      <div class="feature-card highlight">
        <span class="feature-icon">🗑️</span>
        <p class="feature-title">Clear All Data</p>
        <p class="feature-desc">Wipe all local save data with one tap via <strong>Settings → Offline</strong>. Use with caution.</p>
      </div>
      <div class="feature-card">
        <span class="feature-icon">📅</span>
        <p class="feature-title">Live Daily Seed</p>
        <p class="feature-desc">The <em>only</em> offline client that loads the actual server daily seed — including special event daily runs.</p>
      </div>
      <div class="feature-card highlight">
        <span class="feature-icon">☁️</span>
        <p class="feature-title">Cloud Backup <span class="new-tag">New</span></p>
        <p class="feature-desc">Connect either <strong>Google Drive</strong> or <strong>Dropbox</strong> under <strong>Settings → Offline</strong> to back up and restore your save. Access is limited to a private, app-only folder — nothing else on your account is ever touched.</p>
      </div>
      <div class="feature-card highlight">
        <span class="feature-icon">🔄</span>
        <p class="feature-title">Automatic Backups <span class="new-tag">New</span></p>
        <p class="feature-desc">Once a provider is connected, your save quietly backs itself up in the background every few waves — no need to remember to hit Backup Save. Manual Backup/Restore are still there whenever you want them.</p>
      </div>
      <div class="feature-card highlight">
        <span class="feature-icon">📊</span>
        <p class="feature-title">Showdown-Style Battle Info <span class="new-tag">New</span></p>
        <p class="feature-desc">Turn on the <strong>Damage Range</strong> and <strong>Enemy HP %</strong> settings to see a predicted damage percentage (or a "Guaranteed KO" label) for each move, and read enemy HP as an exact percentage instead of guessing from the bar.</p>
      </div>
      <div class="feature-card highlight">
        <span class="feature-icon">🔔</span>
        <p class="feature-title">Smarter Update Notifications <span class="new-tag">New</span></p>
        <p class="feature-desc">An "Update Available!" hint shows on the title screen the moment a new version ships, with a paginated changelog viewer to see exactly what's new. The <strong>Update Pop-Ups</strong> setting controls whether that changelog also opens automatically.</p>
      </div>
      <div class="feature-card">
        <span class="feature-icon">🎰</span>
        <p class="feature-title">Gacha Calendar</p>
        <p class="feature-desc">A new entry under <strong>Egg Gacha</strong> in the pause menu shows which species is boosted in the Legendary gacha for any day of the month.</p>
      </div>
      <div class="feature-card">
        <span class="feature-icon">📦</span>
        <p class="feature-title">Import Online Save</p>
        <p class="feature-desc">Bring your progress over from pokerogue.net with a simple export/import flow.</p>
      </div>
      <div class="feature-card">
        <span class="feature-icon">⚡</span>
        <p class="feature-title">Always Up To Date</p>
        <p class="feature-desc">Built directly from the official PokéRogue source — automatically stays current with every upstream update.</p>
      </div>
      <div class="feature-card">
        <span class="feature-icon">#</span>
        <p class="feature-title">Build Number in Banner</p>
        <p class="feature-desc">The app version is shown in the banner for easy identification when requesting support.</p>
      </div>
    </div>
  </section>

<?php include __DIR__ . '/partials/footer.php'; ?>
