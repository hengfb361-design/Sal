#!/usr/bin/env sh
# បើក KhmerClip Video API (prompt ខ្មែរ → វីដេអូ) លើ Colab/Kaggle GPU + tunnel — បញ្ជាតែមួយ។
#
# ក្នុង Colab/Kaggle cell មួយ គ្រាន់តែ paste បន្ទាត់នេះ (runtime ត្រូវមាន GPU)៖
#
# !curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/video-colab/colab-start.sh | sh
#
# វាធ្វើអ្វីខ្លះ៖
# ១. ពិនិត្យ GPU + VRAM (T4 = ១៥–១៦ GB)
# ២. ដំឡើង diffusers / transformers / fastapi (រក្សា torch ដើមរបស់ Colab/Kaggle)
# ៣. ទាញ colab_server.py ពី repo (ឯកសារតែមួយបេះបិទនឹង server/)
# ៤. បង្កើត API token (បើអ្នកមិនកំណត់ API_TOKEN)
# ៥. ទាញយក model (~១៥–២០ GB) — ធ្វើតែម្ដង រួច cache
# ៦. បើក API នៅ port 8002 (NLLB=8000 · Demucs=8001 — រត់ជាមួយគ្នាបាន)
# ៧. បើក cloudflared quick tunnel + ផ្ទៀងផ្ទាត់ពីខាងក្រៅ
# ៨. បង្ហាញ URL + API key + endpoints សម្រាប់ paste ក្នុង website
#
# កំណត់តាម env បាន (ស្រេចចិត្ត)៖
# VIDEO_PROFILE=ltx|cogvideox|zeroscope|auto  (auto = ជ្រើសតាម VRAM; T4 → ltx)
# VIDEO_MODEL=<hf repo id>                    ប្រើ model ផ្សេង
# PORT=8002                                   port (tunnel បញ្ជូនមក port នេះ)
# API_TOKEN=<key ផ្ទាល់ខ្លួន>                  បើទទេ = បង្កើតថ្មីឱ្យស្វ័យប្រវត្តិ
# VIDEO_HOME=/content/video-api               កន្លែងទុកឯកសារ
# VIDEO_URL=<url ទៅ colab_server.py>          កំណត់ផ្ទាល់ពីកន្លែងទាញ
# HF_TOKEN=<hf token>                         បើ model ត្រូវការ token
#
# ⚠️ Colab/Kaggle ជាម៉ាស៊ីនបណ្តោះអាសន្ន៖ បិទ tab ឬទុក idle = session ដាច់ ហើយ URL ស្លាប់។
# ពេលនោះ បើក cell នេះម្ដងទៀត រួច paste URL ថ្មីក្នុង website។
set -u

PORT="${PORT:-8002}"
PROFILE="${VIDEO_PROFILE:-auto}"
# កន្លែងទាញ colab_server.py — សាកតាមលំដាប់ (VIDEO_RAW → repo ដើម → fork) រហូតទាល់តែបាន។
RAW_UPSTREAM="https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/video-colab"
RAW_FORK="https://raw.githubusercontent.com/hengfb361-design/Sal/main/tools/video-colab"
RAW_MIRROR="https://raw.githubusercontent.com/hengfb361-design/khmerclip-video/main/tools/video-colab"
RAW_MIRROR_SERVER="https://raw.githubusercontent.com/hengfb361-design/khmerclip-video/main/server"
# សាកគ្រប់កន្លែងដែលអាចមានឯកសារ រហូតទាល់តែបាន (VIDEO_URL ជាការកំណត់ផ្ទាល់)
SERVER_PY_URLS="${VIDEO_URL:-} $RAW_UPSTREAM/colab_server.py $RAW_FORK/colab_server.py $RAW_MIRROR/colab_server.py $RAW_MIRROR_SERVER/colab_server.py"
DIR="${VIDEO_HOME:-}"
if [ -z "$DIR" ]; then
  if [ -d /content ] && [ -w /content ]; then
    DIR=/content/video-api
  elif [ -d /kaggle/working ] && [ -w /kaggle/working ]; then
    DIR=/kaggle/working/video-api
  else
    DIR="$HOME/video-api"
  fi
fi

say() { printf '\n===== %s =====\n' "$1"; }
api_up() { curl -s --max-time 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -qi 'khmerclip-video'; }
port_busy() { curl -s --max-time 2 "http://127.0.0.1:$1/" >/dev/null 2>&1; }

mkdir -p "$DIR" || { echo "❌ បង្កើតថត $DIR មិនបានទេ"; exit 1; }
cd "$DIR" || { echo "❌ ចូលថត $DIR មិនបានទេ"; exit 1; }

say "១/៨ ពិនិត្យ GPU"
python3 - <<'PY' || echo " (រកមិនឃើញ torch — នឹងដំឡើងនៅជំហានបន្ទាប់)"
try:
    import torch
    if torch.cuda.is_available():
        count = torch.cuda.device_count()
        for index in range(count):
            props = torch.cuda.get_device_properties(index)
            print(f" GPU {index}: {props.name} · {props.total_memory / 1e9:.1f} GB")
        print(f" ចំនួន GPU: {count}  (VRAM មិនរួមគ្នាទេ — ប្រើតែ GPU 0)")
        print(f" CUDA {torch.version.cuda} · torch {torch.__version__}")
    else:
        print(" គ្មាន GPU ក្នុង runtime នេះ — API នឹងដើរលើ CPU (យឺតខ្លាំង)")
        print(" ➜ Colab: Runtime → Change runtime type → T4 GPU")
        print(" ➜ Kaggle: Settings → Accelerator → GPU T4 x2")
except Exception as err:  # noqa: BLE001
    print(" torch មិនទាន់មាន៖", err)
PY

say "២/៨ ដំឡើង libraries (១–៣ នាទី)"
deps_ok() { python3 -c "import diffusers, transformers, fastapi, uvicorn, imageio, huggingface_hub" >/dev/null 2>&1; }
if ! deps_ok; then
  pip install -q --disable-pip-version-check --no-input \
    "diffusers>=0.33" "transformers>=4.46" "accelerate>=1.0" safetensors \
    sentencepiece protobuf imageio imageio-ffmpeg fastapi "uvicorn[standard]" \
    huggingface_hub || true
fi
if ! deps_ok; then
  echo "❌ ដំឡើង libraries មិនចេញទេ។ សារកំហុសចុងក្រោយ៖"
  pip install diffusers transformers fastapi uvicorn 2>&1 | tail -15
  exit 1
fi
# LTX-Video ត្រូវការ diffusers ថ្មីគ្រប់គ្រាន់ (មាន LTXPipeline)។
python3 -c "from diffusers import LTXPipeline" >/dev/null 2>&1 \
  || pip install -q -U "diffusers>=0.33" || true
echo "libraries រួចរាល់ ✅"

say "៣/៨ ទាញឯកសារ API (colab_server.py)"
SERVER_PY="$DIR/colab_server.py"
if [ -n "${SERVER_FILE:-}" ] && [ -f "${SERVER_FILE}" ]; then
  cp "$SERVER_FILE" "$SERVER_PY"
elif [ -f "$DIR/project/server/colab_server.py" ]; then
  cp "$DIR/project/server/colab_server.py" "$SERVER_PY"
else
  fetched=0
  for src in $SERVER_PY_URLS; do
    if curl -fsSL -o "$SERVER_PY.new" "$src"; then
      mv "$SERVER_PY.new" "$SERVER_PY"
      echo " ទាញបានពី $src"
      fetched=1
      break
    fi
  done
  if [ "$fetched" = "0" ]; then
    echo "❌ ទាញ colab_server.py មិនបាន — សាកហើយ៖"
    for src in $SERVER_PY_URLS; do echo "     $src"; done
    echo "   ដាក់ colab_server.py ក្នុង repo ត្រង់ tools/video-colab/ ឬ upload មក $SERVER_PY"
    exit 1
  fi
fi
ls -l "$SERVER_PY"

say "៤/៨ បង្កើត API token"
KEY="${API_TOKEN:-}"
if [ -z "$KEY" ]; then
  KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
fi
echo " API token រួចរាល់ — បង្ហាញនៅចុងក្រោយ"

say "៥/៨ ទាញយក model (ប្រហែល ១៥–២០ GB · ធ្វើតែម្ដង រួច cache)"
if ! SERVER_PY="$SERVER_PY" VIDEO_PROFILE="$PROFILE" HF_TOKEN="${HF_TOKEN:-}" python3 - <<'PY'
import importlib.util
import os
import sys

# សំខាន់៖ ត្រូវចុះ module ចូល sys.modules មុន exec — បុីនៃការប្រើ @dataclass
# គ្មានវា Python រក cls.__module__ ក្នុង sys.modules មិនឃើញ →
# AttributeError: 'NoneType' object has no attribute '__dict__'។
name = "khmerclip_backend"
spec = importlib.util.spec_from_file_location(name, os.environ["SERVER_PY"])
backend = importlib.util.module_from_spec(spec)
sys.modules[name] = backend
spec.loader.exec_module(backend)

print(" profile :", backend.PROFILE.key, "—", backend.PROFILE.label)
print(" model   :", backend.PROFILE.model)
path = backend.download_weights(backend.PROFILE)

total = 0
for root, _dirs, files in os.walk(path):
    for name in files:
        try:
            total += os.path.getsize(os.path.join(root, name))
        except OSError:
            pass
print(f" ✅ model ready · {total / 1e9:.1f} GB · {path}")
PY
then
  echo "❌ ទាញយក model មិនចេញទេ — សូមអាន error/traceback ខាងលើ (ពិនិត្យ internet / disk ផង)"
  exit 1
fi

say "៦/៨ បើក API នៅ port $PORT"
if [ -f "$DIR/api.pid" ]; then
  OLD="$(cat "$DIR/api.pid" 2>/dev/null || true)"
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    kill "$OLD" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$DIR/api.pid"
fi
_tries=0
while [ "$_tries" -lt 12 ]; do
  if ! port_busy "$PORT" || api_up; then break; fi
  echo " ⚠️ port $PORT មានសេវាផ្សេងកាន់រួច — សាក port $((PORT + 1))..."
  PORT=$((PORT + 1))
  _tries=$((_tries + 1))
done

: > "$DIR/api.log"
# setsid ដើម្បីឱ្យ API មិនត្រូវបិទពេល cell ចប់។ `< /dev/null` សំខាន់ពេលស្គ្រីបមកពី
# `curl | sh`៖ កូន process មិនត្រូវកាន់ stdin (ដែលជា pipe ស្គ្រីប) ទេ។
PID_FILE="$DIR/api.pid" API_TOKEN="$KEY" VIDEO_PROFILE="$PROFILE" PORT="$PORT" \
  setsid python3 "$SERVER_PY" --port "$PORT" > "$DIR/api.log" 2>&1 < /dev/null &

i=0
while [ "$i" -lt 90 ]; do
  api_up && break
  i=$((i + 1))
  sleep 1
done
if ! api_up; then
  echo "❌ API មិនឡើងទេ។ សារកំហុសចុងក្រោយ៖"
  tail -25 "$DIR/api.log"
  exit 1
fi
printf '%s\n' "$PORT" > "$DIR/port.txt" 2>/dev/null || true
echo "API ដំណើរការហើយ ✅"

say "៧/៨ បើក tunnel (Cloudflare)"
LOG="$DIR/cloudflared.log"
CF_BIN="$(command -v cloudflared 2>/dev/null || true)"
if [ -z "$CF_BIN" ]; then
  CF_BIN="$DIR/cloudflared"
  if [ ! -x "$CF_BIN" ]; then
    case "$(uname -m)" in
      aarch64|arm64) A=arm64 ;;
      armv7l|armv8l) A=arm ;;
      *) A=amd64 ;;
    esac
    echo "ដំឡើង cloudflared ($A)..."
    curl -fsSL -o "$CF_BIN" \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$A" \
      || { echo "❌ ទាញ cloudflared មិនបាន"; exit 1; }
    chmod +x "$CF_BIN" 2>/dev/null || true
  fi
fi

REUSE=""
PREV=""
if [ -f "$DIR/tunnel-url.txt" ]; then
  PREV=$(head -n 1 "$DIR/tunnel-url.txt" 2>/dev/null | tr -d ' \r\n')
fi
if [ -n "$PREV" ] && curl -s --max-time 10 "$PREV/api/health" 2>/dev/null | grep -qi 'khmerclip-video'; then
  REUSE="$PREV"
fi

if [ -z "$REUSE" ]; then
  : > "$LOG"
  # បិទ tunnel ចាស់របស់សេវានេះតាម pid ដែលយើងកត់ទុក (មិនប្រើ pattern ទូទៅ)។
  if [ -f "$DIR/tunnel.pid" ]; then
    OLD_T="$(cat "$DIR/tunnel.pid" 2>/dev/null || true)"
    if [ -n "$OLD_T" ] && kill -0 "$OLD_T" 2>/dev/null; then
      kill "$OLD_T" 2>/dev/null || true
      sleep 1
    fi
  fi
  setsid "$CF_BIN" tunnel --protocol http2 --edge-ip-version 4 --no-autoupdate \
    --url "http://127.0.0.1:$PORT" > "$LOG" 2>&1 < /dev/null &
  printf '%s\n' "$!" > "$DIR/tunnel.pid" 2>/dev/null || true
else
  echo "Tunnel ចាស់នៅដើរ — ប្រើ URL ដដែល ✅"
fi

wait_url() { # $1=log $2=គំរូ $3=វិនាទី
  n=0
  found=""
  while [ "$n" -lt "$3" ]; do
    found=$(grep -o "$2" "$1" 2>/dev/null | tail -1 || true)
    if [ -n "$found" ]; then
      printf '%s' "$found"
      return 0
    fi
    n=$((n + 1))
    printf '.' >&2
    sleep 1
  done
  return 1
}

if [ -n "$REUSE" ]; then
  URL="$REUSE"
else
  echo "រង់ចាំ URL ពី Cloudflare (រហូត ៩០ វិនាទី, ចំនុច = កំពុងដំណើរការ)"
  printf ' '
  URL=$(wait_url "$LOG" 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' 90 || true)
  printf '\n'
fi

if [ -z "$URL" ]; then
  echo "❌ Cloudflare មិនចេញ URL ទេ។ log ចុងក្រោយ៖"
  tail -12 "$LOG"
  exit 1
fi
printf '%s\n' "$URL" > "$DIR/tunnel-url.txt" 2>/dev/null || true

ok=0
k=0
while [ "$k" -lt 8 ]; do
  if curl -s --max-time 15 "$URL/api/health" 2>/dev/null | grep -qi 'khmerclip-video'; then
    ok=1
    break
  fi
  k=$((k + 1))
  echo " នៅមិនទាន់ឆ្លើយ — សាកម្តងទៀត ($k/8)"
  sleep 6
done

say "៨/៨ រួចរាល់"
INFO="$(curl -s --max-time 10 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
MODEL_LINE="$(printf '%s' "$INFO" | python3 -c 'import json,sys
d = json.load(sys.stdin)
print(str(d.get("video_model", "?")) + " · profile " + str(d.get("profile", "?")) + " · " + str(d.get("fps", "?")) + " fps")' 2>/dev/null || echo "?")"

if [ "$ok" = "1" ]; then
  cat <<EOF
✅ ✅ ✅ KHMERCLIP VIDEO API ដំណើរការហើយ!

ចម្លងតម្លៃ ២ នេះទៅក្នុងកាត «ការតភ្ជាប់ server» លើ website រួចចុច «ភ្ជាប់»៖

URL       : $URL
API Token : $KEY

Model     : $MODEL_LINE
Docs      : $URL/docs

Endpoints:
  GET  $URL/api/health
  POST $URL/api/translate    {"text":"ព្រះអាទិត្យរះនៅអង្គរវត្ត"}
  POST $URL/api/generate     {"prompt":"...","width":768,"height":512,"num_frames":49}
  GET  $URL/api/jobs/<job_id>
  GET  $URL/api/videos/<file>.mp4

សាកល្បងភ្លាម៖
  curl -s $URL/api/health
  curl -s -X POST $URL/api/translate -H 'Content-Type: application/json' -H 'X-API-Token: $KEY' -d '{"text":"ព្រះអាទិត្យរះនៅអង្គរវត្ត"}'

⚠️ ទុក tab នេះបើកចុះ។ បិទ tab ឬទុក idle ~៩០ នាទី = session ដាច់ ហើយ URL ស្លាប់
   (បើក cell នេះម្ដងទៀត រួច paste URL ថ្មី)។

មើល log       ៖ tail -f $DIR/api.log
បិទ API        ៖ kill \$(cat $DIR/api.pid)
បិទ tunnel     ៖ kill \$(cat $DIR/tunnel.pid)
EOF
else
  echo "❌ TUNNEL នៅមិនដើរទេ (URL នោះទទេពីខាងក្រៅ)។ log ចុងក្រោយ៖"
  tail -12 "$LOG"
  echo
  echo "API ក្នុងម៉ាស៊ីននៅដើរទេ (http://127.0.0.1:$PORT/api/health) — សាករត់ cell នេះម្ដងទៀត"
  exit 1
fi
