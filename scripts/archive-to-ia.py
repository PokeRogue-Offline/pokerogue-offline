#!/usr/bin/env python3
"""
Upload a single PokeRogue-Offline GitHub release to the Internet Archive.

Runs from the "Archive to Internet Archive" GitHub Actions workflow, which
triggers on the `release: released` event (fired when a prerelease is
promoted to the latest release). Reads the release to archive from the
workflow's event payload, so no GitHub API calls are needed.

Requires:
    pip install requests internetarchive

IA credentials are read from the environment:
    IAS3_ACCESS_KEY=...
    IAS3_SECRET_KEY=...

Usage:
    python3 archive-to-ia.py --event-path "$GITHUB_EVENT_PATH"
    python3 archive-to-ia.py --event-path event.json --dry-run
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

import requests
from internetarchive import get_item, upload

IA_ACCESS_KEY = os.environ.get("IAS3_ACCESS_KEY")
IA_SECRET_KEY = os.environ.get("IAS3_SECRET_KEY")

REPO = "PokeRogue-Offline/pokerogue-offline"

# Extensions we actually want on IA (per Scooom: build files only, source tarballs OK too)
BUILD_EXTENSIONS = {".exe", ".appimage", ".apk", ".ipa", ".dmg"}

TAG_RE = re.compile(r"^v?(\d+\.\d+\.\d+\.\d+)-(\d+)$")


def parse_tag(tag_name):
    m = TAG_RE.match(tag_name.strip())
    if not m:
        return None, None
    return m.group(1), m.group(2)  # (pokerogue_version, build_number)


def wanted_assets(release):
    """Return list of (filename, url) for build-file assets on this release."""
    out = []
    for asset in release.get("assets", []):
        name = asset["name"]
        if Path(name).suffix.lower() in BUILD_EXTENSIONS:
            out.append((name, asset["browser_download_url"]))
    return out


def source_archive_urls(tag_name):
    """GitHub auto-generates these; not part of the assets list."""
    base = f"https://github.com/{REPO}/archive/refs/tags/{tag_name}"
    repo_short = REPO.split("/")[-1]
    return [
        (f"{repo_short}-{tag_name}.tar.gz", f"{base}.tar.gz"),
        (f"{repo_short}-{tag_name}.zip", f"{base}.zip"),
    ]


def download(url, dest_path):
    with requests.get(url, stream=True) as r:
        r.raise_for_status()
        with open(dest_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)


def item_exists(identifier):
    try:
        item = get_item(identifier)
        return item.exists
    except Exception:
        return False


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


def process_release(release, dry_run, tmpdir):
    tag_name = release["tag_name"]
    pokerogue_version, build_number = parse_tag(tag_name)
    if pokerogue_version is None:
        print(f"[skip] Tag '{tag_name}' doesn't match expected vX.Y.Z.W-N pattern")
        return

    identifier = f"pokerogueoffline-{pokerogue_version}-{build_number}"
    assets = wanted_assets(release)
    assets += source_archive_urls(tag_name)

    print(f"=== {tag_name} -> {identifier} ===")
    if not assets:
        print("  No matching build files found, skipping.")
        return
    for name, _ in assets:
        print(f"  - {name}")

    if item_exists(identifier):
        print(f"  Item '{identifier}' already exists on IA — skipping.")
        return

    if dry_run:
        return

    metadata = build_metadata(release, pokerogue_version, build_number)

    local_files = []
    for name, url in assets:
        dest = os.path.join(tmpdir, name)
        print(f"  Downloading {name} ...")
        download(url, dest)
        local_files.append(dest)

    print(f"  Uploading to {identifier} ...")
    responses = upload(
        identifier,
        files=local_files,
        metadata=metadata,
        access_key=IA_ACCESS_KEY,
        secret_key=IA_SECRET_KEY,
    )
    for r in responses:
        if r.status_code not in (200, 0):
            print(f"  WARNING: upload response {r.status_code} for {identifier}")
    print(f"  Done: https://archive.org/details/{identifier}")

    for f in local_files:
        os.remove(f)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--event-path", required=True, help="Path to the GitHub Actions release event JSON")
    parser.add_argument("--dry-run", action="store_true", help="List what would happen, upload nothing")
    parser.add_argument("--workdir", type=str, default="./ia_downloads", help="Disk-backed dir for temp downloads")
    args = parser.parse_args()

    if not args.dry_run and not (IA_ACCESS_KEY and IA_SECRET_KEY):
        print("Missing IAS3_ACCESS_KEY / IAS3_SECRET_KEY. Set them as workflow secrets/env vars.")
        sys.exit(1)

    with open(args.event_path) as f:
        event = json.load(f)
    release = event["release"]

    os.makedirs(args.workdir, exist_ok=True)
    try:
        process_release(release, args.dry_run, args.workdir)
    finally:
        try:
            os.rmdir(args.workdir)
        except OSError:
            pass  # leftover files from a failed upload; leave them for inspection


if __name__ == "__main__":
    main()
