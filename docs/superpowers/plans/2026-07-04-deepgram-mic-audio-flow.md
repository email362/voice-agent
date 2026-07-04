# Deepgram Mic Audio Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make microphone input reliably reach Deepgram after the voice agent session is configured, and add enough diagnostics to prove where audio flow succeeds or fails.

**Architecture:** Keep the existing browser-plus-Fastify proxy shape. The client will open the microphone on the user gesture, but it will not stream binary PCM until Deepgram sends `SettingsApplied`; the proxy will expose aggregate audio/event logs when `DEBUG_AUDIO=1` is enabled. Playback will stop when Deepgram reports `UserStartedSpeaking` so user barge-in is handled correctly.

**Tech Stack:** Browser MediaDevices/Web Audio, browser WebSocket, Fastify static server, `ws`, Deepgram Voice Agent WebSocket API.

---

## File Structure

- Modify: `public/index.html`
  - Owns the visible mic-live indicator markup near the Start/Stop controls.
- Modify: `public/styles.css`
  - Owns the visual states for idle, connecting, live, and streaming microphone status.
- Modify: `public/app.js`
  - Owns browser microphone capture, audio frame gating, playback queue, Deepgram event handling, mic-live indicator state, and user-visible transcript/status updates.
- Modify: `server.js`
  - Owns `/ws/agent` proxying and temporary opt-in aggregate logging for client audio frames and Deepgram events.
- No new runtime dependencies.

## Context Verified

- `public/app.js` currently starts microphone capture before opening `/ws/agent`.
- The current `onaudioprocess` handler sends PCM whenever the browser WebSocket is open.
- Deepgram’s documented order is: open WebSocket, receive `Welcome`, send `Settings`, receive `SettingsApplied`, then stream binary audio.
- Current server logs only show HTTP static asset requests because `/ws/agent` is handled through `server.on('upgrade')`, outside Fastify’s request logger.

## Task 1: Add a Visible Mic-Live Indicator

**Files:**
- Modify: `public/index.html`
- Modify: `public/styles.css`
- Modify: `public/app.js`

- [ ] **Step 1: Add mic indicator markup**

In `public/index.html`, add this immediately after the `.actions` block and before `<p id="status" class="status">`:

```html
<div class="mic-indicator" id="micIndicator" data-state="idle" aria-live="polite">
  <span class="mic-dot" aria-hidden="true"></span>
  <span id="micLabel">Mic idle</span>
</div>
```

- [ ] **Step 2: Add mic indicator styles**

In `public/styles.css`, add this after `.status { color: #c8d0ea; }`:

```css
.mic-indicator {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  max-width: 100%;
  gap: 8px;
  border: 1px solid #ffffff22;
  border-radius: 999px;
  padding: 8px 12px;
  color: #c8d0ea;
  background: #080b1388;
  font-weight: 800;
}
.mic-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #7d879f;
}
.mic-indicator[data-state="connecting"] .mic-dot { background: #ffd166; }
.mic-indicator[data-state="live"] .mic-dot,
.mic-indicator[data-state="streaming"] .mic-dot {
  background: #b6ff8f;
  box-shadow: 0 0 0 6px #b6ff8f22;
}
.mic-indicator[data-state="streaming"] { color: #f6f8ff; }
```

- [ ] **Step 3: Wire mic indicator state in JavaScript**

In `public/app.js`, add these selectors after `const transcriptEl = document.querySelector('#transcript');`:

```js
const micIndicator = document.querySelector('#micIndicator');
const micLabel = document.querySelector('#micLabel');
```

Add this helper after `function setStatus(message) { statusEl.textContent = message; }`:

```js
function setMicState(state, label) {
  micIndicator.dataset.state = state;
  micLabel.textContent = label;
}
```

- [ ] **Step 4: Add session state near the existing globals**

Add these variables after `let keepAlive;`:

```js
let canStreamMic = false;
let outboundAudioFrames = 0;
let outboundAudioBytes = 0;
let lastAudioStatusAt = 0;
```

- [ ] **Step 5: Change the audio process guard**

Replace the current first line inside `processor.onaudioprocess`:

```js
if (socket?.readyState !== WebSocket.OPEN) return;
```

with:

```js
if (!canStreamMic || socket?.readyState !== WebSocket.OPEN) return;
```

Then replace:

```js
socket.send(pcm);
```

with:

```js
socket.send(pcm);
outboundAudioFrames += 1;
outboundAudioBytes += pcm.byteLength;
const now = Date.now();
if (now - lastAudioStatusAt > 2000) {
  lastAudioStatusAt = now;
  setMicState('streaming', `Mic streaming (${outboundAudioFrames} frames)`);
  setStatus(`Live. Streaming microphone audio (${outboundAudioFrames} frames, ${Math.round(outboundAudioBytes / 1024)} KB).`);
}
```

- [ ] **Step 6: Enable streaming only after `SettingsApplied` and show mic live**

Replace:

```js
if (event.type === 'SettingsApplied') setStatus('Live. Speak into your microphone.');
```

with:

```js
if (event.type === 'SettingsApplied') {
  canStreamMic = true;
  setMicState('live', 'Mic live');
  setStatus('Live. Speak into your microphone.');
}
```

- [ ] **Step 7: Reset streaming state and mic cue during start and stop**

Add this at the start of `startConversation()` after clearing transcript/events:

```js
canStreamMic = false;
outboundAudioFrames = 0;
outboundAudioBytes = 0;
lastAudioStatusAt = 0;
setMicState('connecting', 'Mic warming up');
```

Add this at the start of `stopConversation()` after `clearInterval(keepAlive);`:

```js
canStreamMic = false;
setMicState('idle', 'Mic idle');
```

- [ ] **Step 8: Run syntax checks**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" node --check public/app.js
PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" npm run check
```

Expected: both commands exit `0`.

## Task 2: Handle `UserStartedSpeaking` by Canceling Queued Agent Playback

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: Track playback nodes**

Add this variable after `let nextPlaybackTime = 0;`:

```js
let playbackNodes = new Set();
```

- [ ] **Step 2: Add a playback cancellation helper**

Add this function before `playPcm()`:

```js
function stopPlayback() {
  playbackNodes.forEach((node) => {
    try {
      node.stop();
    } catch {
      // The node may already have ended.
    }
  });
  playbackNodes.clear();
  if (audioContext) nextPlaybackTime = audioContext.currentTime;
}
```

- [ ] **Step 3: Register and unregister playback nodes**

In `playPcm()`, after `node.buffer = audioBuffer;`, add:

```js
playbackNodes.add(node);
node.addEventListener('ended', () => playbackNodes.delete(node), { once: true });
```

- [ ] **Step 4: Stop playback when Deepgram hears the user**

In the WebSocket message handler, after parsing and logging `event`, add:

```js
if (event.type === 'UserStartedSpeaking') stopPlayback();
```

- [ ] **Step 5: Stop playback during teardown**

Add this near the top of `stopConversation()`, after `canStreamMic = false;`:

```js
stopPlayback();
```

- [ ] **Step 6: Run syntax checks**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" node --check public/app.js
PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" npm run check
```

Expected: both commands exit `0`.

## Task 3: Add Opt-In Proxy Observability

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add debug flag**

Add after `const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;`:

```js
const DEBUG_AUDIO = process.env.DEBUG_AUDIO === '1';
```

- [ ] **Step 2: Add per-session counters**

Inside `wss.on('connection', (client) => {`, after the API key guard, add:

```js
let clientAudioFrames = 0;
let clientAudioBytes = 0;
let lastClientAudioLogAt = Date.now();
const logAudioProgress = () => {
  if (!DEBUG_AUDIO) return;
  const now = Date.now();
  if (now - lastClientAudioLogAt < 2000) return;
  lastClientAudioLogAt = now;
  app.log.info({ clientAudioFrames, clientAudioBytes }, 'client audio forwarded to Deepgram');
};
```

- [ ] **Step 3: Log Deepgram JSON event types when debug is enabled**

Replace:

```js
deepgram.on('message', (data, isBinary) => sendToClient(data, isBinary));
```

with:

```js
deepgram.on('message', (data, isBinary) => {
  if (DEBUG_AUDIO && !isBinary) {
    try {
      const event = JSON.parse(data.toString());
      app.log.info({ type: event.type, code: event.code }, 'Deepgram event');
    } catch {
      app.log.info({ bytes: data.length }, 'Deepgram non-JSON text message');
    }
  }
  sendToClient(data, isBinary);
});
```

- [ ] **Step 4: Log client JSON event types and aggregate binary audio**

Replace:

```js
client.on('message', (data, isBinary) => sendToDeepgram(data, isBinary));
```

with:

```js
client.on('message', (data, isBinary) => {
  if (DEBUG_AUDIO) {
    if (isBinary) {
      clientAudioFrames += 1;
      clientAudioBytes += data.length;
      logAudioProgress();
    } else {
      try {
        const event = JSON.parse(data.toString());
        app.log.info({ type: event.type }, 'client event');
      } catch {
        app.log.info({ bytes: data.length }, 'client non-JSON text message');
      }
    }
  }
  sendToDeepgram(data, isBinary);
});
```

- [ ] **Step 5: Run syntax checks**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" node --check server.js
PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" npm run check
```

Expected: both commands exit `0`.

## Task 4: Manual Live Verification Matrix

**Files:**
- No file changes.

- [ ] **Step 1: Start the app with audio diagnostics**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" DEBUG_AUDIO=1 npm start
```

Expected startup includes `Server listening at http://127.0.0.1:3000`.

- [ ] **Step 2: Verify session setup**

In Chrome, open `http://127.0.0.1:3000`, click **Start conversation**, and wait for the greeting.

Expected UI:

```text
Mic live
Live. Speak into your microphone.
```

Expected server logs include:

```text
client event type=Settings
Deepgram event type=Welcome
Deepgram event type=SettingsApplied
```

- [ ] **Step 3: Verify browser-to-proxy audio**

Speak a short sentence after the UI says live.

Expected UI indicator and status update within a few seconds:

```text
Mic streaming (... frames)
Live. Streaming microphone audio (... frames, ... KB).
```

Expected server logs include repeated aggregate audio progress:

```text
client audio forwarded to Deepgram
```

- [ ] **Step 4: Verify Deepgram hears the user**

Continue speaking a simple phrase like:

```text
What can you do?
```

Expected server logs include:

```text
Deepgram event type=UserStartedSpeaking
Deepgram event type=ConversationText
```

Expected transcript includes a `user:` bubble with the spoken content.

- [ ] **Step 5: Interpret failures**

If UI audio counters stay at zero, the failure is in browser microphone capture or `onaudioprocess`.

If UI counters increase but server `clientAudioFrames` stays at zero, the failure is browser WebSocket sending.

If server audio counters increase but Deepgram never emits `UserStartedSpeaking`, inspect Deepgram `Warning` or `Error` events, especially `USER_AUDIO_FORMAT` and `ASR_DRIVER_TIMEOUT`.

If `UserStartedSpeaking` arrives but no `ConversationText`, inspect the listen model and input audio format.

## Risks and Tradeoffs

- `ScriptProcessorNode` is deprecated, but replacing it with `AudioWorklet` is larger than this fix. Keep it for this diagnostic pass.
- The proxy logs must stay behind `DEBUG_AUDIO=1` to avoid noisy production logs.
- The UI status counter is diagnostic; remove or demote it after the root cause is confirmed if it feels too technical.

## Self-Review

- Spec coverage: The plan addresses mic send timing, a user-visible mic-live cue, server observability, Deepgram events, and barge-in playback.
- Placeholder scan: No `TBD`, vague future work, or unspecified commands remain.
- Type consistency: New variable names are consistent across all tasks: `canStreamMic`, `outboundAudioFrames`, `outboundAudioBytes`, `playbackNodes`, and `DEBUG_AUDIO`.
