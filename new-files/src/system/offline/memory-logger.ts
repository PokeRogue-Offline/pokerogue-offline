/**
 * Scooom dev builds only: periodic memory-composition log, written to a text
 * file in the app's Documents folder so it can be read on-device (iOS: Files
 * app > PokeRogueOffline > memory-log.txt - the Documents folder is already
 * exposed via UIFileSharingEnabled, same as last-crash.log) without a Mac.
 *
 * WHY: a jetsam report (iOS) only says "WebContent hit its memory limit" -
 * not what was in memory. This records what the game itself can see: how many
 * textures are loaded and their estimated decoded size (width*height*4 bytes
 * per unique TextureSource - the in-memory cost, not the PNG size on disk),
 * decoded audio buffers, and display-list/sound counts, bucketed so growth
 * across waves/biomes points at a category. It is an ESTIMATE of what the
 * game holds, not a measurement of the process: WebKit exposes no heap/RSS
 * API, so GPU-side copies, JS heap, and WebKit's own overhead are not
 * included (Chromium WebViews - Android - additionally report
 * performance.memory, included when present).
 *
 * Writes one line per snapshot (key=value pairs, `|`-separated sections) at
 * every new battle, every SNAPSHOT_INTERVAL_MS while the game runs, and on
 * visibility changes (iOS may kill the page shortly after it's backgrounded).
 * Each line is appended immediately - the point is that the LAST line on
 * disk describes the moment before a kill.
 *
 * Gated on `isScoomDev` (see scooom-dev.ts). Outside Capacitor (desktop) the
 * same lines go to console only.
 */

import { globalScene } from "#app/global-scene";
import { isCapacitor } from "#system/offline/backup-provider";
import { isScoomDev } from "#system/offline/scooom-dev";

const LOG_FILE = "memory-log.txt";
const PREV_LOG_FILE = "memory-log.prev.txt";
/** Rotate (copy to .prev, start fresh) at app start once the log exceeds this. */
const ROTATE_AT_BYTES = 1_500_000;
/** Stop writing periodic snapshots (new-battle/visibility ones continue) past this much per session. */
const SESSION_PERIODIC_CAP_BYTES = 1_000_000;
const SNAPSHOT_INTERVAL_MS = 15_000;
const TOP_TEXTURES = 8;
const TOP_BUCKETS = 8;

interface FilesystemPlugin {
  appendFile(opts: { path: string; data: string; directory: string; encoding: string }): Promise<unknown>;
  writeFile(opts: { path: string; data: string; directory: string; encoding: string }): Promise<unknown>;
  stat(opts: { path: string; directory: string }): Promise<{ size: number }>;
  copy(opts: { from: string; to: string; directory: string; toDirectory: string }): Promise<unknown>;
  deleteFile(opts: { path: string; directory: string }): Promise<unknown>;
}

let started = false;
let sessionStart = 0;
let sessionBytes = 0;
let intervalId: ReturnType<typeof setInterval> | undefined;
/** Serialises file I/O so a rotate can't interleave with appends. */
let writeChain: Promise<void> = Promise.resolve();
let fileFailureReported = false;

function getFilesystem(): FilesystemPlugin | undefined {
  return (window as unknown as { Capacitor?: { Plugins?: { Filesystem?: FilesystemPlugin } } }).Capacitor?.Plugins
    ?.Filesystem;
}

function enqueueWrite(task: (fs: FilesystemPlugin) => Promise<unknown>): void {
  const fs = getFilesystem();
  if (!isCapacitor() || !fs) {
    return;
  }
  writeChain = writeChain
    .then(() => task(fs))
    .then(
      () => undefined,
      err => {
        if (!fileFailureReported) {
          fileFailureReported = true;
          console.warn("[memory-logger] file write failed (further failures are silent):", err);
        }
      },
    );
}

function mb(bytes: number): string {
  return (bytes / 1048576).toFixed(1);
}

/** Coarse bucket for a texture/audio key: text before the first "_", "/" or "-" (keeps unknown schemes data-driven). */
function bucketOf(key: string): string {
  const m = /^[^_/\-:]+/.exec(key);
  return m ? m[0] : key;
}

function addTo(map: Map<string, { n: number; bytes: number }>, bucket: string, bytes: number): void {
  const cur = map.get(bucket) ?? { n: 0, bytes: 0 };
  cur.n++;
  cur.bytes += bytes;
  map.set(bucket, cur);
}

function topBuckets(map: Map<string, { n: number; bytes: number }>): string {
  return [...map.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, TOP_BUCKETS)
    .map(([k, v]) => `${k}:${v.n}/${mb(v.bytes)}`)
    .join(",");
}

/** Per-section guard: one broken probe must never lose the rest of the line or break the game. */
function section(name: string, fn: () => string): string {
  try {
    return `${name}=[${fn()}]`;
  } catch (err) {
    return `${name}=[error:${String(err).slice(0, 60)}]`;
  }
}

function textureSection(): string {
  const list = globalScene.textures.list as Record<string, Phaser.Textures.Texture>;
  const tracked: Set<string> | undefined = (globalScene as unknown as Record<string, Set<string> | undefined>)[
    "trackedPokemonSpriteKeys"
  ];
  const seenSources = new Set<object>();
  const buckets = new Map<string, { n: number; bytes: number }>();
  const sizes: Array<[string, number]> = [];
  let total = 0;
  let count = 0;
  let pokemonBytes = 0;
  let pokemonCount = 0;

  for (const [key, texture] of Object.entries(list)) {
    count++;
    let texBytes = 0;
    for (const source of texture.source ?? []) {
      if (seenSources.has(source)) {
        continue;
      }
      seenSources.add(source);
      texBytes += (source.width || 0) * (source.height || 0) * 4;
    }
    total += texBytes;
    sizes.push([key, texBytes]);
    if (tracked?.has(key)) {
      pokemonBytes += texBytes;
      pokemonCount++;
    } else {
      addTo(buckets, bucketOf(key), texBytes);
    }
  }
  sizes.sort((a, b) => b[1] - a[1]);
  const top = sizes
    .slice(0, TOP_TEXTURES)
    .map(([k, b]) => `${k}:${mb(b)}`)
    .join(",");
  return (
    `n=${count} est=${mb(total)}MB pokemon=${pokemonCount}/${mb(pokemonBytes)}` +
    ` buckets(n/MB)=${topBuckets(buckets)} top=${top}`
  );
}

function audioSection(): string {
  const entries = (globalScene.cache.audio as unknown as { entries?: { entries?: Record<string, unknown> } }).entries
    ?.entries;
  if (!entries) {
    return "unavailable";
  }
  const buckets = new Map<string, { n: number; bytes: number }>();
  let total = 0;
  let count = 0;
  for (const [key, value] of Object.entries(entries)) {
    count++;
    const buf = value as { length?: number; numberOfChannels?: number } | undefined;
    // Decoded WebAudio AudioBuffer: Float32 per sample per channel. Anything else (HTML5 Audio / raw data) is not counted.
    const bytes = buf?.length && buf.numberOfChannels ? buf.length * buf.numberOfChannels * 4 : 0;
    total += bytes;
    addTo(buckets, key.split("/")[0], bytes);
  }
  return `n=${count} decoded=${mb(total)}MB buckets(n/MB)=${topBuckets(buckets)}`;
}

function sceneSection(): string {
  const scene = globalScene;
  const anims = (scene.anims as unknown as { anims?: { size?: number } }).anims?.size;
  return (
    `displayList=${scene.children?.length ?? "?"} sounds=${scene.sound?.getAllPlaying?.().length ?? "?"}` +
    `/${(scene.sound as unknown as { sounds?: unknown[] }).sounds?.length ?? "?"} anims=${anims ?? "?"}` +
    ` canvases=${document.querySelectorAll("canvas").length}`
  );
}

function gameSection(): string {
  const scene = globalScene;
  const biome = (scene.arena as unknown as { biomeType?: number } | undefined)?.biomeType;
  return `wave=${scene.currentBattle?.waveIndex ?? "?"} biome=${biome ?? "?"} party=${scene.getPlayerParty?.().length ?? "?"}`;
}

function jsHeapSection(): string {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  if (!mem) {
    return "n/a";
  }
  return `used=${mb(mem.usedJSHeapSize)}MB total=${mb(mem.totalJSHeapSize)}MB`;
}

function buildLine(tag: string): string {
  const t = ((Date.now() - sessionStart) / 1000).toFixed(0);
  return [
    `${new Date().toISOString()} +${t}s ${tag}`,
    section("game", gameSection),
    section("tex", textureSection),
    section("audio", audioSection),
    section("scene", sceneSection),
    section("heap", jsHeapSection),
  ].join(" | ");
}

function startSession(): void {
  sessionStart = Date.now();
  const header = `\n===== session start ${new Date().toISOString()} (${navigator.userAgent}) =====\n`;
  enqueueWrite(async fs => {
    // Keep one previous log: at app start, if the log has grown large, move it aside.
    try {
      const { size } = await fs.stat({ path: LOG_FILE, directory: "DOCUMENTS" });
      if (size > ROTATE_AT_BYTES) {
        await fs.deleteFile({ path: PREV_LOG_FILE, directory: "DOCUMENTS" }).catch(() => undefined);
        await fs.copy({ from: LOG_FILE, to: PREV_LOG_FILE, directory: "DOCUMENTS", toDirectory: "DOCUMENTS" });
        await fs.writeFile({ path: LOG_FILE, data: "", directory: "DOCUMENTS", encoding: "utf8" });
      }
    } catch {
      // no existing log yet - appendFile below creates it
    }
    await fs.appendFile({ path: LOG_FILE, data: header, directory: "DOCUMENTS", encoding: "utf8" });
  });
}

/**
 * Records one snapshot line. Safe to call from anywhere: never throws, and is a
 * no-op outside Scooom dev builds. The first call starts the session (header,
 * periodic timer, visibility hook).
 */
export function logMemorySnapshot(tag: string, periodic = false): void {
  if (!isScoomDev) {
    return;
  }
  try {
    if (!started) {
      started = true;
      startSession();
      intervalId = setInterval(() => logMemorySnapshot("interval", true), SNAPSHOT_INTERVAL_MS);
      document.addEventListener("visibilitychange", () => logMemorySnapshot(`visibility:${document.visibilityState}`));
      // Last-chance line if the page is being torn down normally (a jetsam kill gives no event).
      window.addEventListener("pagehide", () => logMemorySnapshot("pagehide"));
    }
    if (periodic && sessionBytes > SESSION_PERIODIC_CAP_BYTES) {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
      return;
    }
    const line = `${buildLine(tag)}\n`;
    sessionBytes += line.length;
    console.log(`[memory-logger] ${line.trimEnd()}`);
    enqueueWrite(fs => fs.appendFile({ path: LOG_FILE, data: line, directory: "DOCUMENTS", encoding: "utf8" }));
  } catch (err) {
    console.warn("[memory-logger] snapshot failed:", err);
  }
}
