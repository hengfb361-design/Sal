#!/usr/bin/env python3
"""KhmerClip backend — Khmer prompt -> English translation -> short AI video.

Runs on a free Google Colab / Kaggle GPU (NVIDIA T4, 15-16 GB VRAM) or any
CUDA machine. The website is static, so this file is the whole server.

Install and run:

    pip install -r server/requirements.txt
    python server/colab_server.py --port 8000

Colab and Kaggle have no public ports, so expose it with a tunnel:

    cloudflared tunnel --url http://localhost:8000

and paste the printed https://<random>.trycloudflare.com URL into the website.

One-line bootstrap (downloads the model + starts the API + tunnel):

    curl -fsSL <raw-url>/tools/video-colab/colab-start.sh | sh

Model profiles (env VIDEO_PROFILE, default "auto" = best fit for the GPU):
    ltx         LTX-Video 2B       ~15-20 GB   high quality, 24 fps
    cogvideox   CogVideoX-5B       ~20 GB      slower, 8 fps
    zeroscope   Zeroscope v2 576w  ~9 GB       light fallback for 8 GB GPUs

Environment variables:
    VIDEO_PROFILE    ltx | cogvideox | zeroscope | auto (default)
    VIDEO_MODEL      override the Hugging Face repo id
    API_TOKEN        optional shared secret (header X-API-Token or ?token=)
    TRANSLATE_MODEL  default facebook/nllb-200-distilled-600M
    HF_TOKEN         Hugging Face token for gated/private models
    FPS              override output fps (default per profile)
    PRELOAD          "0" disables loading the model at startup
    OUTPUT_DIR       where generated MP4 files are written
    PID_FILE         write the server pid to this file (used by the bootstrap)
"""

from __future__ import annotations

import argparse
import inspect
import os
import queue
import re
import threading
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Optional

import torch
import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", str(ROOT / "outputs")))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

API_TOKEN = os.environ.get("API_TOKEN", "").strip()
TRANSLATE_MODEL = os.environ.get("TRANSLATE_MODEL", "facebook/nllb-200-distilled-600M")
FPS_OVERRIDE = os.environ.get("FPS", "").strip()
PRELOAD = os.environ.get("PRELOAD", "1").strip().lower() not in {"0", "false", "no"}
SOURCE_LANG = os.environ.get("SOURCE_LANG", "khm_Khmr")
SERVICE = "khmerclip-video"

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32
KHMER_RE = re.compile(r"[\u1780-\u17ff]")

JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()
JOB_QUEUE: "queue.Queue[str]" = queue.Queue()

PIPE_LOCK = threading.Lock()
TRANSLATOR_LOCK = threading.Lock()
_PIPE: Any = None
_TRANSLATOR: Any = None


# --------------------------------------------------------------------------- #
# Model profiles
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Profile:
    key: str
    label: str
    model: str
    fps: int
    size_multiple: int
    frame_step: int
    frame_offset: int
    min_frames: int
    max_frames: int
    min_steps: int
    guidance: float
    vae_fp32: bool
    extra_decode: bool
    negative: str
    # Supports continuing from the previous segment's last frame (used by long
    # continuous videos). LTX-Video does this natively via image conditioning.
    i2v: bool = False


PROFILES: dict[str, Profile] = {
    # ~20 GB class model: 2B DiT + T5-XXL. Best quality/speed on a T4.
    "ltx": Profile(
        key="ltx",
        label="LTX-Video 2B (គុណភាពខ្ពស់ · ~15–20 GB)",
        model="Lightricks/LTX-Video",
        fps=24,
        size_multiple=32,
        frame_step=8,
        frame_offset=1,
        min_frames=25,
        max_frames=161,
        min_steps=25,
        guidance=5.0,
        vae_fp32=True,
        extra_decode=True,
        i2v=True,
        negative="worst quality, inconsistent motion, blurry, jittery, distorted",
    ),
    # ~20 GB class model, much slower on T4 but very coherent motion.
    "cogvideox": Profile(
        key="cogvideox",
        label="CogVideoX-5B (~20 GB · យឺត)",
        model="THUDM/CogVideoX-5b",
        fps=8,
        size_multiple=8,
        frame_step=8,
        frame_offset=1,
        min_frames=41,
        max_frames=49,
        min_steps=40,
        guidance=6.0,
        vae_fp32=False,
        extra_decode=False,
        negative="blurry, low quality, distorted, watermark, text",
    ),
    # Light fallback: fits 8-16 GB cards and CPU.
    "zeroscope": Profile(
        key="zeroscope",
        label="Zeroscope v2 576w (ស្រាល · ~9 GB)",
        model="cerspense/zeroscope_v2_576w",
        fps=8,
        size_multiple=8,
        frame_step=8,
        frame_offset=0,
        min_frames=16,
        max_frames=48,
        min_steps=20,
        guidance=9.0,
        vae_fp32=False,
        extra_decode=False,
        negative="blurry, low quality, distorted, watermark, text, extra limbs",
    ),
}

# Only diffusers components: skips multi-GB single-file checkpoints in the repo.
COMPONENT_PATTERNS = [
    "model_index.json",
    "scheduler/**",
    "tokenizer/**",
    "tokenizer_2/**",
    "text_encoder/**",
    "text_encoder_2/**",
    "transformer/**",
    "vae/**",
]


def resolve_profile() -> Profile:
    """VIDEO_PROFILE wins; otherwise pick by VRAM."""
    requested = os.environ.get("VIDEO_PROFILE", "auto").strip().lower()
    profile: Optional[Profile] = PROFILES.get(requested)
    if profile is None:
        if requested not in ("", "auto"):
            print(f"[profile] unknown '{requested}', falling back to auto", flush=True)
        profile = PROFILES["zeroscope"]
        if DEVICE == "cuda":
            try:
                if torch.cuda.get_device_properties(0).total_memory / 1e9 >= 14:
                    profile = PROFILES["ltx"]
            except Exception:
                pass

    custom = os.environ.get("VIDEO_MODEL", "").strip()
    if custom:
        profile = replace(profile, model=custom)
    return profile


PROFILE = resolve_profile()
if FPS_OVERRIDE:
    try:
        PROFILE = replace(PROFILE, fps=int(FPS_OVERRIDE))
    except ValueError:
        print(f"[profile] bad FPS '{FPS_OVERRIDE}', keeping {PROFILE.fps}", flush=True)


def snap_frames(requested: int, profile: Profile = PROFILE) -> int:
    """Clamp to the profile range and round to the VAE temporal grid."""
    step = max(1, profile.frame_step)
    frames = min(max(int(requested), profile.min_frames), profile.max_frames)
    groups = max(1, round((frames - profile.frame_offset) / step))
    return groups * step + profile.frame_offset


def snap_size(value: int, profile: Profile = PROFILE) -> int:
    multiple = max(8, profile.size_multiple)
    return max(multiple, int(value) - int(value) % multiple)


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #


def download_weights(profile: Profile = PROFILE) -> str:
    """Fetch only the diffusers component weights (shows a progress bar)."""
    from huggingface_hub import snapshot_download

    print(f"[download] {profile.model} · {profile.label}", flush=True)
    path = snapshot_download(
        repo_id=profile.model,
        allow_patterns=COMPONENT_PATTERNS,
        token=os.environ.get("HF_TOKEN") or None,
    )
    print(f"[download] ready: {path}", flush=True)
    return path


def load_pipeline() -> Any:
    """Load the text-to-video pipeline once and keep it hot on the GPU."""
    global _PIPE
    if _PIPE is not None:
        return _PIPE

    with PIPE_LOCK:
        if _PIPE is not None:
            return _PIPE

        from diffusers import DiffusionPipeline, DPMSolverMultistepScheduler

        profile = PROFILE
        print(f"[model] {profile.model} ({DTYPE}) on {DEVICE} ...", flush=True)
        download_weights(profile)

        try:
            pipe = DiffusionPipeline.from_pretrained(
                profile.model, torch_dtype=DTYPE, variant="fp16"
            )
        except Exception as exc:  # most repos ship no fp16 variant
            print(f"[model] fp16 variant unavailable ({exc!r}); retrying", flush=True)
            pipe = DiffusionPipeline.from_pretrained(profile.model, torch_dtype=DTYPE)

        if profile.vae_fp32:
            # Turing has no bf16; fp16 VAEs overflow and decode black frames.
            try:
                pipe.vae.to(torch.float32)
                print("[model] VAE kept in float32 (T4 safety)", flush=True)
            except Exception as exc:
                print(f"[model] could not cast VAE: {exc!r}", flush=True)

        try:
            pipe.vae.enable_tiling()
        except Exception:
            pass

        try:
            pipe.enable_vae_slicing()
        except Exception:
            pass

        try:
            pipe.enable_attention_slicing()
        except Exception:
            pass

        if profile.key == "zeroscope":
            try:
                if not isinstance(pipe.scheduler, DPMSolverMultistepScheduler):
                    pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config)
            except Exception as exc:
                print(f"[model] scheduler unchanged: {exc!r}", flush=True)

        try:
            # Streams weights between CPU and GPU: ~8 GB peak VRAM on a T4.
            pipe.enable_model_cpu_offload()
            print("[model] CPU offload enabled", flush=True)
        except Exception as exc:
            print(f"[model] offload unavailable ({exc!r}); moving to {DEVICE}", flush=True)
            pipe.to(DEVICE)

        _PIPE = pipe

    print("[model] ready", flush=True)
    return _PIPE


def load_translator() -> Any:
    """Load the Khmer -> English translation model (NLLB-200 distilled)."""
    global _TRANSLATOR
    if _TRANSLATOR is not None:
        return _TRANSLATOR

    with TRANSLATOR_LOCK:
        if _TRANSLATOR is not None:
            return _TRANSLATOR

        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

        print(f"[translate] loading {TRANSLATE_MODEL} ...", flush=True)
        tokenizer = AutoTokenizer.from_pretrained(TRANSLATE_MODEL)
        model = AutoModelForSeq2SeqLM.from_pretrained(TRANSLATE_MODEL, torch_dtype=DTYPE)
        model.to(DEVICE)
        model.eval()
        _TRANSLATOR = (tokenizer, model)

    print("[translate] ready", flush=True)
    return _TRANSLATOR


def translate_text(text: str, source_lang: str = SOURCE_LANG) -> tuple[str, str]:
    """Translate Khmer text to English. Latin-only text passes through unchanged."""
    text = text.strip()
    if not text or not KHMER_RE.search(text):
        return text, "auto"

    tokenizer, model = load_translator()
    tokenizer.src_lang = source_lang
    batch = tokenizer(text, return_tensors="pt", padding=True, truncation=True, max_length=256)
    batch = {key: value.to(DEVICE) for key, value in batch.items()}

    with torch.inference_mode():
        generated = model.generate(
            **batch,
            forced_bos_token_id=tokenizer.convert_tokens_to_ids("eng_Latn"),
            max_new_tokens=256,
            num_beams=4,
        )

    translated = tokenizer.batch_decode(generated, skip_special_tokens=True)[0].strip()
    return (translated or text), source_lang


def export_video(frames: Any, target: Path) -> None:
    """Write frames to an H.264 MP4 (diffusers helper, imageio fallback)."""
    try:
        from diffusers.utils import export_to_video

        export_to_video(frames, str(target), fps=PROFILE.fps)
        return
    except Exception as exc:
        print(f"[encode] export_to_video failed ({exc!r}); using imageio", flush=True)

    import imageio.v2 as imageio
    import numpy as np

    imageio.mimsave(
        str(target),
        [np.asarray(frame) for frame in frames],
        fps=PROFILE.fps,
        macro_block_size=1,
    )


# --------------------------------------------------------------------------- #
# Job queue
# --------------------------------------------------------------------------- #


def update(job_id: str, **fields: Any) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is not None:
            job.update(fields)


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": job["id"],
        "status": job["status"],
        "stage": job["stage"],
        "progress": job["progress"],
        "prompt": job["prompt"],
        "translated_prompt": job.get("translated_prompt"),
        "scene_count": len(job.get("scenes") or []),
        "negative_prompt": job["negative_prompt"],
        "width": job["width"],
        "height": job["height"],
        "num_frames": job["num_frames"],
        "frames_per_segment": job.get("frames_per_segment", job["num_frames"]),
        "segments_total": job.get("segments_total", 1),
        "segments_done": job.get("segments_done", 0),
        "duration_seconds": job.get("duration_seconds"),
        "fps": job["fps"],
        "num_inference_steps": job["num_inference_steps"],
        "seed": job.get("seed"),
        "video_url": job.get("video_url"),
        "error": job.get("error"),
        "elapsed_seconds": job.get("elapsed_seconds"),
        "created_at": job["created_at"],
    }


def extract_frames(result: Any) -> Any:
    frames = result.frames
    if isinstance(frames, list) and frames and isinstance(frames[0], list):
        frames = frames[0]
    return frames


def run_job(job_id: str) -> None:
    started = time.time()
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None:
        return

    try:
        update(job_id, status="running", stage="translating", progress=3)

        prompt = job["prompt"]
        final_prompt = prompt
        scenes = job.get("scenes") or []
        scene_prompts: list[str] = []
        if scenes:
            # One prompt per scene; each scene is translated on its own.
            for scene in scenes:
                scene_prompts.append(translate_text(scene, SOURCE_LANG)[0] if job["translate"] else scene)
            final_prompt = " ".join(scene_prompts)
            update(job_id, translated_prompt=" · ".join(scene_prompts)[:400])
        elif job["translate"]:
            final_prompt = translate_text(prompt, SOURCE_LANG)[0]
        if not scenes and final_prompt.strip().lower() != prompt.strip().lower():
            update(job_id, translated_prompt=final_prompt)

        update(job_id, stage="loading_model", progress=6)
        pipe = load_pipeline()

        base_seed = job.get("seed")
        if base_seed is None:
            base_seed = int(torch.randint(0, 2**31 - 1, (1,)).item())
        update(job_id, seed=base_seed, stage="generating", progress=12)

        signature = inspect.signature(pipe.__call__).parameters
        total_steps = max(1, job["num_inference_steps"])
        segments_total = max(1, int(job.get("segments_total") or 1))
        frames_per_segment = int(job.get("frames_per_segment") or job["num_frames"])
        if segments_total == 1:
            frames_per_segment = int(job["num_frames"])
        total_frames = max(1, int(job.get("num_frames") or 1))

        stitched: list[Any] = []
        frames_done = 0
        for segment_index in range(segments_total):
            update(job_id, segments_done=segment_index)

            segment_prompt = (
                scene_prompts[segment_index]
                if segment_index < len(scene_prompts)
                else final_prompt
            )
            call_kwargs: dict[str, Any] = {
                "prompt": segment_prompt,
                "negative_prompt": job["negative_prompt"] or PROFILE.negative,
                "num_inference_steps": total_steps,
                "num_frames": frames_per_segment,
                "height": job["height"],
                "width": job["width"],
                "guidance_scale": job["guidance_scale"],
                "generator": torch.Generator(device=DEVICE).manual_seed(
                    int(base_seed) + segment_index
                ),
            }

            if PROFILE.extra_decode:
                if "decode_timestep" in signature:
                    call_kwargs["decode_timestep"] = 0.05
                if "decode_noise_scale" in signature:
                    call_kwargs["decode_noise_scale"] = 0.025

            # Continuation: each segment after the first starts from the last
            # frame of the previous one (image conditioning), so the final MP4
            # plays as one continuous take with no visible cuts between segments.
            if segment_index > 0 and PROFILE.i2v and "image" in signature:
                try:
                    import numpy as np
                    from PIL import Image as PILImage

                    anchor = stitched[-1][-1]
                    call_kwargs["image"] = (
                        anchor
                        if isinstance(anchor, PILImage.Image)
                        else PILImage.fromarray(np.asarray(anchor))
                    )
                except Exception as exc:
                    print(f"[job {job_id}] image continuation unavailable: {exc!r}", flush=True)

            if "callback_on_step_end" in signature:

                def on_step(_pipe: Any, step_index: int, _timestep: Any, callback_kwargs: dict) -> dict:
                    if segments_total == 1:
                        update(job_id, progress=int(12 + 78 * (step_index + 1) / total_steps))
                    else:
                        done = frames_done + (step_index + 1) * frames_per_segment / total_steps
                        update(
                            job_id,
                            progress=int(12 + 78 * min(1.0, done / total_frames)),
                            segments_done=segment_index,
                        )
                    return callback_kwargs

                call_kwargs["callback_on_step_end"] = on_step
                call_kwargs["callback_on_step_end_tensor_inputs"] = ["latents"]

            frames = extract_frames(pipe(**call_kwargs))
            stitched.extend(frames)
            frames_done += len(frames)
            update(job_id, segments_done=segment_index + 1)
            print(f"[job {job_id}] segment {segment_index + 1}/{segments_total} done", flush=True)

        update(job_id, stage="encoding", progress=92)
        filename = f"{job_id}.mp4"
        export_video(stitched, OUTPUT_DIR / filename)

        update(
            job_id,
            status="done",
            stage="done",
            progress=100,
            video_url=f"/api/videos/{filename}",
            elapsed_seconds=round(time.time() - started, 1),
        )
        print(f"[job {job_id}] done in {time.time() - started:.0f}s", flush=True)

    except Exception as exc:  # surface every failure to the browser
        print(f"[job {job_id}] failed: {exc!r}", flush=True)
        update(
            job_id,
            status="error",
            stage="done",
            error=str(exc)[:800] or exc.__class__.__name__,
            elapsed_seconds=round(time.time() - started, 1),
        )


def worker_loop() -> None:
    while True:
        job_id = JOB_QUEUE.get()
        try:
            run_job(job_id)
        except Exception as exc:
            print(f"[worker] unexpected error: {exc!r}", flush=True)
            update(job_id, status="error", error=str(exc)[:800])
        finally:
            JOB_QUEUE.task_done()


def warm_up() -> None:
    try:
        load_pipeline()
    except Exception as exc:
        print(f"[model] warm-up failed: {exc!r}", flush=True)


# --------------------------------------------------------------------------- #
# HTTP API
# --------------------------------------------------------------------------- #


@asynccontextmanager
async def lifespan(_: FastAPI):
    threading.Thread(target=worker_loop, name="job-worker", daemon=True).start()
    if PRELOAD:
        threading.Thread(target=warm_up, name="warm-up", daemon=True).start()
    yield


app = FastAPI(title="KhmerClip T4 server", version="2.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def require_token(
    x_api_token: Optional[str] = Header(default=None),
    token: Optional[str] = Query(default=None),
) -> None:
    if not API_TOKEN:
        return
    if x_api_token == API_TOKEN or token == API_TOKEN:
        return
    raise HTTPException(status_code=401, detail="Invalid or missing API token")


class TranslateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1200)
    source_lang: str = SOURCE_LANG


class TranslateResponse(BaseModel):
    source_lang: str
    translated_prompt: str
    model: str
    translated: bool


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=1200)
    negative_prompt: str = ""
    width: int = Field(default=576, ge=256, le=768)
    height: int = Field(default=320, ge=256, le=768)
    num_frames: int = Field(default=49, ge=8, le=257)
    num_inference_steps: int = Field(default=30, ge=4, le=60)
    guidance_scale: Optional[float] = Field(default=None, ge=1.0, le=20.0)
    seed: Optional[int] = None
    duration_seconds: Optional[int] = Field(default=None, ge=2, le=120)
    # One prompt per scene (Google Flow style): each line becomes a ~6-7s shot,
    # chained onto the previous shot's last frame with no visible cuts.
    scenes: Optional[list[str]] = Field(default=None)
    translate: bool = True


@app.get("/")
def index() -> dict[str, Any]:
    return {
        "service": SERVICE,
        "name": "KhmerClip video server",
        "profile": PROFILE.key,
        "model": PROFILE.model,
        "docs": "/docs",
        "health": "/api/health",
    }


@app.get("/api/health")
def api_health() -> dict[str, Any]:
    gpu = None
    vram_gb = None
    if torch.cuda.is_available():
        props = torch.cuda.get_device_properties(0)
        gpu = torch.cuda.get_device_name(0)
        vram_gb = round(props.total_memory / 1e9, 1)

    with JOBS_LOCK:
        jobs = list(JOBS.values())
        busy = any(j["status"] in ("queued", "running") for j in jobs)

    return {
        "service": SERVICE,
        "status": "ok",
        "device": DEVICE,
        "gpu": gpu,
        "vram_gb": vram_gb,
        "profile": PROFILE.key,
        "profile_label": PROFILE.label,
        "video_model": PROFILE.model,
        "translate_model": TRANSLATE_MODEL,
        "fps": PROFILE.fps,
        "max_frames": PROFILE.max_frames,
        "torch": torch.__version__,
        "busy": busy,
        "queue_size": JOB_QUEUE.qsize(),
        "model_loaded": _PIPE is not None,
        "long_video": PROFILE.i2v,
        "max_duration_seconds": PROFILE.max_frames // PROFILE.fps,
    }


@app.post("/api/translate", response_model=TranslateResponse, dependencies=[Depends(require_token)])
def api_translate(payload: TranslateRequest) -> TranslateResponse:
    translated, source = translate_text(payload.text, payload.source_lang or SOURCE_LANG)
    used_model = source != "auto"
    return TranslateResponse(
        source_lang=source,
        translated_prompt=translated,
        model=TRANSLATE_MODEL if used_model else "none",
        translated=used_model,
    )


@app.post("/api/generate", dependencies=[Depends(require_token)])
def api_generate(payload: GenerateRequest) -> dict[str, Any]:
    prompt = payload.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is empty")

    # Long mode: the video is generated segment by segment, each segment
    # continuing from the last frame of the previous one, then stitched into
    # a single MP4 — one continuous take with no visible cuts.
    payload_duration = payload.duration_seconds
    scene_list = [s.strip() for s in (payload.scenes or []) if s.strip()][:30]
    using_scenes = len(scene_list) > 1 and PROFILE.i2v
    segments_total = 1
    frames_per_segment = snap_frames(payload.num_frames)
    if using_scenes:
        # Google Flow style: one ~6-7s shot per line (PROFILE.max_frames).
        segments_total = len(scene_list)
        frames_per_segment = PROFILE.max_frames
    elif payload_duration and PROFILE.i2v:
        target_frames = payload_duration * PROFILE.fps
        segments_total = max(1, -(-target_frames // PROFILE.max_frames))
        frames_per_segment = snap_frames(
            min(PROFILE.max_frames, max(PROFILE.min_frames, -(-target_frames // segments_total)))
        )
        while segments_total * frames_per_segment < target_frames:
            segments_total += 1

    job_id = uuid.uuid4().hex[:12]
    job: dict[str, Any] = {
        "id": job_id,
        "status": "queued",
        "stage": "queued",
        "progress": 0,
        "prompt": prompt,
        "translated_prompt": None,
        "scenes": scene_list if using_scenes else [],
        "negative_prompt": payload.negative_prompt.strip(),
        "width": snap_size(payload.width),
        "height": snap_size(payload.height),
        "num_frames": segments_total * frames_per_segment,
        "frames_per_segment": frames_per_segment,
        "segments_total": segments_total,
        "segments_done": 0,
        "duration_seconds": payload_duration if segments_total > 1 else None,
        "fps": PROFILE.fps,
        "num_inference_steps": max(payload.num_inference_steps, PROFILE.min_steps),
        "guidance_scale": payload.guidance_scale
        if payload.guidance_scale is not None
        else PROFILE.guidance,
        "seed": payload.seed,
        "translate": payload.translate,
        "video_url": None,
        "error": None,
        "elapsed_seconds": None,
        "created_at": time.time(),
    }

    with JOBS_LOCK:
        JOBS[job_id] = job
        # Keep memory bounded: only the 60 newest jobs are kept.
        if len(JOBS) > 60:
            for old_id in sorted(JOBS, key=lambda key: JOBS[key]["created_at"])[: len(JOBS) - 60]:
                JOBS.pop(old_id, None)

    JOB_QUEUE.put(job_id)
    return public_job(job)


@app.get("/api/jobs/{job_id}", dependencies=[Depends(require_token)])
def api_job(job_id: str) -> dict[str, Any]:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        snapshot = dict(job) if job else None
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return public_job(snapshot)


@app.get("/api/videos/{name}")
def api_video(
    name: str,
    token: Optional[str] = Query(default=None),
    x_api_token: Optional[str] = Header(default=None),
) -> FileResponse:
    if API_TOKEN and token != API_TOKEN and x_api_token != API_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing API token")
    if not name.endswith(".mp4") or "/" in name or ".." in name:
        raise HTTPException(status_code=400, detail="Invalid video name")

    path = OUTPUT_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Video not found")
    return FileResponse(path, media_type="video/mp4", filename=name)


def main() -> None:
    parser = argparse.ArgumentParser(description="KhmerClip text-to-video server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    args = parser.parse_args()

    pid_file = os.environ.get("PID_FILE", "").strip()
    if pid_file:
        try:
            Path(pid_file).write_text(str(os.getpid()), encoding="utf-8")
        except OSError as exc:
            print(f"[pid] could not write {pid_file}: {exc!r}", flush=True)

    gpu_name = torch.cuda.get_device_name(0) if DEVICE == "cuda" else "cpu"
    print("=" * 66)
    print(" KhmerClip video server")
    print(f" device      : {DEVICE} ({gpu_name})")
    print(f" profile     : {PROFILE.key} — {PROFILE.label}")
    print(f" video model : {PROFILE.model} @ {PROFILE.fps} fps")
    print(f" translate   : {TRANSLATE_MODEL}")
    print(f" token       : {'enabled' if API_TOKEN else 'disabled'}")
    print(f" listening   : http://{args.host}:{args.port}")
    print("=" * 66, flush=True)

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
