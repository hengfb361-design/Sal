---
title: KhmerDub AI
emoji: 🎙️
colorFrom: green
colorTo: teal
sdk: docker
app_port: 7860
pinned: false
short_description: AI video translation with natural Khmer dubbing
---

# KhmerDub AI

AI video translation and natural dubbing. Upload a video, and the pipeline
splits the voices out of the music, transcribes the speech, translates it into
the language you choose (**Khmer** by default, or
English/Chinese/Thai/Vietnamese/Korean/Japanese/French/Spanish), speaks the
translation with gTTS, keeps the original music/background, and muxes a new MP4
with subtitles.

There is no account to create and no history to keep: every visit opens the
studio, uploads straight away, and hands back the finished file. This Space runs
the **whole app** (frontend + API) from one container.

## Pipeline

Six engines, in the order they run:

| Step | Engine |
| --- | --- |
| 1. Upload Video | upload + FFmpeg audio extraction |
| 2. Demucs | Demucs (remote stem API) — ញែកសំឡេងនិយាយចេញពីតន្ត្រី/ផ្ទៃខាងក្រោយ |
| 3. ASR | Whisper via Groq `whisper-large-v3` — បំលែងសំឡេងទៅជាអក្សរ |
| 4. Google Translate | the free `translate_a/single` endpoint — the same one the Python `googletrans` package uses. **No API key and no model download**: each line is one HTTPS request, translated into the **target language** the studio picked (Khmer by default). Transcript fragments Whisper split mid-sentence are rejoined first, and a **Khmer** target is sanitised (no Thai/Lao); any other target keeps its own script untouched |
| 5. gTTS | Google Translate's own `translate_tts` endpoint — what the `gTTS` package wraps. Keyless, no voice model, one MP3 per request (a long line is cut at punctuation into ≤180-character pieces and joined back into one WAV) |
| 6. Sync + FFmpeg | every line is placed on the timestamp where it was spoken (`adelay`), mixed under the kept music/background, and muxed back into the video as the final MP4 |

The studio's checklist shows the first four rows — upload, Demucs, ASR and
translate. The voice, the subtitle track and the final render run after them and
the overall progress bar carries that work.

Nothing is lost by not naming those closing steps. The voice is already in time
when the mixer starts, and that costs nothing extra:

- The assembler places every line at its own timestamp (`adelay`) and pads the
  track to the video's length (`apad=whole_dur`), so a line starts where it was
  spoken even though the translated sentence is longer than the original one.
- The render caps the result at the video's own length (`-t meta.duration`), so the
  file can never end a frame early or leave the last frames in silence.
- The mixer balances the dubbed voice against the background music. When the
  background still carries the original voices (a mono source that could not be
  separated) it is ducked inside the dialogue windows instead.

A measuring pass over the finished track was tried and removed: it needed a second
full-length audio decode per job and only confirmed what the assembler and the
render already guarantee.

## Stem separation (Demucs required)

Splitting the voices out of the mix runs on Demucs, reached over HTTP. Model
separation is never faked: a job that reaches Demucs gets real stems.

Demucs is a **requirement**, not an upgrade. Removing the original voices is what
lets the Khmer dub be the dialogue instead of a voice laid over the source one,
and nothing else in the pipeline does it. So with no service connected the upload
endpoint refuses the video (HTTP 400, `DEMUCS_REQUIRED_MESSAGE`), and a job whose
service breaks mid-run fails with the service's own reason instead of publishing a
dub played under the original voices. `getAudioSeparationProvider()` has no
fallback provider for exactly this reason.

Set `AUDIO_SEPARATOR_URL` to wherever Demucs runs:

| Host | How |
| --- | --- |
| Phone (Termux) | `tools/demucs-termux/` starts the API and a tunnel |
| **Google Colab (GPU)** | `tools/demucs-colab/` — one cell installs, serves and tunnels the API |
| Home server / VPS | `tools/demucs-termux/run-local.sh` |
| Bundled sidecar | `tools/audio-separator-server/` |

Translation and voice need no service to connect: both are the public Google
endpoints described above, reached from the server's own HTTPS request.

Google throttles a datacenter IP it does not recognise, and a free host shares
its address with every other tenant on that machine — on Render every line came
back `429`, which left the `2/2 lines could not be translated` warning and an
English dub under Khmer captions. So the lines Google refuses are translated by
**Groq** instead, with the same `GROQ_API_KEY` the speech-to-text step already
needs: they are batched (~20 lines per request) and answered as JSON. Three
refusals in a row mark Google as blocked for the next ten minutes, so the rest of
the job does not spend four backoff rounds per line. A deployment without a Groq
key still gets the keyless `api.mymemory.translated.net` fallback, and a line
nothing could translate keeps its original text and says so in the job warning.

Overrides: `GROQ_TRANSLATION_MODEL` (default: the first of
`llama-3.3-70b-versatile`, `openai/gpt-oss-120b`, `llama-3.1-8b-instant` the
account offers), `GROQ_TRANSLATION_LINES_PER_CALL`,
`GOOGLE_TRANSLATE_HOSTS`, `GOOGLE_TRANSLATE_FALLBACK=off`,
`GOOGLE_TRANSLATE_BLOCK_MS`.

Colab is the fast option: the same `demucs_api.py` runs on a free GPU, so the API
answers with `"device":"cuda"` and the pipeline then sends it far bigger pieces
(`AUDIO_SEPARATOR_GPU_CHUNK_SECONDS`, 90s by default) instead of the 15s pieces a
phone needs — a CPU service keeps the phone-sized default.

The URL can also be pasted into the `ញែកភ្លេង · Demucs API` panel in the studio,
and that value wins over the environment variable — a phone tunnel gets a
new URL every time it is reopened, so re-pointing it must not need a redeploy.

## Target language

The studio translates into one of nine languages. **Khmer is the default** and a
job without the setting behaves exactly as it did before the picker existed; pick
another language and both the dub and the caption track follow it. The whole
pipeline is target-aware:

- translation asks Google Translate for the chosen target code (`zh` is sent as
  `zh-CN`, every other language keeps its own two-letter code);
- gTTS speaks it (`km`, `en`, `zh-CN`, `th`, `vi`, `ko`, `ja`, `fr`, `es`). The
  free endpoint has one voice per language, so the studio's male/female choice
  cannot change the speaker here — every line is spoken by that language's gTTS
  voice.
- the MP4's caption track is tagged with the target's ISO 639-3 code, so the
  player's CC badge names the right language.

## Subtitles

The finished MP4 carries the translated text as a caption track inside the file
(`mov_text`, language `khm` for Khmer — the target's own code otherwise), never
painted onto the picture: the frame stays clean, and every cue comes from the
same timeline as the audio, so the words always stay in sync with what is being
said. The result panel starts with the
text hidden — **បង្ហាញអក្សររត់** shows it, **លាក់អក្សររត់** hides it again, and any
player's own CC button does the same. `subtitles-<id>.srt` and `.vtt` are still
produced next to the file, for editing or for loading as a separate track.

Painting text onto frames — how jobs were made before this change — needs a
Khmer font, which the hosts this runs on do not have, so
`assets/fonts/NotoSansKhmer-*.ttf` travels with the repository, and a missing one
is downloaded into `data/fonts` once (`SUBTITLE_FONTS_DIR` overrides where it
looks). New jobs skip drawing entirely: captions are a track, so no font can
fail a render and no text can cover the picture.

### Turning the subtitles off

Nothing has to be switched off at render time: every job produces a single clean
MP4 with the captions inside it as a hidden track, and the panel's
**បង្ហាញអក្សររត់ / លាក់អក្សររត់** button only shows or hides them while watching.
The one download button hands over that same file — clean picture, translated
captions included. Jobs made before this change still have their burned-in text
plus the subtitle-free twin (`khmer-dubbed-clean-<id>.mp4`), and their old links
keep working.

Set `subtitle: false` in a job's settings to leave the caption track out.

## Voice timing (Sync)

Each line is placed at the timestamp where it was spoken (`adelay`), so every
entry lands on the mouth it belongs to. A translated line is often longer than
the source one — Khmer gTTS speech runs longer than the English it replaces — so
one extra pass keeps the dub from talking over itself:

- **Only overflowing lines are touched.** The sync pass compares each line with
  the gap to the next spoken line; anything that already fits (or overruns by
  less than 8%, which lands in the pause) is used exactly as gTTS produced it.
- **Nothing is cut.** An overflowing line is time-stretched with `atempo` (pitch
  preserved), capped at `DUB_SYNC_MAX_TEMPO` (1.75× by default), so it ends
  before the next line starts. A line that even the cap cannot fit plays out as
  before and `amix`/the render cap handle the rest.
- The pass costs one short FFmpeg run per overflowing line — not per line — and
  `DUB_SYNC_ENABLED=false` turns it off. Khmer gTTS speech often runs nearly
  twice as long as the English it replaces, which is why the default cap is
  1.75×: below that, dense dialogue still overlaps.

The MP4 is still capped at the video's own length, so the file can never end a
frame early or leave the last frames in silence.

## Required secrets

Add these in **Settings → Variables and secrets** as **Secrets** (not variables):

| Name | Required | Notes |
| --- | --- | --- |
| `GROQ_API_KEY` | yes | [console.groq.com/keys](https://console.groq.com/keys) — speech-to-text only |
| `GROQ_API_KEY2`, `GROQ_API_KEY3` | optional | Extra keys; the app rotates to them automatically on 401/429 |
| `STT_PROVIDER` | optional | `groq` (default) |
| `AUDIO_SEPARATOR_URL` | yes | Base URL of the Demucs stem service |
| `AUDIO_SEPARATOR_API_KEY` | optional | Bearer token, when the service has one |
| `FFMPEG_RENDER_ARGS` | optional | x264 settings for the release MP4 (default `-preset veryfast -crf 21`) |
| `GOOGLE_TRANSLATE_CONCURRENCY` | optional | Lines translated at once (default 6) |
| `TTS_CONCURRENCY` | optional | Lines voiced at once (default 3) |

Translation and voice need **no key**: Google Translate and gTTS are called
keylessly. `GOOGLE_TRANSLATE_ENABLED=false` / `GTTS_ENABLED=false` are the only
switches, and they exist so a deployment can take those stages out on purpose.

The release encode is the slowest step on a free host, which has a fraction of
one CPU, so its settings are chosen for that: the measurements behind
`RENDER_ENCODER_ARGS` in `server/utils/ffmpeg.ts` are written next to the
constant. `-preset ultrafast -crf 24` is roughly 3x faster again but writes a
much larger file, which is the trade `FFMPEG_RENDER_ARGS` exists to make
without a code change.

Optional — keep results after a restart. A Space's disk is **ephemeral**, so
uploads and outputs are lost whenever the container restarts. Point the app at a
Cloudflare R2 / S3 bucket to persist them:

| Name | Notes |
| --- | --- |
| `S3_ENDPOINT` | e.g. `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_BUCKET` | bucket name |
| `S3_ACCESS_KEY_ID` | R2 access key id |
| `S3_SECRET_ACCESS_KEY` | R2 secret access key |

## Hosting notes

- Hugging Face only allows **Static** Spaces on the free plan; Gradio and Docker
  Spaces need a PRO subscription. Deploy this folder elsewhere for free — see
  `render.yaml` for a Render free web service — or self-host it.
- Free instances sleep after a period of inactivity and wake on the next visit.
- Translation and voice run on Google's public endpoints, so there is no Colab
  session to keep alive: the translate stage is always ready. Those endpoints are
  keyless but shared by IP, so a throttled request (429) is retried on a second
  host with a short backoff and, if it still fails, that one line keeps the
  original text and says so in the job warning. `GOOGLE_TRANSLATE_CONCURRENCY` and
  `TTS_CONCURRENCY` lower the parallel requests if a host is being throttled.
- Demucs is still the one service you must run somewhere (see above) and
  `GROQ_API_KEY` is still required for the ASR step.
- Video processing is CPU-bound: a ~1 minute video takes roughly 1–3 minutes.

## Local / self-hosted run

```sh
bun install
bun run dev      # http://localhost:3000
# or, production mode:
bun run build && npm start
```

Deploy this folder to a Space with `HF_TOKEN=... sh scripts/deploy-hf.sh`.
