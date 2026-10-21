---
name: media
description: >
  Generate media from a text prompt — images, speech audio, or video — and save
  the file to disk. Images also support image-to-image editing/compositing via a
  repeatable `--input-image` (edit a photo with a prompt, or swap a background
  using a second image). One CLI, three subcommands:
  `clawmeets media image  --prompt "..." [--size ...] [--quality ...] [--input-image PATH ...]`,
  `clawmeets media audio  --prompt "..." [--voice ...] [--format ...]`,
  `clawmeets media video  --model owner/name --prompt "..." [--duration ...] [--aspect-ratio ...] [--input-image PATH]`.
  Backend is chosen by `--provider` (or the per-agent config) — image: openai /
  gemini / nano-banana; audio: openai / elevenlabs / gemini; video: replicate /
  fal (gateways that route to Veo, Kling, etc.). Settings resolve in the order
  flag > config > env var > default, so you can run from flags alone (e.g.
  `--provider openai --api-key $KEY`) when keys are in the runner env. Each call
  prints `{media_path, media_type, provider, model, ...}` — the file lands on
  disk; share it with `update_file`. No OAuth — keys come from `--api-key`, the
  config (Agent Settings → Skills → media → Configure), or env vars.
---

# /clawmeets:media

The agent profile decides *when* media is the right output; this skill is *how*
— a Bash call to `clawmeets media <image|audio|video>`. The returned
`media_path` is an absolute filesystem path; hand it to `update_file` to surface
it in chat (the web UI plays audio/video inline and shows images inline).

## Step 1 — Build a strong prompt

Embellish a one-liner with the cues that matter for the modality before calling:
- **image** — medium, lighting, composition, subject specifics.
- **audio (TTS)** — write the exact words to speak; pick a `--voice`.
- **video** — describe motion, shot, pacing; keep clips short.

## Step 2 — Invoke

```bash
# Image (defaults to provider openai / gpt-image-2)
clawmeets media image --prompt "rustic chardonnay bottle, soft window light, top-down"
clawmeets media image --provider gemini --prompt "..." --size 16:9

# Image-to-image: edit one photo with a prompt (openai or nano-banana)
clawmeets media image --input-image /path/bottle.png --prompt "make the sky stormy, keep the bottle"
# Background swap: subject image first, background image second (nano-banana recommended)
clawmeets media image --provider nano-banana \
  --input-image /path/subject.png --input-image /path/beach.png \
  --prompt "place the subject from image 1 onto the beach in image 2"

# Speech audio
clawmeets media audio --prompt "Welcome to the tasting room." --voice alloy
clawmeets media audio --provider elevenlabs --prompt-file /tmp/script.txt

# Video (provider replicate/fal need a --model slug; runs take minutes)
clawmeets media video --model google/veo-3 --prompt "slow dolly across a vineyard at golden hour" --aspect-ratio 16:9
clawmeets media video --provider fal --model fal-ai/kling-video/v1/standard/text-to-video --prompt "..." --input-image /path/to/still.png
```

Long prompts: write to a tmpfile and pass `--prompt-file <path>`, or stream via
`--prompt -`. Flags override the per-agent config; omit them to fall back to it.

Modality flags:
- **image** `--size` (openai px `1024x1024|1024x1536|1536x1024|2048x2048|2048x3072|3072x2048|auto`; gemini
  aspect `1:1|9:16|16:9|3:4|4:3`; ignored for nano-banana) and `--quality`
  (openai only: `auto|low|medium|high`).
- **image editing** `--input-image PATH` (repeatable) turns `media image` into
  image-to-image: one input edits that photo per the prompt; two+ inputs
  composite them (first is the subject, later ones are background/reference).
  Works with `openai` (gpt-image-2) and `nano-banana` only — **not** `gemini`
  (Imagen), which errors with guidance. Prefer `nano-banana` for background
  swaps / multi-image compositing. On the openai path `--size`/`--quality` still
  apply (output aspect follows the request, not the input); nano-banana ignores
  them. No masks — editing is prompt-driven.
- **audio** `--voice` and `--format` (openai: `mp3|wav|opus|aac|flac`).
- **video** `--duration`, `--aspect-ratio`, `--input-image` (image→video). These
  are model-dependent — only pass what the chosen model accepts.

## Step 3 — Use the result

The JSON output's `media_path` (also `image_path`/`audio_path`/`video_path`) is
an absolute path. Pass it to `update_file` to share it in chat, or to other
tools (Pillow overlay, google-drive-write upload). The bytes are already on disk
— don't re-encode.

**Keep media small.** The server caps uploaded files (default ~25 MB); generate
short clips / compressed output so `update_file` doesn't get rejected with a
413.

## Step 4 — Errors

Unsupported `--provider`, a missing api_key (no flag, no config, no env var), or
a provider/model error all surface as `exit 1` with a clear message — relay it
verbatim. Video `replicate`/`fal` require a `--model` slug; without one you'll
get a clear config error.
