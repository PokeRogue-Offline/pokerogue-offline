#!/usr/bin/env python3
"""
Upload a single PokeRogue-Offline GitHub release to the Internet Archive.

Runs from the "Archive to Internet Archive" GitHub Actions workflow, either on
the `release: released` event (fired when a prerelease is promoted to the
latest release) or by hand via workflow_dispatch / the command line.

The upload is resumable. It is safe to run again for the same release: files
already on the IA item (same name and size) are skipped, only missing ones are
uploaded, and the script exits non-zero if the item is still incomplete.

Requires:
    pip install requests internetarchive

IA credentials are read from the environment:
    IAS3_ACCESS_KEY=...
    IAS3_SECRET_KEY=...

Usage:
    # From the release event payload (what the workflow does on `released`)
    python3 archive-to-ia.py --event-path "$GITHUB_EVENT_PATH"

    # By tag (manual). Reads the release from the GitHub API; set GITHUB_TOKEN
    # to avoid the anonymous rate limit.
    python3 archive-to-ia.py --tag v1.12.2.8-390
    python3 archive-to-ia.py --tag v1.12.2.8-390 --dry-run
"""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

import requests
from internetarchive import get_item, upload

IA_ACCESS_KEY = os.environ.get("IAS3_ACCESS_KEY")
IA_SECRET_KEY = os.environ.get("IAS3_SECRET_KEY")

REPO = "PokeRogue-Offline/pokerogue-offline"

# Extensions we actually want on IA (per Scooom: build files only, source tarballs OK too)
BUILD_EXTENSIONS = {".exe", ".appimage", ".apk", ".ipa", ".dmg"}

TAG_RE = re.compile(r"^v?(\d+\.\d+\.\d+\.\d+)-(\d+)$")

# IA's S3 endpoint does not answer a large PUT until it has accepted the whole
# body, and the internetarchive library's default 120 s read timeout is shorter
# than that for the installers. (connect, read) in seconds.
IA_REQUEST_TIMEOUT = (30, 1800)
DOWNLOAD_TIMEOUT = (30, 120)

UPLOAD_ATTEMPTS = 5
UPLOAD_BACKOFF_SECONDS = 30


def parse_tag(tag_name):
    m = TAG_RE.match(tag_name.strip())
    if not m:
        return None, None
    return m.group(1), m.group(2)  # (pokerogue_version, build_number)


def wanted_assets(release):
    """Return list of (filename, url, size) for build-file assets on this release."""
    out = []
    for asset in release.get("assets", []):
        name = asset["name"]
        if Path(name).suffix.lower() in BUILD_EXTENSIONS:
            out.append((name, asset["browser_download_url"], asset.get("size")))
    return out


def source_archive_urls(tag_name):
    """GitHub auto-generates these; not part of the assets list, so no known size."""
    base = f"https://github.com/{REPO}/archive/refs/tags/{tag_name}"
    repo_short = REPO.split("/")[-1]
    return [
        (f"{repo_short}-{tag_name}.tar.gz", f"{base}.tar.gz", None),
        (f"{repo_short}-{tag_name}.zip", f"{base}.zip", None),
    ]


def download(url, dest_path):
    with requests.get(url, stream=True, timeout=DOWNLOAD_TIMEOUT) as r:
        r.raise_for_status()
        with open(dest_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)


def fetch_release_by_tag(tag_name):
    headers = {"Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = requests.get(
        f"https://api.github.com/repos/{REPO}/releases/tags/{tag_name}",
        headers=headers,
        timeout=DOWNLOAD_TIMEOUT,
    )
    r.raise_for_status()
    return r.json()


def present_files(identifier):
    """
    Return {filename: size_or_None} for the original files already on the IA
    item, or {} if the item does not exist (or cannot be read).
    """
    try:
        item = get_item(identifier, access_key=IA_ACCESS_KEY, secret_key=IA_SECRET_KEY)
        if not item.exists:
            return {}
        out = {}
        for f in item.files:
            if f.get("source", "original") != "original":
                continue  # IA-derived files (thumbnails, torrent, metadata xml)
            try:
                out[f["name"]] = int(f["size"])
            except (KeyError, TypeError, ValueError):
                out[f["name"]] = None
        return out
    except Exception as e:  # network blip: treat as "unknown" and let upload decide
        print(f"  WARNING: could not read item '{identifier}': {e}")
        return {}


def missing_assets(assets, present):
    """
    Assets not yet (fully) on the item. A file counts as present when the name
    matches and, if both sizes are known, the sizes match. A name match with
    differing sizes is a truncated upload and is re-sent.
    """
    out = []
    for name, url, size in assets:
        have = present.get(name)
        if name not in present:
            out.append((name, url, size))
        elif size is not None and have is not None and have != size:
            print(f"  {name}: on IA as {have} bytes, expected {size} - will re-upload")
            out.append((name, url, size))
    return out


def build_metadata(release, pokerogue_version, build_number):
    return {
        "title": f"PokeRogueOffline {pokerogue_version} (build {build_number})",
        "mediatype": "software",
        "description": release.get("body") or "PokeRogueOffline release build.",
        "creator": "PokeRogue-Offline",
        "subject": "PokeRogue;PokeRogueOffline;Pokemon;fan game;offline;Electron;Capacitor",
        "version": pokerogue_version,
        "date": (release.get("published_at") or "")[:10],
        "originalurl": release.get("html_url", ""),
    }


def upload_one(identifier, path, metadata):
    """
    Upload one file with retries. A timed-out PUT may still have landed on IA's
    side, so every retry runs with checksum=True, which skips the file when IA
    already holds a matching copy.
    """
    last_error = None
    for attempt in range(1, UPLOAD_ATTEMPTS + 1):
        try:
            responses = upload(
                identifier,
                files=[path],
                metadata=metadata,
                access_key=IA_ACCESS_KEY,
                secret_key=IA_SECRET_KEY,
                checksum=True,
                queue_derive=False,
                retries=8,
                retries_sleep=30,
                request_kwargs={"timeout": IA_REQUEST_TIMEOUT},
            )
            for r in responses:
                # checksum-skipped files come back as a Request, not a Response
                status = getattr(r, "status_code", 0)
                if status not in (200, 0):
                    raise RuntimeError(f"upload response {status}")
            return
        except (requests.exceptions.RequestException, RuntimeError) as e:
            last_error = e
            print(f"  attempt {attempt}/{UPLOAD_ATTEMPTS} failed: {type(e).__name__}: {e}")
            if attempt < UPLOAD_ATTEMPTS:
                time.sleep(UPLOAD_BACKOFF_SECONDS * attempt)
    raise RuntimeError(f"giving up on {Path(path).name}: {last_error}")


def process_release(release, dry_run, tmpdir):
    """Returns True when the IA item holds every expected file afterwards."""
    tag_name = release["tag_name"]
    pokerogue_version, build_number = parse_tag(tag_name)
    if pokerogue_version is None:
        print(f"[skip] Tag '{tag_name}' doesn't match expected vX.Y.Z.W-N pattern")
        return True

    identifier = f"pokerogueoffline-{pokerogue_version}-{build_number}"
    assets = wanted_assets(release)
    if not assets:
        print("  No matching build files found, skipping.")
        return True
    assets += source_archive_urls(tag_name)

    print(f"=== {tag_name} -> {identifier} ===")
    present = present_files(identifier)
    todo = missing_assets(assets, present)
    for name, _, _ in assets:
        print(f"  [{'missing' if any(name == t[0] for t in todo) else 'present'}] {name}")

    if not todo:
        print(f"  Item '{identifier}' is complete - nothing to upload.")
        return True
    if dry_run:
        print(f"  Dry run: would upload {len(todo)} file(s).")
        return False

    metadata = build_metadata(release, pokerogue_version, build_number)
    failed = []
    for name, url, _ in todo:
        dest = os.path.join(tmpdir, name)
        try:
            print(f"  Downloading {name} ...", flush=True)
            download(url, dest)
            print(f"  Uploading {name} ({os.path.getsize(dest) / 1e6:.1f} MB) ...", flush=True)
            upload_one(identifier, dest, metadata)
            print(f"  Uploaded {name}", flush=True)
        except Exception as e:
            print(f"  ERROR {name}: {type(e).__name__}: {e}", flush=True)
            failed.append(name)
        finally:
            if os.path.exists(dest):
                os.remove(dest)

    # Re-read the item so success means "IA actually has everything", not
    # "no exception was raised".
    still_missing = missing_assets(assets, present_files(identifier))
    if failed or still_missing:
        names = sorted(set(failed) | {m[0] for m in still_missing})
        print(f"  INCOMPLETE: {len(names)} file(s) not on IA: {', '.join(names)}")
        print("  Re-run the workflow (or this script) to resume; finished files are skipped.")
        return False

    print(f"  Done: https://archive.org/details/{identifier}")
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--event-path", help="Path to the GitHub Actions release event JSON")
    source.add_argument("--tag", help="Release tag to archive, e.g. v1.12.2.8-390 (reads the release from the GitHub API)")
    parser.add_argument("--dry-run", action="store_true", help="List present/missing files, upload nothing")
    parser.add_argument("--workdir", type=str, default="./ia_downloads", help="Disk-backed dir for temp downloads")
    args = parser.parse_args()

    if not args.dry_run and not (IA_ACCESS_KEY and IA_SECRET_KEY):
        print("Missing IAS3_ACCESS_KEY / IAS3_SECRET_KEY. Set them as workflow secrets/env vars.")
        sys.exit(1)

    if args.tag:
        release = fetch_release_by_tag(args.tag)
    else:
        with open(args.event_path) as f:
            release = json.load(f)["release"]

    os.makedirs(args.workdir, exist_ok=True)
    try:
        complete = process_release(release, args.dry_run, args.workdir)
    finally:
        try:
            os.rmdir(args.workdir)
        except OSError:
            pass  # leftover files from a failed upload; leave them for inspection

    if not complete and not args.dry_run:
        sys.exit(1)


if __name__ == "__main__":
    main()
