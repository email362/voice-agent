# Unattended Runtime Design

## Goal

Make the voice agent capable of recovering without human intervention after one initial tap on an iPhone, while running the Node and RVC services continuously on the existing Linux host and exposing the browser UI privately over Tailscale HTTPS.

This work covers production runtime packaging and browser lifecycle recovery. Installing Tailscale, changing system configuration, and configuring the iPhone as a kiosk remain explicit operator actions.

## Constraints

- The Node and RVC processes run on the existing Linux machine.
- The iPhone reaches the UI through Tailscale.
- One user tap is allowed after the page opens or the phone reboots.
- After that tap, transient network and service interruptions recover automatically until the user presses Stop or reloads the page.
- Repository changes must not install packages, enable systemd units, enable user lingering, or configure Tailscale automatically.
- RVC remains bound to loopback and is never exposed directly through Tailscale.
- The Linux host has no discrete GPU; production RVC runs explicitly on CPU.
- Development continues to default to port `3000`.
- Production defaults to loopback port `8787`, with an operator override supported through deployment configuration.
- No new JavaScript test framework is required.

## Selected Approach

Use systemd user-service templates for process supervision, Tailscale Serve for private HTTPS termination, and a testable browser connection state machine for automatic recovery.

This is preferred over Docker Compose because the application already uses a host Python environment and large local model files, while CPU-only execution does not benefit from container device isolation. It is preferred over a shell supervisor because systemd provides boot integration, isolated restart policies, and journald logging.

## Deployment Architecture

The repository will contain a `deploy/` area with:

- A systemd user-service template for the RVC process.
- A systemd user-service template for the Node web/proxy process.
- An installation helper that renders the templates using the current repository path and selected production port.
- Operations documentation containing commands for installation, enablement, Tailscale Serve, verification, logs, rollback, and failure drills.

The installation helper will support a dry-run or render-only destination so its output can be tested without changing systemd. Before installing or starting a service, it will check whether the selected production port is already listening and fail with a clear message if so. It will not invoke `sudo`, install Tailscale, enable lingering, or run `tailscale serve`.

`voice-agent-rvc.service` will:

- Run `rvc-service/.venv/bin/python run.py` from the repository.
- Bind to `127.0.0.1:5055` by default.
- Force `RVC_DEVICE=cpu` for production so startup does not probe or advertise unavailable CUDA hardware.
- Load environment configuration from the repository's `.env` file.
- Restart after unexpected exits with a bounded delay.
- Write stdout and stderr to journald.

`voice-agent-web.service` will:

- Run `node server.js` from the repository.
- Bind to `127.0.0.1:8787` by default.
- Load environment configuration from the repository's `.env` file while allowing the deployment port to override a development `PORT` value.
- Order startup after the RVC unit without making RVC availability a hard requirement.
- Restart after unexpected exits with a bounded delay.
- Write stdout and stderr to journald.

Tailscale Serve will terminate HTTPS for the tailnet hostname and proxy to `http://127.0.0.1:8787`. Only the Node service is exposed. The exact command will be documented rather than executed by repository tooling.

For boot startup, the operations guide will instruct the operator to install and enable the user units and enable systemd user lingering. These remain deliberate host-level actions.

## Health Semantics

The Node health endpoint will make a short, bounded request to the RVC `/health` endpoint when RVC is configured.

The response will distinguish:

- `ready`: the Deepgram key is configured and the Node proxy can accept sessions.
- `degraded`: the Node proxy is ready but configured RVC conversion is unreachable or unhealthy, so sessions will use original Deepgram audio.
- `rvc.configured`: whether an RVC service URL is configured.
- `rvc.reachable`: whether the RVC health request completed successfully.
- `rvc.ready`: whether the RVC service reported `ok: true`.

RVC failure will not make the overall Node endpoint unready because the existing application deliberately falls back to unconverted audio. The RVC probe will have a strict timeout so `/health` cannot hang behind a failed dependency.

## Browser Lifecycle

The browser will require one explicit Start tap per page load. That gesture obtains microphone permission, starts the audio context, requests a screen wake lock when supported, and sets an in-memory `desiredRunning` state.

The state machine has four user-visible states:

- `idle`: no conversation is desired.
- `connecting`: a WebSocket session is being established.
- `live`: Deepgram accepted settings and microphone frames may stream.
- `retry-wait`: a recoverable failure occurred and a retry is scheduled.

Pressing Stop or reloading the page ends the desired-running state. State is intentionally not persisted in local storage because a fresh page load may require a new browser gesture for audio and microphone access.

### Connection recovery

Recoverable WebSocket failures retry indefinitely while `desiredRunning` remains true. Delays use deterministic capped exponential backoff: `1s`, `2s`, `4s`, `8s`, then `15s` for subsequent attempts. Reaching a configured live session resets the retry counter.

Each socket belongs to a monotonically increasing connection generation. Message, close, and error events from a stale generation are ignored so an older socket cannot stop or mutate a newer session.

On reconnection, the browser opens a new proxy WebSocket, sends current settings after Deepgram's `Welcome`, and resumes microphone streaming only after `SettingsApplied`. Each socket owns its own KeepAlive interval, which is cleared when that socket closes or becomes stale.

The browser listens for the `online` event. If a retry is pending when connectivity returns, it cancels the delay and attempts an immediate connection.

### Terminal failures

Missing credentials, rejected settings, and other explicitly non-retryable proxy errors stop automatic recovery and display the underlying error. Transient network closure, proxy restart, upstream closure, and timeout conditions remain retryable.

The proxy will include retryability information in errors it creates so the browser does not infer terminal behavior from error text. Unknown abnormal socket closures are treated as recoverable.

### Microphone and audio recovery

The browser keeps a usable microphone stream and audio context across ordinary WebSocket reconnects. Before a new connection attempt, it verifies that:

- The microphone has a live audio track.
- The audio context is not closed.
- A suspended audio context can be resumed.

If the track ended or the context closed, the browser attempts to reacquire or recreate it. If Safari rejects recovery because a new user gesture is required, automatic retries pause and the interface presents a `Tap to resume` action. That action reuses the normal user-gesture initialization path and then resumes automatic connection recovery.

Assistant playback is cleared when a connection is lost so audio from a terminated session cannot play during a later session.

### Wake lock and visibility

After the initial Start tap, the browser requests a `screen` wake lock when the API is available. Wake-lock rejection does not stop the voice agent, but the interface reports that the screen must be kept awake through device settings.

When the document becomes visible, the browser reacquires a released wake lock, resumes a suspended audio context, validates the microphone track, and reconnects immediately if the desired session is not live. Visibility recovery uses the same connection generation and retry rules as network recovery.

Stop releases any held wake lock and removes pending recovery work.

## Code Boundaries

`public/connection-lifecycle.js` will contain browser-independent lifecycle policy:

- Desired-running state.
- Retry attempt accounting.
- Capped delay calculation.
- Retry scheduling and cancellation.
- State transition notifications.

It will accept injected scheduling functions so Node tests can use deterministic fake time.

`public/app.js` will own browser integrations:

- WebSocket creation and generation checks.
- Microphone and audio-context creation, validation, and recovery.
- Wake-lock acquisition and release.
- Deepgram protocol messages and KeepAlive ownership.
- Playback and DOM updates.

`server.js` will own structured proxy errors, host binding, and bounded RVC health probing.

Deployment templates and their renderer will remain independent from application runtime code.

## Testing

Tests will use Node's built-in assertions and existing repository check-script conventions.

Automated coverage will include:

- Retry delays progress through `1s`, `2s`, `4s`, `8s`, and cap at `15s`.
- Entering `live` resets the backoff.
- Stop cancels pending retries and prevents later reconnects.
- An online or visible recovery signal can trigger an immediate attempt.
- Stale socket events do not affect the active generation.
- Explicit terminal errors stop recovery.
- Microphone, audio-context, and wake-lock recovery paths are connected to Start, visibility changes, reconnect, and Stop.
- Deployment templates render the current repository path and production port `8787` without writing system configuration.
- A simulated occupied port produces a clear failure.
- Node health reports ready RVC, unavailable RVC, disabled RVC, and dependency timeout correctly.
- Existing audio-flow, RVC integration, and segmenter checks continue to pass.

The operations guide will also define manual failure drills:

- Restart Node during a live iPhone session and confirm automatic recovery.
- Restart RVC and confirm degraded original audio followed by recovery on the next session or conversion attempt.
- Disable and restore Wi-Fi and confirm immediate reconnect when online.
- Background and foreground the page and confirm wake-lock/audio recovery or the explicit resume action.
- Reboot the Linux host and verify both units return without an interactive login.

## Operational Success Criteria

The work is complete when:

1. The rendered production units run Node on loopback port `8787` and RVC on loopback port `5055`, with restart policies and journald logs.
2. The documented Tailscale Serve command exposes only the Node UI over HTTPS.
3. After one Start tap, a transient Node restart or network outage reconnects without another tap when iOS permits media recovery.
4. If iOS requires a gesture, the UI explicitly requests a resume tap and continues recovery afterward.
5. Terminal configuration failures do not retry indefinitely.
6. Health output accurately distinguishes ready and degraded operation.
7. All existing and new automated checks pass.

## Out of Scope

- Installing or authenticating Tailscale.
- Executing `tailscale serve` automatically.
- Enabling systemd lingering or units automatically without an operator command.
- Configuring Guided Access, MDM Single App Mode, iPhone Auto-Lock, notifications, calls, or OS updates.
- Guaranteeing browser execution while iOS has suspended or terminated the page.
- Public internet exposure, application authentication, or multi-user authorization.
- Containerizing Node or RVC.
- GPU acceleration work.
