# Archiving releases to the Internet Archive

Each promoted release is mirrored to archive.org as the item
`pokerogueoffline-<version>-<build>` (e.g. `pokerogueoffline-1.12.2.8-390`),
holding the six installers plus the GitHub source `.tar.gz` and `.zip`.

The upload is **resumable**: files already on the item (same name and size) are
skipped, only missing ones are sent, and the job fails if the item is still
incomplete. A timed-out run can simply be run again.

## Automatic
`.github/workflows/archive-to-ia.yml` runs on `release: released` (a prerelease
promoted to latest). The `nightly` release is ignored.

## Manual
Actions -> "Archive to Internet Archive" -> Run workflow, with the release tag
(e.g. `v1.12.2.8-390`). Tick `dry_run` first to see which files are
present/missing without uploading.

From a terminal instead (credentials from `ia configure` or the environment):

```bash
pip install requests internetarchive
export IAS3_ACCESS_KEY=... IAS3_SECRET_KEY=...   # archive.org/account/s3.php
export GITHUB_TOKEN=...                          # optional, avoids API rate limits
python3 scripts/archive-to-ia.py --tag v1.12.2.8-390 --dry-run
python3 scripts/archive-to-ia.py --tag v1.12.2.8-390
```

## Credentials
`IAS3_ACCESS_KEY` and `IAS3_SECRET_KEY` must be repository **secrets** (not
variables) so they are masked in logs.

## Notes
- An IA item can't be deleted by its owner, only its files. A partial item is
  completed by re-running, not replaced.
- IA's S3 endpoint doesn't reply to a large PUT until the body is fully
  accepted, so the script uses a 30-minute read timeout (the library default of
  120 s timed out on the installers).
