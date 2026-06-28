# ElevenLabs Voice Agent POC

A browser-based proof of concept for an end-to-end voice agent interface powered by the ElevenLabs Agents Platform and the official `@elevenlabs/react` SDK.

## What it does

- Starts and stops a real-time voice session with an ElevenLabs agent.
- Requests microphone permission from the browser.
- Shows connection status and a tiny event log for quick debugging.
- Reads the agent id from `VITE_ELEVENLABS_AGENT_ID`.

## Setup

1. Create an ElevenLabs agent in the ElevenLabs dashboard.
2. Copy `.env.example` to `.env.local`.
3. Set `VITE_ELEVENLABS_AGENT_ID` to your agent id.
4. Install dependencies and run the app:

```bash
npm install
npm run dev
```

Open the Vite URL, grant microphone access, and click **Start voice session**.

## Architecture

```mermaid
flowchart LR
  User((User))
  Browser[Browser microphone]
  Vite[React POC UI<br/>Vite static app]
  SDK[@elevenlabs/react<br/>ConversationProvider + hooks]
  Env[VITE_ELEVENLABS_AGENT_ID<br/>local env config]
  Eleven[ElevenLabs Agents Platform<br/>agent runtime + voice session]
  LLM[Configured agent model,<br/>tools, knowledge, and voice]

  User -->|speaks| Browser
  Browser -->|microphone permission + audio stream| Vite
  Env -->|agent id at build/runtime| Vite
  Vite -->|startSession / endSession| SDK
  SDK <-->|real-time conversation session| Eleven
  Eleven <-->|agent reasoning, tools, TTS/STT config| LLM
  Eleven -->|synthesized agent audio| SDK
  SDK -->|status + callbacks| Vite
  Vite -->|plays audio + renders status/logs| User

  subgraph FutureProductionAuth[Recommended production hardening]
    Server[Small backend endpoint]
    ApiKey[ELEVENLABS_API_KEY<br/>server-side only]
    SignedUrl[Signed conversation URL]
    Server -->|uses| ApiKey
    Server -->|returns| SignedUrl
  end

  Vite -.->|request signed URL instead of public agent id| Server
  SignedUrl -.->|passed to SDK session start| SDK
```

### Integration points

| Integration point | Current POC implementation | Production consideration |
| --- | --- | --- |
| ElevenLabs agent configuration | The app expects an existing ElevenLabs agent id in `VITE_ELEVENLABS_AGENT_ID`. | Manage separate agent ids per environment, for example development, staging, and production. |
| Browser microphone | `src/App.tsx` calls `navigator.mediaDevices.getUserMedia({ audio: true })` before starting the voice session. | Add explicit UX for permission denial, supported browser checks, and fallback contact paths. |
| ElevenLabs React SDK | `ConversationProvider`, `useConversationControls`, and `useConversationStatus` connect UI controls to ElevenLabs session lifecycle events. | Add deeper event handling, transcript display, telemetry, and tool-call status if the product needs observability. |
| Authentication | The POC uses the fast browser-only `agentId` path so it can run as a static web app. | Prefer a backend signed-URL endpoint for private agents and never expose `ELEVENLABS_API_KEY` to browser code. |
| UI state and diagnostics | The UI shows connection status plus the five most recent session events. | Persist structured logs server-side or in an observability tool if calls need auditability or support review. |
| Deployment | The app can be built into static assets with Vite. | Put the static app behind HTTPS because browsers require secure contexts for production microphone access. |

### Pros and cons of the current architecture

#### Pros

- **Very fast to run locally:** the app only needs an ElevenLabs agent id and can be served by Vite without a backend.
- **Small integration surface:** the official React SDK owns the low-level real-time session details while the app focuses on UI state and controls.
- **Good demo ergonomics:** microphone permission, start/end controls, status, and errors are all visible in one screen.
- **Static-host friendly:** the browser-only POC can be deployed to a static host for demos when using a public/demo-safe agent configuration.
- **Clear path to production auth:** `.env.example` includes a server-side `ELEVENLABS_API_KEY` placeholder and the diagram shows where a signed-URL endpoint fits.

#### Cons

- **Not production-authenticated yet:** using only `VITE_ELEVENLABS_AGENT_ID` is convenient, but private agents should use signed URLs generated server-side.
- **No backend control plane:** there is no server layer yet for rate limiting, user identity, entitlement checks, session persistence, or audit logging.
- **Limited diagnostics:** the POC logs only lightweight client events and does not retain transcripts, latency metrics, or error details beyond the active browser session.
- **Browser permission dependent:** the experience requires microphone permission and a secure browser context in real deployments.
- **Minimal product UX:** the POC does not yet include transcripts, mute controls, device selection, interruption controls, or escalation flows.

## Authentication note

This POC uses the browser-only `agentId` flow for the fastest local demo. ElevenLabs also supports signed URLs for agents that require authorization. For production, keep `ELEVENLABS_API_KEY` on your server, create an endpoint that calls ElevenLabs' signed URL API, and pass the returned signed URL to the React SDK instead of exposing any API key in browser code.
