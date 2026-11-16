// ─────────────────────────────────────────────────────────────────────────
// File and network primitives shared by the full-binary updater
// (updater.cjs) and the content updater (ota-desktop.cjs). Deliberately has
// no dependency on `electron`, so everything here can be exercised from
// plain Node.
// ─────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const PROGRESS_INTERVAL_MS = 100;

/**
 * Streams `url` to `destPath`.
 *
 * Goes through stream.pipeline(), which is what makes this safe: a write
 * error (disk full, permission denied) rejects the returned promise instead
 * of surfacing as an unhandled 'error' event on the write stream - which
 * used to take the whole main process down - and the download is paused
 * whenever the disk is slower than the network, instead of buffering the
 * difference in memory.
 *
 * On any failure the partial file is removed.
 *
 * options.hash:          a crypto Hash to feed every byte through as it
 *                        arrives, so the file never has to be re-read to
 *                        be verified.
 * options.expectedBytes: used as the progress total when the response has
 *                        no usable Content-Length.
 *
 * onProgress(received, total) is called at most every 100ms, plus once at
 * the end. Returns the number of bytes written.
 */
async function downloadToFile(url, destPath, onProgress, signal, options = {}) {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const total = Number(response.headers.get('content-length')) || options.expectedBytes || 0;
  let received = 0;
  let lastProgressAt = 0;

  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      options.hash?.update(chunk);
      const now = Date.now();
      if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        lastProgressAt = now;
        onProgress?.(received, total);
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(destPath), { signal });
  } catch (err) {
    fs.rmSync(destPath, { force: true });
    throw err;
  }
  onProgress?.(received, total || received);
  return received;
}

/** SHA-256 of a file, streamed. */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** Parses `sha256sum` output into a Map of file name -> hex digest. */
function parseChecksums(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/);
    if (match) {
      map.set(match[2].trim(), match[1]);
    }
  }
  return map;
}

/**
 * Replaces `target` (a file or a directory) with `stagedPath`, keeping the
 * previous one at `<target>.old`, and returns that path.
 *
 * Two renames: target -> target.old, then staged -> target. If the second
 * one fails, the first is undone, so a failed update leaves the original
 * in place instead of leaving nothing at `target` at all.
 */
function swapIntoPlace(target, stagedPath) {
  const oldPath = `${target}.old`;
  fs.rmSync(oldPath, { recursive: true, force: true });
  fs.renameSync(target, oldPath);
  try {
    fs.renameSync(stagedPath, target);
  } catch (err) {
    try {
      fs.renameSync(oldPath, target);
    } catch (restoreErr) {
      err.message = `${err.message} - and the original could not be put back (${restoreErr.message}). It is at: ${oldPath}`;
    }
    throw err;
  }
  return oldPath;
}

/**
 * Marks a downloaded file executable (rwxr-xr-x). A file written by
 * fs.createWriteStream gets 0666 minus the umask - never the execute bit -
 * and rename() carries the mode along, so without this an updated AppImage
 * lands in place unable to be launched.
 */
function makeExecutable(filePath) {
  fs.chmodSync(filePath, 0o755);
}

module.exports = { downloadToFile, sha256File, parseChecksums, swapIntoPlace, makeExecutable };
