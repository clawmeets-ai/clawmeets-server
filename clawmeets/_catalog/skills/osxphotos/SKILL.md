---
name: osxphotos
description: >
  macOS Photos library (Photos.app + iCloud Photo Library) — read-only
  metadata + paths, plus JPEG export for vision Read. Invoked via
  `clawmeets osxphotos {list-albums,list-photos,export,export-jpeg}`. macOS
  only; requires `osxphotos` on the runner and Full Disk Access to the Python
  interpreter. No OAuth, no config.
---

# /clawmeets:osxphotos

macOS Photos library access via the `clawmeets osxphotos` CLI.

## Step 0 — Preflight

macOS + `pip install osxphotos` + Full Disk Access for Python.

## Step 1 — Pick the subcommand

| Intent | Command |
|---|---|
| Albums + photo counts | `clawmeets osxphotos list-albums` |
| Photos in album | `clawmeets osxphotos list-photos --album "2025" --limit 50` |
| Force-download iCloud-only | `clawmeets osxphotos export <UUID> --dest /tmp/photo` |
| Transcode for vision Read | `clawmeets osxphotos export-jpeg <UUID> --dest /tmp/photo` |

## Step 2 — Image bytes (vision pipelines)

`list-photos` returns paths but not bytes (`path` is null for iCloud-only
photos). Either:
1. Call `export-jpeg <UUID>` (default `--max-dim 1200 --quality 65` yields
   ~120 KB — under Claude Code's 256 KB Read cap), then Read the JPEG.
2. Call `export <UUID>` for original-quality bytes (likely too big to Read).

## Step 3 — Fetching photos on a schedule

These commands only fetch. If your SOP has you pull photo metadata regularly,
where you store it, how you deduplicate it (`uuid` is stable), and how you
track what you already fetched (e.g. `date_added` — when the photo entered the
library, unlike `date`, the EXIF capture time) is up to that SOP.
