<?php
$pageTitle = "PokéRogue Offline — iOS, Android & Desktop";
$activeNav = '';
include __DIR__ . '/partials/head.php';
?>

  <!-- HERO -->
  <div class="hero">
    <img src="/appIcon.webp" alt="PokéRogue Offline" class="hero-emblem" />
    <p class="hero-eyebrow">Unofficial Mobile Client</p>
    <h1 class="hero-title">PokéRogue <span>Offline</span></h1>
    <p class="hero-subtitle">Play Anywhere. No Internet Required.</p>
    <p class="hero-desc">
      A fully offline wrapper for PokéRogue — the browser-based Pokémon roguelite.
      Save locally, import from your online account, and battle on the go.
    </p>
    <div class="platform-badges">
      <span class="platform-badge ios">🍎 iOS</span>
      <span class="platform-badge android">🤖 Android</span>
      <span class="platform-badge linux">🐧 Linux</span>
      <span class="platform-badge windows">🪟 Windows</span>
      <span class="platform-badge macos">🖥️ macOS</span>
    </div>
    <div class="hero-cta">
      <a href="https://github.com/PokeRogue-Offline/pokerogue-offline/releases/latest" class="btn btn-primary">↓ Download</a>
      <a href="https://github.com/PokeRogue-Offline/pokerogue-offline" class="btn btn-secondary">View on GitHub</a>
    </div>
    <p id="version-badge" class="version-badge" style="display:none;"></p>
  </div>

  <div class="divider"><span class="divider-icon">✦</span></div>

  <!-- QUICK LINKS -->
  <section>
    <div>
      <p class="section-label">Get Started</p>
      <h2 class="section-title">Where to Next</h2>
      <p class="section-intro">A quick tour of the essentials — full details are one click away.</p>
    </div>

    <div class="platform-grid">
      <a href="/features.php" class="platform-card">
        <span class="platform-card-icon">✨</span>
        <p class="platform-card-title">Features</p>
        <p class="platform-card-desc">Local saves, live daily seed, cloud backup, Gacha Calendar, and more.</p>
        <p class="platform-card-arrow">→ See what's included</p>
      </a>
      <a href="/install.php" class="platform-card">
        <span class="platform-card-icon">📲</span>
        <p class="platform-card-title">Install</p>
        <p class="platform-card-desc">Step-by-step setup for iOS, Android, Linux, Windows, and macOS.</p>
        <p class="platform-card-arrow">→ Pick your platform</p>
      </a>
      <a href="/altstore.php" class="platform-card">
        <span class="platform-card-icon">🔄</span>
        <p class="platform-card-title">AltStore</p>
        <p class="platform-card-desc">Add the source repo to get notified of new releases automatically.</p>
        <p class="platform-card-arrow">→ Add the source</p>
      </a>
      <a href="/save.php" class="platform-card">
        <span class="platform-card-icon">💾</span>
        <p class="platform-card-title">Save Data</p>
        <p class="platform-card-desc">Import your online progress, or back it up straight to Google Drive or Dropbox.</p>
        <p class="platform-card-arrow">→ Manage your save</p>
      </a>
      <a href="/contact.php" class="platform-card">
        <span class="platform-card-icon">💬</span>
        <p class="platform-card-title">Contact</p>
        <p class="platform-card-desc">Questions, bugs, or feedback — find me on the PokéRogue Discord.</p>
        <p class="platform-card-arrow">→ Get in touch</p>
      </a>
    </div>
  </section>

<?php include __DIR__ . '/partials/footer.php'; ?>
