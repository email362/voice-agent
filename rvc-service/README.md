# RVC Voice Conversion Service

Isolated local Python service for converting agent TTS audio through an RVC custom voice. The service is still runnable on its own, and the Node/Fastify Deepgram app can call it through `RVC_SERVICE_URL` when conversion is enabled.

## Model Files

The service auto-discovers model files from the project root and nearby model directories. Current files detected in this checkout:

- `Glamrock-Freddy_119e_7259s.pth` - required RVC model file
- `added_IVF1243_Flat_nprobe_1_v2.index` - optional retrieval index for better voice quality

Windows `*:Zone.Identifier` sidecar files are ignored.

You can override discovery with environment variables:

```bash
export RVC_PROJECT_ROOT=/absolute/path/to/project
export RVC_MODEL_PATH=/absolute/path/to/model.pth
export RVC_INDEX_PATH=/absolute/path/to/model.index
export RVC_MODELS_DIR=/absolute/path/to/models
```

## Device Selection

CUDA is the default target because this machine has a CUDA GPU:

```bash
export RVC_DEVICE=cuda:0
```

If CUDA is unavailable to Torch, the service reports a CPU fallback in `GET /health`. CPU conversion is expected to be much slower and is best treated as a compatibility fallback rather than the normal path.

## Setup

For real RVC conversion, use Python 3.10. The current WSL default here is Python 3.12, which can run the service smoke checks but is not compatible with `rvc-python`'s older dependency set.

From the project root:

```bash
cd rvc-service
python3.10 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

For CUDA acceleration, install Torch/Torchaudio wheels compatible with your GPU and CUDA runtime. The `rvc-python` README recommends CUDA-specific Torch wheels for GPU setups; for example, adjust the CUDA wheel index/version to your local driver/runtime:

```bash
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
```

For lightweight smoke tests on Python 3.12 that do not install the full RVC backend:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip setuptools wheel
pip install -r requirements-smoke.txt
```

Observed in this environment: `pip install rvc-python` under Python 3.12 fails while building `numpy<=1.25.3` because that dependency path still references `pkgutil.ImpImporter`, removed in Python 3.12. Use Python 3.10 for the real conversion backend.

## Run

```bash
cd rvc-service
source .venv/bin/activate
RVC_DEVICE=cuda:0 python run.py
```

Defaults:

- Host: `127.0.0.1`
- Port: `5055`

Override if needed:

```bash
RVC_HOST=0.0.0.0 RVC_PORT=5055 RVC_DEVICE=cuda:0 python run.py
```

## Endpoints

### `GET /health`

Returns model discovery, configured/effective device, CUDA fallback status, and whether the `rvc-python` backend can load the configured model.

Example:

```bash
curl http://127.0.0.1:5055/health
```

### `POST /convert`

Converts an input audio file and returns `audio/wav`.

Request:

- Content type: `multipart/form-data`
- File field: `audio`
- Query params:
  - `pitch` integer, default `0`, range `-24..24`
  - `index_rate` float, default `0.5`, range `0..1`
  - `f0_method` string, default `rmvpe`

Example:

```bash
curl -X POST "http://127.0.0.1:5055/convert?pitch=0&index_rate=0.5&f0_method=rmvpe" \
  -F "audio=@/path/to/input.wav;type=audio/wav" \
  --output converted.wav
```

If `rvc-python` or its Torch dependencies are not installed, `/convert` returns `503` with a clear error. `/health` still works and shows model discovery status, configured device, effective fallback device, and backend readiness.

## Smoke Checks

From the project root:

```bash
rvc-service/.venv/bin/python -m pytest rvc-service/tests -q -s
```

These tests prove:

- The exact `.pth` and `.index` files are discovered from the project root.
- `*:Zone.Identifier` sidecars are ignored.
- CUDA is the default configured device.
- `GET /health` reports model and backend status.
- `POST /convert` returns a WAV response when the engine is mocked.
- `POST /convert` returns `503` when the RVC backend is unavailable.

## Deepgram App Integration

The Node/Fastify Deepgram app can now call this service after each assistant utterance. The integration buffers Deepgram raw PCM assistant audio until `AgentAudioDone`, wraps it as WAV, posts it to `POST /convert`, preserves event ordering while conversion runs, and suppresses stale converted playback if the user barges in again. If conversion fails or times out, the Node app falls back to the original Deepgram audio for that session.

For one-command local development from the project root:

```bash
npm run dev:rvc
```

Or start RVC first:

```bash
cd rvc-service
source .venv/bin/activate
RVC_DEVICE=cuda:0 python run.py
```

Then start the Deepgram app from the project root:

```bash
PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" \
  RVC_SERVICE_URL=http://127.0.0.1:5055 \
  DEBUG_AUDIO=1 \
  npm start
```

Service and integration environment variables:

- `RVC_SERVICE_URL` - defaults to `http://127.0.0.1:5055`. Set empty to disable conversion.
- `RVC_TIMEOUT_MS` - conversion timeout, default `120000`.
- `RVC_MAX_CONVERT_UPLOAD_BYTES` - upload size cap for `/convert`, default `26214400`.
- `RVC_DEVICE` - service device override, default `cuda:0`.
- `RVC_PITCH` - pitch shift passed to `/convert`, default `0`.
- `RVC_INDEX_RATE` - retrieval index rate, default `0.5`.
- `RVC_F0_METHOD` - f0 method, default `rmvpe`.
- `DEBUG_AUDIO` - set to `1` to emit aggregate client audio and Deepgram event logs.
