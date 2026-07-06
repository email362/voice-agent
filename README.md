# Voice Agent

A lightweight proof of concept for running a browser-based Deepgram Voice Agent through a local Node.js WebSocket proxy, with optional local RVC voice conversion for assistant audio.

The browser captures microphone audio, streams 24 kHz `linear16` PCM to the local proxy, and plays streamed assistant responses. The proxy keeps service credentials out of browser code, forwards the conversation to Deepgram, and can route completed assistant audio turns through the isolated Python RVC service.

## What is in this repo?

| Area | Purpose |
| --- | --- |
| `public/` | Browser UI, microphone capture, Deepgram settings, transcript rendering, and assistant audio playback. |
| `server.js` | Fastify static server and `/ws/agent` WebSocket proxy to Deepgram's Voice Agent API. |
| `rvc-service/` | Optional Python service for converting assistant audio with a local RVC model. |
| `scripts/` | Local checks for the audio flow and RVC proxy integration. |
| `docs/` | Architecture notes, implementation plans, and review artifacts. |

## Quick start

```bash
npm install
cp .env.example .env
# edit .env and set DEEPGRAM_API_KEY
npm start
```

Open <http://localhost:3000>, allow microphone access, and start a conversation.

## Configuration

The main app reads configuration from `.env`. At minimum, set `DEEPGRAM_API_KEY`. Common options include:

- `PORT` - local web server port.
- `DEEPGRAM_AGENT_URL` - optional Deepgram Voice Agent WebSocket endpoint override.
- `DEBUG_AUDIO` - set to `1` for aggregate audio and event diagnostics.
- `RVC_SERVICE_URL` - optional RVC conversion service URL; set empty to disable conversion.
- `RVC_TIMEOUT_MS` and `RVC_MAX_CONVERT_UPLOAD_BYTES` - conversion timeout and upload guardrails.

See [.env.example](./.env.example) and the detailed POC document for the full list of supported variables.

## Optional RVC conversion

The RVC service is separate from the Node app and can be run only when you want local voice conversion:

```bash
cd rvc-service
source .venv/bin/activate
RVC_DEVICE=cuda:0 python run.py
```

Then start the Node app with `RVC_SERVICE_URL=http://127.0.0.1:5055`. The proxy falls back to original Deepgram audio if conversion fails or times out.

## Project docs

- [Docs index](./docs/README.md) - directory guide for architecture notes, implementation plans, and review artifacts.
- [Deepgram Voice Agent POC](./docs/architecture/deepgram-voice-agent-poc.md) - detailed architecture, setup, environment variables, RVC behavior, and POC tradeoffs.
- [Deepgram mic audio flow plan](./docs/plans/deepgram-mic-audio-flow.md) - implementation plan for microphone streaming diagnostics and barge-in playback handling.
- [RVC service README](./rvc-service/README.md) - service-specific setup, model discovery, and API details.

## Checks

```bash
npm run check
npm run check:audio-flow
npm run check:rvc-integration
```

This is intentionally POC-grade code. Before production use, add application-level auth, origin controls, rate limits, stronger reconnect/session handling, and production-quality browser audio processing.
