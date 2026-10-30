/**
 * Mobile (Capacitor) update overlay - a plain HTML/CSS element inserted as a
 * sibling to the game canvas in the WebView's DOM, deliberately NOT rendered
 * through Phaser's UI (see #ui/handlers/update-available-ui-handler, whose
 * own footer-text state machine stays Electron-only).
 *
 * Why separate: on mobile, an update visually reading as "the game drew a
 * menu" is actively misleading - Android's native-fallback path hands off to
 * the system package installer, a jarring context switch if it still looks
 * like in-game UI right up to that point. A DOM overlay outside Phaser reads
 * unmistakably as "the app is doing something to itself," not the game,
 * using plain system fonts/a real progress bar rather than the game's pixel
 * font window chrome.
 *
 * Styles are injected as a single <style> tag here rather than a separate
 * stylesheet asset, so this overlay has no build-pipeline/index.html
 * dependency beyond the element itself - it's entirely self-contained in
 * this one module.
 *
 * Owns the whole download → apply state machine for mobile (calling
 * #system/offline/mobile-updater directly) - UpdateAvailableUiHandler's only
 * job on Capacitor is to call startMobileUpdateFlow() once it knows an
 * update is available; see that file for how "kind" is decided.
 */

import {
  applyMobileUpdateAndRelaunch,
  cancelMobileDownload,
  downloadMobileUpdate,
  type MobileUpdateCheckResult,
} from "#system/offline/mobile-updater";

const STYLE_ID = "mobile-update-overlay-style";
const ROOT_ID = "mobile-update-overlay";

const CSS = `
#${ROOT_ID} {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 24px;
  background: rgba(10, 12, 16, 0.92);
  color: #f2f2f2;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  text-align: center;
}
#${ROOT_ID}[hidden] { display: none; }
#${ROOT_ID} .mobile-update-overlay__message {
  font-size: 16px;
  max-width: 320px;
}
#${ROOT_ID} .mobile-update-overlay__track {
  width: 240px;
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.2);
  overflow: hidden;
}
#${ROOT_ID} .mobile-update-overlay__fill {
  height: 100%;
  width: 0%;
  background: #4caf50;
  transition: width 120ms linear;
}
#${ROOT_ID} .mobile-update-overlay__button {
  padding: 10px 24px;
  border-radius: 8px;
  border: none;
  background: #4caf50;
  color: #fff;
  font-size: 15px;
  font-weight: 600;
}
#${ROOT_ID} .mobile-update-overlay__button.mobile-update-overlay__button--error {
  background: #555;
}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

interface OverlayElements {
  root: HTMLDivElement;
  message: HTMLDivElement;
  track: HTMLDivElement;
  fill: HTMLDivElement;
  button: HTMLButtonElement;
}

let elements: OverlayElements | null = null;

function ensureElements(): OverlayElements {
  if (elements) {
    return elements;
  }
  ensureStyle();

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.hidden = true;

  const message = document.createElement("div");
  message.className = "mobile-update-overlay__message";

  const track = document.createElement("div");
  track.className = "mobile-update-overlay__track";
  const fill = document.createElement("div");
  fill.className = "mobile-update-overlay__fill";
  track.appendChild(fill);

  const button = document.createElement("button");
  button.className = "mobile-update-overlay__button";
  button.hidden = true;

  root.append(message, track, button);
  document.body.appendChild(root);

  elements = { root, message, track, fill, button };
  return elements;
}

function setProgress(fraction: number | null): void {
  const { track, fill } = ensureElements();
  if (fraction === null) {
    track.style.visibility = "hidden";
    return;
  }
  track.style.visibility = "visible";
  fill.style.width = `${Math.max(0, Math.min(100, fraction * 100))}%`;
}

function setMessage(text: string): void {
  ensureElements().message.textContent = text;
}

function setButton(text: string | null, isError: boolean, onClick?: () => void): void {
  const { button } = ensureElements();
  if (!text) {
    button.hidden = true;
    button.onclick = null;
    return;
  }
  button.hidden = false;
  button.textContent = text;
  button.classList.toggle("mobile-update-overlay__button--error", isError);
  button.onclick = onClick ?? null;
}

export function hideMobileUpdateOverlay(): void {
  if (elements) {
    elements.root.hidden = true;
  }
}

function show(): void {
  ensureElements().root.hidden = false;
}

function downloadingMessage(result: MobileUpdateCheckResult, receivedKb: number, totalKb: number, pct: number | null): string {
  const label = result.kind === "ota" ? "Downloading application update" : "Downloading update";
  return pct !== null ? `${label} — ${pct}%` : `${label} — ${receivedKb} KB`;
}

/** Entry point: UpdateAvailableUiHandler calls this once, on Capacitor, after checkForMobileUpdate() returns a "ota" or "native-android" result. */
export async function startMobileUpdateFlow(result: MobileUpdateCheckResult): Promise<void> {
  show();
  setButton(null, false);

  const controller = new AbortController();

  try {
    await downloadMobileUpdate(
      result,
      ({ received, total }) => {
        const pct = total > 0 ? Math.floor((received / total) * 100) : null;
        setProgress(total > 0 ? received / total : null);
        setMessage(downloadingMessage(result, Math.floor(received / 1024), Math.floor(total / 1024), pct));
      },
      controller.signal,
    );
  } catch (err) {
    setProgress(null);
    setMessage(err instanceof Error ? err.message : "Update failed — retry available");
    setButton("Retry", true, () => startMobileUpdateFlow(result));
    return;
  }

  if (result.kind === "ota") {
    // No separate user action for the OTA path - it can apply unattended,
    // unlike Android's native fallback below which hands off to the OS.
    setProgress(null);
    setMessage("Installing application update…");
    setButton(null, false);
    try {
      await applyMobileUpdateAndRelaunch(result);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Update failed — retry available");
      setButton("Retry", true, () => startMobileUpdateFlow(result));
    }
    return;
  }

  // native-android: downloaded and verified, but applying means handing off
  // to Android's system installer - a real context switch, so this waits
  // for an explicit tap rather than firing it the instant the download ends.
  setProgress(null);
  setMessage("Download complete — tap to continue to installer");
  setButton("Continue", false, async () => {
    setMessage("Handing off to Android's installer…");
    setButton(null, false);
    try {
      await applyMobileUpdateAndRelaunch(result);
      hideMobileUpdateOverlay();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Update failed — retry available");
      setButton("Retry", true, () => startMobileUpdateFlow(result));
    }
  });
}

export function cancelMobileUpdateFlow(): void {
  cancelMobileDownload();
  hideMobileUpdateOverlay();
}
