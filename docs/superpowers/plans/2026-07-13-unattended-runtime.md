# Unattended Voice Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the Node and CPU-only RVC services under repository-supplied systemd units and make an iPhone browser session reconnect automatically after transient service, network, and media interruptions.

**Architecture:** A browser-independent lifecycle module owns retry state, connection generations, and deterministic backoff; `public/app.js` integrates that policy with WebSocket, microphone, Web Audio, wake lock, and DOM APIs. Separate health logic gives the Node proxy bounded RVC dependency reporting. Repository deployment tooling renders systemd user units for loopback-only services and documents persistent Tailscale Serve HTTPS without performing host mutations automatically.

**Tech Stack:** Node.js CommonJS server, browser ES modules, Fastify, `ws`, Web Media/Web Audio/Wake Lock APIs, Python/FastAPI RVC service, systemd user units, Tailscale Serve, Node built-in assertions.

## Global Constraints

- The Node and RVC processes run on the existing Linux machine.
- The iPhone reaches the UI through Tailscale.
- One user tap is allowed after the page opens or the phone reboots.
- After that tap, transient network and service interruptions recover automatically until the user presses Stop or reloads the page.
- Repository tooling must not install packages, enable systemd units, enable user lingering, or configure Tailscale automatically.
- Production Node binds to `127.0.0.1:8787`; development continues to default to `0.0.0.0:3000`.
- Production RVC binds to `127.0.0.1:5055` and forces `RVC_DEVICE=cpu`.
- RVC is not exposed through Tailscale.
- Retry delays are exactly `1000`, `2000`, `4000`, `8000`, then `15000` milliseconds for every later attempt.
- Retry state is in memory only and requires one fresh tap after a page reload.
- Use existing Node check-script conventions and add no JavaScript test framework.

---

## File Map

- Create `public/connection-lifecycle.js`: deterministic retry, desired-running state, active generation, terminal-stop policy.
- Modify `public/app.js`: browser integration for lifecycle, sockets, media recovery, wake lock, and resume UI.
- Modify `public/index.html`: add a hidden resume action and load the lifecycle module through `app.js`.
- Create `service-health.js`: bounded, injectable RVC health probe and ready/degraded response builder.
- Modify `server.js`: host binding, health helper integration, and structured retryability on proxy errors.
- Create `deploy/systemd/*.service.in`: portable web and CPU-only RVC systemd templates.
- Create `deploy/render-systemd.js`: deterministic template renderer and loopback port preflight.
- Create `deploy/install-user-services.sh`: explicit installer that renders and copies units but does not enable them.
- Create `deploy/README.md`: exact systemd, lingering, Tailscale Serve, verification, rollback, and failure-drill commands.
- Create `scripts/check-connection-lifecycle.js`, `scripts/check-browser-recovery.js`, `scripts/check-service-health.js`, and `scripts/check-deployment.js`: automated checks.
- Modify `package.json`, `README.md`, `.env.example`, and `rvc-service/README.md`: expose checks and correct CPU-only deployment guidance.

---

### Task 1: Deterministic Connection Lifecycle

**Files:**
- Create: `public/connection-lifecycle.js`
- Create: `scripts/check-connection-lifecycle.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `retryDelayMs(attemptIndex: number): number`
- Produces: `createConnectionLifecycle(options): { start, markLive, scheduleRetry, retryNow, terminalFailure, stop, isActiveGeneration, snapshot }`
- Calls: `options.connect(generation: number)` whenever a connection attempt should begin.
- Calls: `options.onStateChange(snapshot)` after each state transition.

- [ ] **Step 1: Write the failing lifecycle check**

Create `scripts/check-connection-lifecycle.js`. Load the browser ES module as a data URL so the CommonJS package does not need to change module type:

```js
const assert = require('node:assert/strict');
const fs = require('node:fs');

async function loadModule() {
  const source = fs.readFileSync('public/connection-lifecycle.js', 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

(async () => {
  const { createConnectionLifecycle, retryDelayMs } = await loadModule();
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(retryDelayMs), [1000, 2000, 4000, 8000, 15000, 15000]);

  const scheduled = [];
  const cancelled = [];
  const connections = [];
  const sockets = [];
  const states = [];
  const lifecycle = createConnectionLifecycle({
    connect: (generation) => {
      connections.push(generation);
      sockets.push({ generation, close: () => lifecycle.scheduleRetry(generation) });
    },
    schedule: (fn, delay) => {
      const handle = { fn, delay };
      scheduled.push(handle);
      return handle;
    },
    cancel: (handle) => cancelled.push(handle),
    onStateChange: (snapshot) => states.push(snapshot),
  });

  lifecycle.start();
  assert.deepEqual(connections, [1]);
  assert.equal(lifecycle.snapshot().state, 'connecting');
  assert.equal(sockets[0].close(), true);
  assert.equal(scheduled[0].delay, 1000);
  assert.equal(lifecycle.scheduleRetry(1), false, 'duplicate close/error must not schedule twice');
  scheduled.shift().fn();
  assert.deepEqual(connections, [1, 2]);
  assert.equal(sockets[0].close(), false, 'stale socket close is ignored');
  lifecycle.markLive(2);
  assert.equal(lifecycle.snapshot().retryAttempt, 0);
  lifecycle.scheduleRetry(2);
  assert.equal(scheduled[0].delay, 1000, 'live resets backoff');
  lifecycle.retryNow();
  assert.deepEqual(connections, [1, 2, 3]);
  lifecycle.terminalFailure(3);
  assert.equal(lifecycle.snapshot().desiredRunning, false);
  assert.equal(lifecycle.snapshot().state, 'idle');
  lifecycle.start();
  lifecycle.scheduleRetry(4);
  lifecycle.stop();
  assert.equal(lifecycle.snapshot().desiredRunning, false);
  assert.ok(cancelled.length >= 2, 'immediate retry and stop cancel timers');
  assert.equal(states.at(-1).state, 'idle');

  console.log('connection lifecycle checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

Add the script entry:

```json
"check:lifecycle": "node scripts/check-connection-lifecycle.js"
```

- [ ] **Step 2: Run the check and verify RED**

Run: `npm run check:lifecycle`

Expected: FAIL because `public/connection-lifecycle.js` does not exist.

- [ ] **Step 3: Implement the minimal lifecycle module**

Create `public/connection-lifecycle.js`:

```js
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

export function retryDelayMs(attemptIndex) {
  const index = Math.max(0, Math.min(Number(attemptIndex) || 0, RETRY_DELAYS_MS.length - 1));
  return RETRY_DELAYS_MS[index];
}

export function createConnectionLifecycle({
  connect,
  schedule = setTimeout,
  cancel = clearTimeout,
  onStateChange = () => {},
}) {
  let desiredRunning = false;
  let state = 'idle';
  let generation = 0;
  let retryAttempt = 0;
  let retryHandle;

  const snapshot = () => ({ desiredRunning, state, generation, retryAttempt, retryPending: retryHandle !== undefined });
  const publish = () => onStateChange(snapshot());
  const clearRetry = () => {
    if (retryHandle === undefined) return;
    cancel(retryHandle);
    retryHandle = undefined;
  };
  const attemptConnection = () => {
    if (!desiredRunning) return;
    clearRetry();
    state = 'connecting';
    generation += 1;
    publish();
    connect(generation);
  };

  return {
    start() {
      if (desiredRunning) return false;
      desiredRunning = true;
      retryAttempt = 0;
      attemptConnection();
      return true;
    },
    markLive(candidateGeneration) {
      if (!desiredRunning || candidateGeneration !== generation) return false;
      clearRetry();
      retryAttempt = 0;
      state = 'live';
      publish();
      return true;
    },
    scheduleRetry(candidateGeneration) {
      if (!desiredRunning || candidateGeneration !== generation || retryHandle !== undefined || state === 'retry-wait') return false;
      const delay = retryDelayMs(retryAttempt);
      retryAttempt += 1;
      state = 'retry-wait';
      retryHandle = schedule(() => {
        retryHandle = undefined;
        attemptConnection();
      }, delay);
      publish();
      return true;
    },
    retryNow() {
      if (!desiredRunning) return false;
      clearRetry();
      attemptConnection();
      return true;
    },
    terminalFailure(candidateGeneration) {
      if (candidateGeneration !== generation) return false;
      desiredRunning = false;
      clearRetry();
      state = 'idle';
      publish();
      return true;
    },
    stop() {
      desiredRunning = false;
      clearRetry();
      generation += 1;
      retryAttempt = 0;
      state = 'idle';
      publish();
    },
    isActiveGeneration(candidateGeneration) {
      return desiredRunning && candidateGeneration === generation;
    },
    snapshot,
  };
}
```

- [ ] **Step 4: Run lifecycle checks and verify GREEN**

Run: `npm run check:lifecycle`

Expected: `connection lifecycle checks passed`.

- [ ] **Step 5: Commit**

```bash
git add public/connection-lifecycle.js scripts/check-connection-lifecycle.js package.json
git commit -m "feat: add connection recovery lifecycle"
```

---

### Task 2: WebSocket Reconnection and Terminal Errors

**Files:**
- Modify: `public/app.js`
- Create: `scripts/check-browser-recovery.js`
- Modify: `package.json`
- Modify: `server.js`

**Interfaces:**
- Consumes: `createConnectionLifecycle()` from Task 1.
- Produces: generation-scoped WebSocket sessions with per-socket KeepAlive timers.
- Proxy error JSON shape: `{ type: 'ProxyError', description: string, retryable: boolean }`.

- [ ] **Step 1: Write the failing browser integration check**

Create `scripts/check-browser-recovery.js` with assertions for the required integration points:

```js
const assert = require('node:assert/strict');
const fs = require('node:fs');

const app = fs.readFileSync('public/app.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');

assert.match(app, /import \{ createConnectionLifecycle \} from '\/connection-lifecycle\.js';/);
assert.match(app, /const lifecycle = createConnectionLifecycle\(/);
assert.match(app, /lifecycle\.isActiveGeneration\(generation\)/);
assert.match(app, /lifecycle\.scheduleRetry\(generation\)/);
assert.match(app, /window\.addEventListener\('online', \(\) => lifecycle\.retryNow\(\)\)/);
assert.match(app, /event\.retryable === false/);
assert.match(app, /lifecycle\.terminalFailure\(generation\)/);
assert.match(app, /socketKeepAlive = setInterval/);
assert.match(app, /clearInterval\(socketKeepAlive\)/);
assert.match(server, /retryable: false/);
assert.match(server, /retryable: true/);

console.log('browser recovery integration checks passed');
```

Add:

```json
"check:browser-recovery": "node scripts/check-browser-recovery.js"
```

- [ ] **Step 2: Run the check and verify RED**

Run: `npm run check:browser-recovery`

Expected: FAIL because `app.js` does not import or use the lifecycle module.

- [ ] **Step 3: Refactor browser socket ownership around the lifecycle**

In `public/app.js`:

1. Import `createConnectionLifecycle`.
2. Replace the global `keepAlive`, `expectedSocketClose`, and close-to-stop behavior with a generation-scoped `connectConversation(generation)` function.
3. In every `open`, `message`, `error`, and `close` handler, return unless `lifecycle.isActiveGeneration(generation)` and the captured socket is still active.
4. Create and clear `socketKeepAlive` inside `connectConversation`; clear it exactly once when that socket closes or becomes stale.
5. On `SettingsApplied`, call `lifecycle.markLive(generation)` and enable microphone streaming.
6. On recoverable closure, stop playback, disable microphone streaming, close only that socket, and call `lifecycle.scheduleRetry(generation)` without stopping microphone tracks or closing the audio context.
7. On `{ retryable: false }`, call `lifecycle.terminalFailure(generation)`, release browser resources, and preserve the error status.
8. Make Start initialize browser resources and then call `lifecycle.start()`; make Stop call `lifecycle.stop()` and release everything.
9. Add `window.addEventListener('online', () => lifecycle.retryNow())`.

Treat a Deepgram protocol `Error` received before `SettingsApplied` as terminal because it represents session setup rejection. Treat abnormal closure after a live session as recoverable. The test harness must represent sockets as generation-tagged fake objects and invoke close/error delivery from both the active and stale socket to prove only the active generation can schedule recovery.

The lifecycle construction must use:

```js
const lifecycle = createConnectionLifecycle({
  connect: (generation) => {
    connectConversation(generation).catch((error) => handleConnectionFailure(generation, error));
  },
  onStateChange: ({ state, retryAttempt }) => {
    if (state === 'retry-wait') setStatus(`Disconnected. Retrying automatically (attempt ${retryAttempt})...`);
  },
});
```

Update proxy-created errors in `server.js`:

```js
client.send(JSON.stringify({
  type: 'ProxyError',
  description: 'Missing DEEPGRAM_API_KEY. Copy .env.example to .env and add your key.',
  retryable: false,
}));
```

and transient upstream errors:

```js
sendToClient(JSON.stringify({ type: 'ProxyError', description: errorMessage, retryable: true }));
```

- [ ] **Step 4: Run focused and regression checks**

Run:

```bash
npm run check:browser-recovery
npm run check:lifecycle
npm run check:audio-flow
```

Expected: all three checks pass. Update existing audio-flow assertions only where they encode the old intentional-disconnect implementation; preserve audio gating and playback assertions.

- [ ] **Step 5: Commit**

```bash
git add public/app.js server.js scripts/check-browser-recovery.js scripts/check-audio-flow.js package.json
git commit -m "feat: reconnect transient voice agent sessions"
```

---

### Task 3: Media, Wake-Lock, and Gesture Recovery

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html`
- Modify: `scripts/check-browser-recovery.js`

**Interfaces:**
- Produces: `ensureMedia({ userGesture: boolean }): Promise<void>`.
- Produces: `requestWakeLock(): Promise<void>` and `releaseWakeLock(): Promise<void>`.
- Produces: a hidden `#resumeBtn` shown only when browser policy requires another gesture.

- [ ] **Step 1: Extend the failing browser check**

Add assertions:

```js
const html = fs.readFileSync('public/index.html', 'utf8');
assert.match(app, /async function ensureMedia\(\{ userGesture = false \} = \{\}\)/);
assert.match(app, /audioContext\.state === 'suspended'/);
assert.match(app, /track\.readyState === 'live'/);
assert.match(app, /navigator\.wakeLock\.request\('screen'\)/);
assert.match(app, /document\.addEventListener\('visibilitychange'/);
assert.match(app, /await releaseWakeLock\(\)/);
assert.match(app, /showResumeAction\(error\.message\)/);
assert.match(html, /id="resumeBtn"/);
```

- [ ] **Step 2: Run the check and verify RED**

Run: `npm run check:browser-recovery`

Expected: FAIL on the missing media recovery and wake-lock functions.

- [ ] **Step 3: Implement idempotent media recovery**

Replace one-shot `startMic()` with `ensureMedia({ userGesture = false } = {})`:

```js
async function ensureMedia({ userGesture = false } = {}) {
  const track = micStream?.getAudioTracks()[0];
  if (!track || track.readyState !== 'live') {
    micStream?.getTracks().forEach((item) => item.stop());
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }
  if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContext();
  if (audioContext.state === 'suspended') await audioContext.resume();
  if (!source || !processor) connectMicGraph();
  if (userGesture) await requestWakeLock();
}
```

Extract the existing graph setup into `connectMicGraph()`. Before each connection attempt, await `ensureMedia()`. Ordinary socket recovery must not stop tracks or close the context.

When `ensureMedia()` rejects during automatic recovery, pause socket attempts, set status to the error, and reveal `#resumeBtn`. Its click handler calls `ensureMedia({ userGesture: true })`, hides itself, and invokes `lifecycle.retryNow()`.

- [ ] **Step 4: Add wake-lock and visibility handling**

Use:

```js
let wakeLock;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    logEvent({ type: 'WakeLockUnavailable', description: 'Keep the iPhone screen awake in device settings.' });
    return;
  }
  if (document.visibilityState !== 'visible') return;
  if (wakeLock && !wakeLock.released) return;
  wakeLock = await navigator.wakeLock.request('screen');
  wakeLock.addEventListener('release', () => {
    wakeLock = undefined;
  }, { once: true });
}

async function releaseWakeLock() {
  const activeWakeLock = wakeLock;
  wakeLock = undefined;
  await activeWakeLock?.release();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !lifecycle.snapshot().desiredRunning) return;
  requestWakeLock().catch((error) => logEvent({ type: 'WakeLockWarning', description: error.message }));
  ensureMedia().then(() => lifecycle.retryNow()).catch((error) => showResumeAction(error.message));
});
```

Stop must await or safely fire-and-report `releaseWakeLock()`. Add the resume button beside Start/Stop and hide it by default.

- [ ] **Step 5: Run checks and verify GREEN**

Run:

```bash
npm run check:browser-recovery
npm run check:audio-flow
```

Expected: both checks pass.

- [ ] **Step 6: Commit**

```bash
git add public/app.js public/index.html scripts/check-browser-recovery.js
git commit -m "feat: recover iPhone media and wake lock"
```

---

### Task 4: Bounded Dependency Health and Loopback Host Configuration

**Files:**
- Create: `service-health.js`
- Create: `scripts/check-service-health.js`
- Modify: `server.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `buildServiceHealth({ hasDeepgramKey, rvcServiceUrl, timeoutMs, fetchImpl }): Promise<Health>`.
- `Health` contains `ok`, `ready`, `degraded`, `hasDeepgramKey`, and `rvc.{configured, serviceUrl, reachable, ready, error}`.
- Server consumes `HOST`, defaulting to `0.0.0.0` for development.

- [ ] **Step 1: Write the failing health check**

Create `scripts/check-service-health.js`:

```js
const assert = require('node:assert/strict');
const { buildServiceHealth } = require('../service-health');

(async () => {
  const disabled = await buildServiceHealth({ hasDeepgramKey: true, rvcServiceUrl: '', fetchImpl: () => assert.fail('must not fetch') });
  assert.equal(disabled.ready, true);
  assert.equal(disabled.degraded, false);
  assert.equal(disabled.rvc.configured, false);

  const healthy = await buildServiceHealth({
    hasDeepgramKey: true,
    rvcServiceUrl: 'http://127.0.0.1:5055',
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  });
  assert.equal(healthy.rvc.reachable, true);
  assert.equal(healthy.rvc.ready, true);
  assert.equal(healthy.degraded, false);

  const unavailable = await buildServiceHealth({
    hasDeepgramKey: true,
    rvcServiceUrl: 'http://127.0.0.1:5055',
    fetchImpl: async () => { throw new Error('connection refused'); },
  });
  assert.equal(unavailable.ready, true);
  assert.equal(unavailable.degraded, true);
  assert.equal(unavailable.rvc.reachable, false);
  assert.match(unavailable.rvc.error, /connection refused/);

  const unhealthy = await buildServiceHealth({
    hasDeepgramKey: true,
    rvcServiceUrl: 'http://127.0.0.1:5055',
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false }) }),
  });
  assert.equal(unhealthy.rvc.reachable, true);
  assert.equal(unhealthy.rvc.ready, false);
  assert.equal(unhealthy.degraded, true);

  const timedOut = await buildServiceHealth({
    hasDeepgramKey: true,
    rvcServiceUrl: 'http://127.0.0.1:5055',
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }),
  });
  assert.equal(timedOut.degraded, true);
  assert.match(timedOut.rvc.error, /timed out after 5ms/);

  console.log('service health checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

Add `"check:health": "node scripts/check-service-health.js"`.

- [ ] **Step 2: Run the check and verify RED**

Run: `npm run check:health`

Expected: FAIL because `service-health.js` does not exist.

- [ ] **Step 3: Implement bounded health reporting**

Create `service-health.js`:

```js
async function buildServiceHealth({
  hasDeepgramKey,
  rvcServiceUrl,
  timeoutMs = 1500,
  fetchImpl = fetch,
}) {
  const ready = Boolean(hasDeepgramKey);
  const configured = Boolean(rvcServiceUrl);
  const rvc = { configured, serviceUrl: rvcServiceUrl || '', reachable: false, ready: false, error: null };
  if (configured) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${rvcServiceUrl.replace(/\/$/, '')}/health`, { signal: controller.signal });
      rvc.reachable = response.ok;
      if (!response.ok) throw new Error(`RVC health returned HTTP ${response.status}`);
      const body = await response.json();
      rvc.ready = body.ok === true;
      if (!rvc.ready) rvc.error = body.backend?.error || body.model?.error || 'RVC reported unhealthy';
    } catch (error) {
      rvc.error = error.name === 'AbortError' ? `RVC health timed out after ${timeoutMs}ms` : error.message;
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    ok: ready,
    ready,
    degraded: ready && configured && !rvc.ready,
    hasDeepgramKey: ready,
    rvc,
  };
}

module.exports = { buildServiceHealth };
```

In `server.js`, add `HOST`, `RVC_HEALTH_TIMEOUT_MS`, use `buildServiceHealth` in `/health`, and listen with:

```js
app.listen({ port: PORT, host: HOST }).catch((error) => {
  app.log.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 4: Run health and server checks**

Run:

```bash
npm run check:health
npm run check
```

Expected: health checks pass and Node syntax check exits zero.

- [ ] **Step 5: Commit**

```bash
git add service-health.js scripts/check-service-health.js server.js package.json
git commit -m "feat: report bounded service dependency health"
```

---

### Task 5: Portable CPU-Only systemd Deployment

**Files:**
- Create: `deploy/systemd/voice-agent-web.service.in`
- Create: `deploy/systemd/voice-agent-rvc.service.in`
- Create: `deploy/render-systemd.js`
- Create: `deploy/install-user-services.sh`
- Create: `scripts/check-deployment.js`
- Modify: `package.json`

**Interfaces:**
- Renderer CLI: `node deploy/render-systemd.js --output-dir DIR [--project-root DIR] [--port 8787] [--check-port]`.
- Installer CLI: `deploy/install-user-services.sh [--port 8787] [--render-dir DIR]`.
- Template tokens: `__PROJECT_ROOT__`, `__NODE_PATH__`, and `__WEB_PORT__`.

- [ ] **Step 1: Write the failing deployment check**

Create `scripts/check-deployment.js` to render into a temporary directory, assert exact loopback/CPU/restart settings, then hold an ephemeral loopback port and assert `--check-port` fails with `already in use`:

```js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-agent-units-'));
const render = spawnSync(process.execPath, ['deploy/render-systemd.js', '--output-dir', outputDir, '--project-root', process.cwd(), '--port', '8787'], { encoding: 'utf8' });
assert.equal(render.status, 0, render.stderr);
const web = fs.readFileSync(path.join(outputDir, 'voice-agent-web.service'), 'utf8');
const rvc = fs.readFileSync(path.join(outputDir, 'voice-agent-rvc.service'), 'utf8');
assert.match(web, /HOST=127\.0\.0\.1 PORT=8787/);
assert.match(web, /Restart=on-failure/);
assert.match(rvc, /RVC_HOST=127\.0\.0\.1 RVC_PORT=5055 RVC_DEVICE=cpu/);
assert.doesNotMatch(`${web}\n${rvc}`, /__PROJECT_ROOT__|__NODE_PATH__|__WEB_PORT__/);

const listener = net.createServer();
listener.listen(0, '127.0.0.1', () => {
  const port = listener.address().port;
  const conflict = spawnSync(process.execPath, ['deploy/render-systemd.js', '--output-dir', outputDir, '--port', String(port), '--check-port'], { encoding: 'utf8' });
  listener.close();
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /already in use/);
  console.log('deployment checks passed');
});
```

Add `"check:deployment": "node scripts/check-deployment.js"`.

- [ ] **Step 2: Run the deployment check and verify RED**

Run: `npm run check:deployment`

Expected: FAIL because the renderer does not exist.

- [ ] **Step 3: Add complete unit templates**

Create `deploy/systemd/voice-agent-web.service.in`:

```ini
[Unit]
Description=Voice Agent web and WebSocket proxy
After=network-online.target voice-agent-rvc.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=__PROJECT_ROOT__
EnvironmentFile=-__PROJECT_ROOT__/.env
ExecStart=/usr/bin/env HOST=127.0.0.1 PORT=__WEB_PORT__ __NODE_PATH__ __PROJECT_ROOT__/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=default.target
```

Create `deploy/systemd/voice-agent-rvc.service.in`:

```ini
[Unit]
Description=Voice Agent CPU-only RVC service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=__PROJECT_ROOT__/rvc-service
EnvironmentFile=-__PROJECT_ROOT__/.env
ExecStart=/usr/bin/env RVC_HOST=127.0.0.1 RVC_PORT=5055 RVC_DEVICE=cpu __PROJECT_ROOT__/rvc-service/.venv/bin/python __PROJECT_ROOT__/rvc-service/run.py
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

- [ ] **Step 4: Implement renderer and installer**

`deploy/render-systemd.js` must parse only the documented flags, resolve paths, validate port range `1..65535`, verify the Node executable and RVC Python executable exist, optionally test-bind `127.0.0.1:PORT`, replace all template tokens, reject any unreplaced `__[A-Z_]+__` token, and write mode `0644` units to the requested output directory.

`deploy/install-user-services.sh` must use `set -euo pipefail`, derive the repository root from its own path, accept `--port` and `--render-dir`, render without mutation when `--render-dir` is supplied, and otherwise:

```bash
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
node "$ROOT_DIR/deploy/render-systemd.js" --project-root "$ROOT_DIR" --port "$PORT" --check-port --output-dir "$UNIT_DIR"
systemctl --user daemon-reload
echo "Units installed but not enabled. Run: systemctl --user enable --now voice-agent-rvc.service voice-agent-web.service"
```

It must not call `systemctl enable`, `loginctl`, `tailscale`, a package manager, or `sudo`.

- [ ] **Step 5: Run deployment checks and systemd verification**

Run:

```bash
npm run check:deployment
tmpdir="$(mktemp -d)"
deploy/install-user-services.sh --render-dir "$tmpdir"
systemd-analyze --user verify "$tmpdir/voice-agent-rvc.service" "$tmpdir/voice-agent-web.service"
rm -rf "$tmpdir"
```

Expected: deployment checks pass and `systemd-analyze` reports no unit errors.

- [ ] **Step 6: Commit**

```bash
git add deploy/systemd deploy/render-systemd.js deploy/install-user-services.sh scripts/check-deployment.js package.json
git commit -m "feat: add CPU-only systemd deployment"
```

---

### Task 6: Operator Guide and CPU Documentation Corrections

**Files:**
- Create: `deploy/README.md`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `rvc-service/README.md`

**Interfaces:**
- Documents persistent private proxy command: `sudo tailscale serve --bg http://127.0.0.1:8787`.
- Documents status command: `tailscale serve status`.
- Documents disable command: `sudo tailscale serve off`.

- [ ] **Step 1: Add a failing documentation assertion**

Extend `scripts/check-deployment.js`:

```js
const deploymentReadme = fs.readFileSync('deploy/README.md', 'utf8');
assert.match(deploymentReadme, /tailscale serve --bg http:\/\/127\.0\.0\.1:8787/);
assert.match(deploymentReadme, /loginctl enable-linger/);
assert.match(deploymentReadme, /systemctl --user enable --now voice-agent-rvc\.service voice-agent-web\.service/);
assert.match(deploymentReadme, /journalctl --user -u voice-agent-web\.service/);
assert.match(deploymentReadme, /curl http:\/\/127\.0\.0\.1:8787\/health/);
```

- [ ] **Step 2: Run and verify RED**

Run: `npm run check:deployment`

Expected: FAIL because `deploy/README.md` does not exist.

- [ ] **Step 3: Write the operations guide**

Document these exact phases and commands:

1. Prerequisites: Node dependencies, RVC venv, CPU backend/model health, authenticated Tailscale.
2. Render inspection: `deploy/install-user-services.sh --render-dir /tmp/voice-agent-units`.
3. Install: `deploy/install-user-services.sh --port 8787`.
4. Boot persistence: `sudo loginctl enable-linger "$USER"`.
5. Start: `systemctl --user enable --now voice-agent-rvc.service voice-agent-web.service`.
6. Local checks: `curl http://127.0.0.1:5055/health` and `curl http://127.0.0.1:8787/health`.
7. Private HTTPS: `sudo tailscale serve --bg http://127.0.0.1:8787` and `tailscale serve status`.
8. Logs: `journalctl --user -u voice-agent-web.service -f` and the equivalent RVC command.
9. Failure drills: Node restart, RVC restart, Wi-Fi interruption, foreground recovery, Linux reboot.
10. Rollback: stop/disable user units, remove installed files, daemon-reload, and `sudo tailscale serve off`.

Include the official Tailscale behavior that `--bg` persists Serve configuration across daemon and host restarts, and link `https://tailscale.com/docs/reference/tailscale-cli/serve`.

- [ ] **Step 4: Correct CPU assumptions in existing docs**

Change `.env.example` to recommend `RVC_DEVICE=cpu` for this host. Update `rvc-service/README.md` so it no longer claims this machine has CUDA hardware; present CPU as the deployment target and CUDA as optional guidance for a different host. Add the deployment guide link to the root README.

- [ ] **Step 5: Run documentation/deployment checks**

Run: `npm run check:deployment`

Expected: `deployment checks passed`.

- [ ] **Step 6: Commit**

```bash
git add deploy/README.md README.md .env.example rvc-service/README.md scripts/check-deployment.js
git commit -m "docs: add unattended Tailscale operations guide"
```

---

### Task 7: Full Verification and Manual Handoff

**Files:**
- Modify: `package.json`
- Modify: `README.md` only if the final command documented there differs from the verified command.

**Interfaces:**
- `npm run check:all` runs every JavaScript syntax and behavior check in a stable order.

- [ ] **Step 1: Add the aggregate check command**

Add:

```json
"check:all": "npm run check && npm run check:lifecycle && npm run check:browser-recovery && npm run check:health && npm run check:deployment && npm run check:segmenter && npm run check:rvc-integration && npm run check:audio-flow"
```

- [ ] **Step 2: Run all Node checks**

Run: `npm run check:all`

Expected: every check exits zero with no warnings or unhandled rejections.

- [ ] **Step 3: Run Python service tests**

Run:

```bash
rvc-service/.venv/bin/python -m pytest rvc-service/tests/test_service.py -q
```

Expected: all RVC tests pass.

- [ ] **Step 4: Verify rendered units**

Run:

```bash
tmpdir="$(mktemp -d)"
deploy/install-user-services.sh --render-dir "$tmpdir"
systemd-analyze --user verify "$tmpdir/voice-agent-rvc.service" "$tmpdir/voice-agent-web.service"
rg -n "127\.0\.0\.1|8787|5055|RVC_DEVICE=cpu|Restart=on-failure" "$tmpdir"
rm -rf "$tmpdir"
```

Expected: both units verify, only loopback bindings are present, web port is `8787`, RVC port is `5055`, and production RVC is CPU-only.

- [ ] **Step 5: Perform a local runtime smoke test without system mutation**

Start RVC and Node in temporary terminal sessions using the exact production environment overrides, query both health endpoints, confirm Node reports either healthy RVC or an explicit degraded state, and terminate both sessions cleanly. Do not install or enable units and do not configure Tailscale during automated implementation.

- [ ] **Step 6: Review the diff against the approved specification**

Confirm every success criterion in `docs/superpowers/specs/2026-07-13-unattended-runtime-design.md` maps to implemented code, an automated check, or an explicitly documented operator-only drill. Confirm no host configuration was changed.

- [ ] **Step 7: Commit final command wiring**

```bash
git add package.json README.md
git commit -m "test: verify unattended runtime recovery"
```

- [ ] **Step 8: Operator acceptance test after Tailscale installation**

Hand off these manual checks to the operator because they require the iPhone and host-level configuration:

1. Tap Start once on the iPhone.
2. Restart `voice-agent-web.service`; verify the UI reconnects without another tap.
3. Disable and restore iPhone Wi-Fi; verify reconnect begins immediately when online.
4. Background and foreground the page; verify automatic recovery or the explicit Tap to Resume action.
5. Reboot Linux; verify both units and persistent Tailscale Serve return before a user login.
