---
name: photo-story
description: >
  Build animated, single-file HTML "year story" / "trip story" / "milestone story"
  artifacts from a photo library — Spotify-Wrapped / Apple-Memories style
  scrollytelling, code-driven motion, plays straight from file://. Also covers
  the curator-side funnel for getting from 1k–10k photos down to ~50 keepers
  without melting context. Use when an agent needs to produce a multi-photo
  narrative artifact OR when triaging a large photo library.
---

# Photo Story

Two modes in one skill — pick the half you need:

- **Curator mode** (volume → keepers): turn a year's worth of photos into a
  small, intentional shortlist. Runs locally; never hands the full library to
  the model.
- **Bookmaker mode** (keepers → artifact): turn that shortlist into a
  single-file animated HTML story you can text to family or open in a
  browser without any build step.

---

## Curator mode: from a thousand photos to fifty

A "best of 2025" album is typically 1k–10k photos. You cannot read them all
into vision context — token cost is prohibitive and the model can't reason
over that many at once anyway. **List metadata first, look at images last.**

### Step 1 — Discover the source

Two photo sources are supported. Pick whichever the user has:

**Filesystem folder** (e.g. an iCloud Drive folder mounted at
`~/Library/Mobile Documents/com~apple~CloudDocs/Photos/2025`): the agent's
`knowledge_dir` already points at it. Walk the directory and read EXIF.

```python
# Run this as a Bash one-liner; faster than reading per-file from Python.
exiftool -j -r -DateTimeOriginal -GPSLatitude -GPSLongitude -ImageWidth \
  -ImageHeight -FileName "/path/to/folder" > /tmp/exif.json
```

If `exiftool` isn't installed, fall back to `Pillow`:

```python
from PIL import Image, ExifTags
from pathlib import Path
import json

rows = []
for p in Path("/path/to/folder").rglob("*"):
    if p.suffix.lower() not in (".jpg", ".jpeg", ".heic", ".png"):
        continue
    try:
        img = Image.open(p)
        exif = {ExifTags.TAGS.get(k, k): v for k, v in (img._getexif() or {}).items()}
    except Exception:
        exif = {}
    rows.append({
        "path": str(p),
        "date": exif.get("DateTimeOriginal"),
        "gps": exif.get("GPSInfo"),
        "size": f"{img.width}x{img.height}" if hasattr(img, "width") else None,
    })
```

**Apple Photos album** (e.g. an album called "2025" inside Photos.app,
synced via iCloud Photo Library): use the `photos` MCP. Photos.app's
`Photos Library.photoslibrary` is an opaque package; the MCP wraps
`osxphotos` to query it.

```
photos.list_albums()                              → pick the right album
photos.list_photos(album="2025", year=2025)        → metadata + paths, no bytes
```

### Step 2 — Cluster into events

Don't bucket by calendar week — bucket by what actually happened. Two
photos within ~2 hours and ~500 m of each other are part of the same event
(brunch, hike, dinner). A photo with no GPS plus a 6-hour gap from the next
shot likely starts a new event.

```python
def cluster_events(rows):
    rows = sorted(rows, key=lambda r: r["date"])
    events, current = [], []
    for r in rows:
        if not current:
            current = [r]; continue
        gap_hours = (r["dt"] - current[-1]["dt"]).total_seconds() / 3600
        moved = (r.get("gps") and current[-1].get("gps")
                 and haversine(r["gps"], current[-1]["gps"]) > 0.5)
        if gap_hours > 2 or moved:
            events.append(current); current = []
        current.append(r)
    if current: events.append(current)
    return events
```

Aim for 30–80 events for a typical year. Fewer means under-clustered (a
trip will swallow surrounding moments); more means over-fragmented.

### Step 3 — Sample-vision per event

For each event, take **at most 3 candidate photos** (e.g. first, middle,
favorite by user-tag) and read those via the Read tool. Score them on:

- People in frame (faces beat scenery for memory recall)
- Sharpness (drop the obvious blurs)
- Specificity (a labeled shopfront beats yet another sunset)

Pick the strongest 1–2 per event. Skip events that are visually thin
(receipts, screenshots, repeated room shots).

### Step 4 — Funnel to ~50

Total budget: ~50 photos for a year-in-review. If clustering gave 60
events and you picked ~1 per event, you're done. If it gave 30 events
because the year was quiet, take 1–2 from each strong event and stop.

**Cull mercilessly.** "Best 50 of 2025" is a feature, not a constraint.

### Step 5 — Write captions

One sentence per photo. Anchor it to the small, forgettable detail (the
restaurant name, the trail, the inside joke). Match the owner's voice
from prior writing — terse, warm, dry, sentimental, whatever fits. Read
each aloud; if it sounds like a greeting card, rewrite it.

---

## Bookmaker mode: animated single-file HTML

Output a `.html` file that opens straight from `file://`. No build step,
no server. Photos embedded as base64 by default for shareability.

### Architecture

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>2025 — Year Story</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js"></script>
  <style>
    html { scroll-behavior: smooth; scroll-snap-type: y mandatory; }
    section { scroll-snap-align: start; min-height: 100vh; }
    .photo { transition: transform 0.6s ease, opacity 0.6s ease; }
    .photo.in-view { transform: scale(1) translateY(0); opacity: 1; }
    .photo.out-of-view { transform: scale(0.95) translateY(20px); opacity: 0; }
  </style>
</head>
<body class="bg-black text-white font-sans antialiased">
  <!-- One <section> per chapter (intro, season, milestone, outro) -->
  <section class="flex flex-col items-center justify-center text-center p-8">
    <h1 class="text-7xl font-bold tracking-tight">2025</h1>
    <p class="text-xl text-gray-400 mt-4">A year, in pictures.</p>
  </section>

  <section class="grid grid-cols-1 md:grid-cols-2 gap-4 p-8 items-center">
    <img src="data:image/jpeg;base64,..." class="photo rounded-lg shadow-2xl">
    <div>
      <h2 class="text-4xl font-semibold">Spring</h2>
      <p class="text-gray-300 mt-4">Caption here.</p>
    </div>
  </section>

  <!-- ... -->

  <script>
    gsap.registerPlugin(ScrollTrigger);
    gsap.utils.toArray("section img.photo, section h2").forEach((el) => {
      gsap.from(el, {
        opacity: 0,
        y: 40,
        duration: 0.8,
        scrollTrigger: { trigger: el, start: "top 80%" },
      });
    });
  </script>
</body>
</html>
```

### CDN libraries (no install needed)

| Library | CDN | Use |
|---|---|---|
| Tailwind CSS | `cdn.tailwindcss.com` | Layout + typography |
| GSAP + ScrollTrigger | `cdn.jsdelivr.net/npm/gsap@3.12.5` | Scroll-triggered motion |
| Lottie | `cdn.jsdelivr.net/npm/lottie-web` | After Effects-style accents (optional) |
| Three.js | `cdn.jsdelivr.net/npm/three@0.160` | 3D / spatial moments (optional) |

You don't need React for this — it's a one-shot, scroll-driven page.
Keep the JS tiny.

### Image embedding: base64 by default

Inline photos as base64 data URIs. The HTML is bigger (~33% overhead) but
it's a single file the user can text, AirDrop, or email.

```python
import base64, mimetypes, json
from pathlib import Path

def encode(p: Path) -> str:
    mime, _ = mimetypes.guess_type(p.name)
    b64 = base64.b64encode(p.read_bytes()).decode("ascii")
    return f"data:{mime or 'image/jpeg'};base64,{b64}"
```

For 50 photos at ~500 KB each → roughly 25 MB inline. That's fine for
single-file sharing. Above 100 photos, switch to **linked mode**: keep
photos in a sibling `assets/` folder and use relative `<img src="assets/...">`.
Document the mode used with an HTML comment at the top of the file:

```html
<!-- mode: linked  (photos in ./assets/, must be sent alongside this file) -->
```

### Resize before embedding

Don't embed 4032×3024 originals — the page will be enormous and most photos
look better at ~1600 px wide on the longer axis. Use Pillow:

```python
from PIL import Image
img = Image.open(src_path)
img.thumbnail((1600, 1600))
img.save(out_path, "JPEG", quality=85, optimize=True)
```

Test on phone-screen-width — most year stories will be opened on a phone.

### Pacing

| Spread | Use for |
|---|---|
| Full-bleed hero | Opener, season titles, biggest moments |
| Two-up | Pairs (before/after, two-angles, person + place) |
| Three-up grid | Event recap (a wedding, a trip leg) |
| Text-only | Section breaks, the closing reflection |

Vary aggressively — three full-bleeds in a row is monotonous. Open and
close strong; the first and last sections are what people remember.

### Music? Sound? Skip by default.

Auto-playing audio in HTML is jail. If the user explicitly asks, use
`<audio>` with `controls` (no `autoplay`) and let them hit play.

---

## Verification

Before emitting the file, sanity-check:

1. Open the HTML directly with `file://` in Chrome / Safari. Photos render,
   transitions don't jank.
2. Total page size under 50 MB. If over, switch to linked mode or shrink
   photos.
3. Captions don't sound like greeting cards.
4. Mobile viewport works (375 × 667 in DevTools): no horizontal scroll,
   photos resize, text stays readable.

If any of those fail, fix and re-emit before handing off.

---

## What this skill is NOT

- Not a print-PDF generator. If the user asks for "hardcover book ready for
  Shutterfly," reach for the `pdf` skill instead.
- Not a video editor. Output is HTML + CSS animations, not MP4. If they
  want video, suggest a screen-recording of the HTML scroll-through.
- Not a face-recognition tool. Person-tagging upstream of this skill is
  the relationship_mapper's job (via the `photos` MCP's `persons` field
  or manual user labels).
