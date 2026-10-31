const { ipcMain } = require('electron');
const { Client } = require('@xhayper/discord-rpc');

// ─────────────────────────────────────────────────────────────────────────
// Discord Rich Presence. On by default (see the "Discord Rich Presence"
// Offline-settings toggle, patches/all/node/app-settings-menu.js) - driven
// entirely by pushes from the renderer (patches/all/node/update-check.js's
// Electron-menu-hooks interval, which already polls globalScene every 500ms
// for the Tools-menu title-screen check and now also reads run state for
// this).
//
// SETUP REQUIRED before this does anything: a Discord Developer Portal
// application needs to exist for this project, with an uploaded Rich
// Presence Asset named exactly "app_icon" (Settings > Rich Presence > Art
// Assets), and its Application ID set as the DISCORD_CLIENT_ID GitHub
// Actions secret (substituted into DISCORD_CLIENT_ID below the same way
// GOOGLE_CLIENT_ID/DROPBOX_APP_KEY are in main.cjs). Nobody but a repo
// maintainer with Discord Developer Portal access can do this - until it's
// done, DISCORD_CLIENT_ID stays the literal placeholder text below and this
// whole module silently no-ops (same convention as every other
// *_PLACEHOLDER constant in this codebase).
// ─────────────────────────────────────────────────────────────────────────

const DISCORD_CLIENT_ID = 'DISCORD_CLIENT_ID_PLACEHOLDER';
const REPO_BUTTON = { label: 'View on GitHub', url: 'https://github.com/PokeRogue-Offline/pokerogue-offline' };
const RECONNECT_INTERVAL_MS = 15_000;

let client = null;
let enabled = true; // Overwritten almost immediately by the renderer's first push of the real (persisted) setting value - true only covers the brief window before that arrives.
let reconnectTimer = null;
let pendingActivity = null; // Re-applied once a connection is (re-)established.
let lastWaveSeen = null;
let runStartedAt = null;

function clientIdConfigured() {
  return !DISCORD_CLIENT_ID.includes('PLACEHOLDER');
}

function scheduleReconnect() {
  if (reconnectTimer || !enabled || !clientIdConfigured()) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_INTERVAL_MS);
}

function connect() {
  if (!enabled || client || !clientIdConfigured()) {
    return;
  }

  const newClient = new Client({ clientId: DISCORD_CLIENT_ID });
  client = newClient;

  newClient.on('ready', () => {
    if (pendingActivity) {
      applyActivity(pendingActivity);
    }
  });

  newClient.on('disconnected', () => {
    if (client === newClient) {
      client = null;
    }
    scheduleReconnect();
  });

  newClient.login().catch(() => {
    if (client === newClient) {
      client = null;
    }
    scheduleReconnect();
  });
}

function disconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const toDestroy = client;
  client = null;
  toDestroy?.destroy().catch(() => {});
}

async function applyActivity(activity) {
  pendingActivity = activity;
  if (!client?.isConnected) {
    return;
  }
  try {
    if (activity) {
      await client.user?.setActivity(activity);
    } else {
      await client.user?.clearActivity();
    }
  } catch {
    // Discord closed mid-update, or some other transient RPC hiccup - the
    // 'disconnected' handler (or the next presence push) picks this back up.
  }
}

/** Builds the actual Discord activity payload from the renderer's state push. Resets the run-elapsed-time anchor whenever the wave number goes backwards (a new run started). */
function buildActivity(state) {
  if (!state) {
    return null;
  }

  const base = { largeImageKey: 'app_icon', largeImageText: 'PokeRogue Offline', buttons: [REPO_BUTTON] };

  if (state.kind === 'title') {
    return { ...base, details: 'At the Title Screen' };
  }
  if (state.kind === 'menu') {
    return { ...base, details: 'Browsing Menus' };
  }

  // state.kind === 'battle'
  if (lastWaveSeen === null || state.waveIndex < lastWaveSeen) {
    runStartedAt = new Date();
  }
  lastWaveSeen = state.waveIndex;

  return {
    ...base,
    details: `${state.runType} - Wave ${state.waveIndex}`,
    state: state.leadPokemon ?? undefined,
    startTimestamp: runStartedAt,
  };
}

let registered = false;

function registerDiscordRpc() {
  // createWindow() (and so this call) can run again on macOS via the
  // 'activate' handler once all windows have closed - guard against adding
  // duplicate ipcMain.on listeners each time.
  if (registered) {
    return;
  }
  registered = true;

  ipcMain.on('discord-rpc-update-presence', (_event, state) => {
    applyActivity(buildActivity(state));
  });

  // Pushed by the renderer only when the resolved setting value actually
  // changes (including once at boot, with whatever was persisted) - so this
  // firing repeatedly with the same value is not a normal/expected case,
  // but connect()/disconnect() are both idempotent no-ops if nothing
  // actually changed, so there's no need to guard against it here too.
  ipcMain.on('discord-rpc-set-enabled', (_event, isEnabled) => {
    enabled = Boolean(isEnabled);
    if (enabled) {
      lastWaveSeen = null;
      runStartedAt = null;
      connect();
    } else {
      disconnect();
    }
  });
}

module.exports = { registerDiscordRpc };
