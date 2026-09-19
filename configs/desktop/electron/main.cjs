const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const https = require('https');

let mainWindow;

// Substituted at build time via `sed` in build-exe.yml, sourced from GitHub
// Secrets — same pattern already used for BUILD_NUMBER_PLACEHOLDER elsewhere
// in this pipeline. Neither value is confidential in the cryptographic
// sense for a Desktop-type OAuth client (see the write-up in the plan doc),
// but they're kept out of plain git history anyway.
const GOOGLE_CLIENT_ID = 'GOOGLE_DESKTOP_CLIENT_ID_PLACEHOLDER';
const GOOGLE_CLIENT_SECRET = 'GOOGLE_DESKTOP_CLIENT_SECRET_PLACEHOLDER';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

// Dropbox is a public PKCE client — no secret. Unlike Google, Dropbox does
// NOT support a variable/wildcard loopback port for a desktop redirect URI:
// it must match a value pre-registered in the Dropbox App Console exactly,
// port included — see the plan doc's manual setup steps. Hence a fixed port
// here instead of `getFreePort()`.
const DROPBOX_APP_KEY = 'DROPBOX_APP_KEY_PLACEHOLDER';
const DROPBOX_REDIRECT_PORT = 53682;
const DROPBOX_REDIRECT_URI = `http://127.0.0.1:${DROPBOX_REDIRECT_PORT}/`;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    icon: path.join(__dirname, 'appIcon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'dist/index.html'));

  if (process.env.DEBUG) {
    mainWindow.webContents.openDevTools();
  }
}

app.on('ready', createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─────────────────────────────────────────────────────────────────────────
// Google Sign-In — "installed app" loopback flow (RFC 8252) with PKCE, plus
// persisted refresh-token storage so the connection survives app restarts.
//
// Without `access_type=offline` + `prompt=consent`, Google only ever hands
// back a short-lived access token (~1hr) and — critically — only issues a
// refresh_token on a user's FIRST consent for this client, silently omitting
// it on subsequent re-auths unless prompt=consent forces it every time.
// That's why the original version of this file lost the connection on every
// restart: it never asked for offline access, so there was nothing to persist.
//
// NOTE: this has been written against Google's documented flows, but has
// not been exercised against a real Google Cloud OAuth client in this exact
// persisted-refresh-token form yet. Treat as a solid draft to verify.
// ─────────────────────────────────────────────────────────────────────────

// `provider` is a filename-safe id ("google" | "dropbox") — each provider's
// refresh token is stored in its own file so signing out of one never
// touches the other's stored connection.
const tokenStorePath = provider => path.join(app.getPath('userData'), `${provider}-refresh-token.dat`);
const TOKEN_STORE_PATH = () => tokenStorePath('google');

function saveRefreshToken(refreshToken, provider = 'google') {
  const storePath = tokenStorePath(provider);
  try {
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(storePath, safeStorage.encryptString(refreshToken));
    } else {
      // Fallback for environments without an OS credential vault available
      // (e.g. a minimal Linux install with no gnome-keyring/kwallet running —
      // not uncommon for an AppImage). Not encrypted at rest in that case;
      // logged loudly rather than silently degrading security expectations.
      console.warn(
        'safeStorage encryption is not available on this system — the refresh token will be stored ' +
          'in plain text at ' +
          storePath +
          '. This is a fallback, not the intended behavior; if you see this on a normal desktop ' +
          'install, something about the OS credential vault setup is worth investigating.',
      );
      fs.writeFileSync(storePath, Buffer.from(refreshToken, 'utf8'));
    }
  } catch (err) {
    console.error(`Failed to persist ${provider} refresh token:`, err);
  }
}

function loadRefreshToken(provider = 'google') {
  const storePath = tokenStorePath(provider);
  try {
    if (!fs.existsSync(storePath)) {
      return null;
    }
    const raw = fs.readFileSync(storePath);
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(raw);
      } catch {
        // Stored value wasn't actually encrypted (e.g. written by the plain-text
        // fallback in a previous run) — fall through to treating it as plain text.
        return raw.toString('utf8');
      }
    }
    return raw.toString('utf8');
  } catch (err) {
    console.error(`Failed to read stored ${provider} refresh token:`, err);
    return null;
  }
}

function deleteStoredRefreshToken(provider = 'google') {
  const storePath = tokenStorePath(provider);
  try {
    if (fs.existsSync(storePath)) {
      fs.unlinkSync(storePath);
    }
  } catch (err) {
    console.error(`Failed to delete stored ${provider} refresh token:`, err);
  }
}

function base64UrlEncode(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makePkcePair() {
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Starts a one-shot loopback HTTP server, resolves with the ?code= from the redirect.
 * Rejects if the returned ?state= doesn't match the one this flow generated —
 * defense-in-depth against a stray/forged callback hitting the loopback port. */
function waitForAuthCode(port, expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      res.setHeader('Content-Type', 'text/html');
      if (code && state === expectedState) {
        res.end('<html><body>Signed in — you can close this tab and return to PokeRogue Offline.</body></html>');
      } else {
        res.end('<html><body>Sign-in failed or was cancelled. You can close this tab.</body></html>');
      }

      server.close();
      if (code && state === expectedState) {
        resolve(code);
      } else if (code && state !== expectedState) {
        reject(new Error('OAuth state mismatch — ignoring callback.'));
      } else {
        reject(new Error(error || 'No authorization code received.'));
      }
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1');
  });
}

/** Finds a free loopback port by briefly binding to port 0 and reading it back. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/** POSTs to an OAuth token endpoint (Google's or Dropbox's); returns the raw parsed JSON response. */
function postTokenEndpoint(hostname, path, bodyParams) {
  const body = new URLSearchParams(bodyParams).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      res => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Exchanges a stored refresh token for a fresh access token — no browser needed. */
async function refreshAccessToken(refreshToken) {
  const { status, body } = await postTokenEndpoint('oauth2.googleapis.com', '/token', {
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (status !== 200 || !body.access_token) {
    // Most commonly: the refresh token was revoked (user removed app access
    // in their Google account, or it's simply stale). Caller falls back to
    // the interactive flow in this case.
    throw new Error(`Refresh failed: ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

/** Full interactive loopback+PKCE flow. Always requests offline access with
 * forced consent, so a fresh refresh_token comes back every time this runs
 * (Google otherwise omits it on repeat authorizations for the same client). */
async function interactiveSignIn() {
  const port = await getFreePort();
  const redirectUri = `http://127.0.0.1:${port}`;
  const { verifier, challenge } = makePkcePair();
  const state = base64UrlEncode(crypto.randomBytes(16));

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GOOGLE_SCOPE);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);

  const codePromise = waitForAuthCode(port, state);
  await shell.openExternal(authUrl.toString());
  const code = await codePromise;

  const { status, body } = await postTokenEndpoint('oauth2.googleapis.com', '/token', {
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  if (status !== 200 || !body.access_token) {
    throw new Error(`Token exchange failed: ${JSON.stringify(body)}`);
  }

  if (body.refresh_token) {
    saveRefreshToken(body.refresh_token);
  } else {
    // Shouldn't happen given prompt=consent above, but if it does, we'll
    // just fall back to a full interactive sign-in again next restart.
    console.warn('Google did not return a refresh_token — the connection will not survive an app restart.');
  }

  return body.access_token;
}

ipcMain.handle('google-sign-in', async () => {
  const storedRefreshToken = loadRefreshToken();

  if (storedRefreshToken) {
    try {
      return await refreshAccessToken(storedRefreshToken);
    } catch (err) {
      console.warn('Stored Google credentials no longer work, falling back to interactive sign-in:', err.message);
      deleteStoredRefreshToken();
      // fall through to interactive flow below
    }
  }

  return interactiveSignIn();
});

// Lets the renderer check "are we probably still connected" without a network
// round-trip, e.g. to decide whether to attempt a silent reconnect on launch.
ipcMain.handle('google-has-stored-credentials', () => {
  return loadRefreshToken() !== null;
});

ipcMain.handle('google-sign-out', () => {
  deleteStoredRefreshToken();
  return true;
});

// ─────────────────────────────────────────────────────────────────────────
// Dropbox Sign-In — same loopback+PKCE shape as Google above, but Dropbox is
// a public client (no client secret) and — critically — does NOT support a
// variable/wildcard loopback port the way Google's redirect_uri validation
// does; the redirect URI here must match one pre-registered in the Dropbox
// App Console exactly, port included, hence the fixed DROPBOX_REDIRECT_PORT
// instead of `getFreePort()`. `token_access_type=offline` is Dropbox's
// equivalent of Google's `access_type=offline` — no `prompt=consent`
// equivalent is needed, Dropbox returns a refresh_token on every
// authorization by default once offline access is requested.
// ─────────────────────────────────────────────────────────────────────────

/** Exchanges a stored Dropbox refresh token for a fresh access token — no browser needed. */
async function refreshDropboxAccessToken(refreshToken) {
  const { status, body } = await postTokenEndpoint('api.dropboxapi.com', '/oauth2/token', {
    client_id: DROPBOX_APP_KEY,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (status !== 200 || !body.access_token) {
    throw new Error(`Dropbox refresh failed: ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

/** Full interactive loopback+PKCE flow against Dropbox's fixed redirect URI. */
async function interactiveDropboxSignIn() {
  const { verifier, challenge } = makePkcePair();
  const state = base64UrlEncode(crypto.randomBytes(16));

  const authUrl = new URL('https://www.dropbox.com/oauth2/authorize');
  authUrl.searchParams.set('client_id', DROPBOX_APP_KEY);
  authUrl.searchParams.set('redirect_uri', DROPBOX_REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('token_access_type', 'offline');
  authUrl.searchParams.set('state', state);

  const codePromise = waitForAuthCode(DROPBOX_REDIRECT_PORT, state);
  await shell.openExternal(authUrl.toString());
  const code = await codePromise;

  const { status, body } = await postTokenEndpoint('api.dropboxapi.com', '/oauth2/token', {
    client_id: DROPBOX_APP_KEY,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: DROPBOX_REDIRECT_URI,
  });

  if (status !== 200 || !body.access_token) {
    throw new Error(`Dropbox token exchange failed: ${JSON.stringify(body)}`);
  }

  if (body.refresh_token) {
    saveRefreshToken(body.refresh_token, 'dropbox');
  } else {
    console.warn('Dropbox did not return a refresh_token — the connection will not survive an app restart.');
  }

  return body.access_token;
}

ipcMain.handle('dropbox-sign-in', async () => {
  const storedRefreshToken = loadRefreshToken('dropbox');

  if (storedRefreshToken) {
    try {
      return await refreshDropboxAccessToken(storedRefreshToken);
    } catch (err) {
      console.warn('Stored Dropbox credentials no longer work, falling back to interactive sign-in:', err.message);
      deleteStoredRefreshToken('dropbox');
      // fall through to interactive flow below
    }
  }

  return interactiveDropboxSignIn();
});

ipcMain.handle('dropbox-has-stored-credentials', () => {
  return loadRefreshToken('dropbox') !== null;
});

ipcMain.handle('dropbox-sign-out', () => {
  deleteStoredRefreshToken('dropbox');
  return true;
});
