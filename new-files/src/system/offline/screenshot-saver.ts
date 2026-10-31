/**
 * Mobile-only "clean screenshot" feature: captures the Phaser canvas (never
 * the DOM touch-controls overlay layered on top of it - a separate element,
 * not drawn into the canvas), briefly hiding that overlay around the capture
 * anyway as a defensive guarantee, then saves the result into a dedicated
 * "PKROffline" photo album via @capacitor-community/media.
 *
 * @capacitor-community/media is dynamically imported (never statically) -
 * see patches/all/node/externalize-capacitor-imports.js's
 * CAPACITOR_ONLY_PACKAGES list, which this package must also be added to:
 * it's only installed for the two mobile workflows, so a static import
 * would break desktop/Electron builds even behind a runtime isCapacitor()
 * guard (Rolldown resolves static imports at build time regardless).
 */

import { globalScene } from "#app/global-scene";
import { isCapacitor } from "#system/offline/backup-provider";

const ALBUM_NAME = "PKROffline";
const TOUCH_CONTROLS_ID = "touchControls";

let inFlight = false;

function showToast(message: string, isError = false): void {
  const toast = document.createElement("div");
  toast.textContent = message;
  Object.assign(toast.style, {
    position: "fixed",
    bottom: "40px",
    left: "50%",
    transform: "translateX(-50%)",
    background: isError ? "rgba(120,0,0,0.85)" : "rgba(0,0,0,0.85)",
    color: "#fff",
    padding: "10px 18px",
    borderRadius: "10px",
    fontSize: "14px",
    zIndex: "9999",
    pointerEvents: "none",
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function snapshotCanvas(): Promise<string> {
  return new Promise((resolve, reject) => {
    globalScene.game.renderer.snapshot(image => {
      const src = (image as HTMLImageElement)?.src;
      if (!src) {
        reject(new Error("Snapshot returned no image data"));
        return;
      }
      resolve(src);
    });
  });
}

/**
 * Resolves the platform identifier @capacitor-community/media's savePhoto()
 * needs for albumIdentifier (required on Android, optional on iOS - but
 * passed on both here so the screenshot lands in the same named album on
 * either platform). createAlbum() returns void, not the new album's
 * identifier, so a create is always followed by a re-fetch.
 */
async function getOrCreateAlbumIdentifier(media: typeof import("@capacitor-community/media")["Media"]): Promise<string> {
  const existing = (await media.getAlbums()).albums.find(a => a.name === ALBUM_NAME);
  if (existing) {
    return existing.identifier;
  }
  await media.createAlbum({ name: ALBUM_NAME });
  const created = (await media.getAlbums()).albums.find(a => a.name === ALBUM_NAME);
  if (!created) {
    throw new Error(`Could not find or create the "${ALBUM_NAME}" album.`);
  }
  return created.identifier;
}

async function saveToGallery(dataUrl: string): Promise<void> {
  const { Media } = await import("@capacitor-community/media");
  const albumIdentifier = await getOrCreateAlbumIdentifier(Media);
  await Media.savePhoto({
    path: dataUrl,
    albumIdentifier,
    fileName: `pkroffline-${Date.now()}`,
  });
}

/** Wired to the new touch-control button - see patches/mobile/node/screenshot-button.js. */
export async function captureAndSaveScreenshot(): Promise<void> {
  if (!isCapacitor() || inFlight) {
    return;
  }
  inFlight = true;

  const overlay = document.getElementById(TOUCH_CONTROLS_ID);
  const wasVisible = overlay?.classList.contains("visible") ?? false;
  overlay?.classList.remove("visible");

  let dataUrl: string;
  try {
    // One frame so the hide actually paints before the canvas is read -
    // snapshot() reads the GL/canvas drawing buffer directly, so this is
    // cheap insurance rather than a hard requirement.
    await new Promise(requestAnimationFrame);
    dataUrl = await snapshotCanvas();
  } catch (err) {
    console.error("Screenshot capture failed:", err);
    showToast("Could not take screenshot", true);
    if (wasVisible) {
      overlay?.classList.add("visible");
    }
    inFlight = false;
    return;
  }
  if (wasVisible) {
    overlay?.classList.add("visible");
  }

  try {
    await saveToGallery(dataUrl);
    showToast(`Saved to Photos (${ALBUM_NAME})`);
  } catch (err) {
    console.error("Screenshot save failed:", err);
    showToast("Could not save screenshot", true);
  } finally {
    inFlight = false;
  }
}
