# Streaming Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert and play assistant speech in silence-delimited segments so playback starts after the first segment instead of waiting for the whole turn, reducing time-to-first-audio when RVC conversion is enabled.

**Architecture:** A new pure `assistant-audio-segmenter.js` module splits the incoming assistant PCM stream into segments at silence gaps (with a max-size safety cap). `server.js` feeds assistant audio through the segmenter when streaming is enabled and enqueues one flush per segment onto the existing flush queue, which already converts in arrival order and emits strictly in order. The browser needs no structural change; converted WAV segments already schedule seamlessly.

**Tech Stack:** Node.js, Fastify, `ws`, existing `rvc-audio.js` RVC helper, Python RVC service (unchanged). No new dependencies. Tests are plain `node --check`-style assert scripts run with `node`.

## Global Constraints

- Assistant audio format is 24 kHz, linear16 (16-bit), mono, little-endian. Samples are 2 bytes; all buffer cuts MUST be on even byte offsets.
- No new npm dependencies. Tests use `node:assert/strict` and run under plain `node`, matching existing `scripts/check-*.js` style.
- Preserve existing behavior when `RVC_STREAMING=0`: buffer the whole turn and enqueue a single flush on `AgentAudioDone`.
- Preserve existing barge-in semantics: `UserStartedSpeaking` bumps `assistantAudioGeneration`, aborts in-flight conversions, and drops stale segments.
- Config defaults (copied verbatim from spec): `RVC_STREAMING=1`, `RVC_SEGMENT_SILENCE_MS=250`, `RVC_SEGMENT_SILENCE_RMS=0.01`, `RVC_SEGMENT_MIN_MS=400`, `RVC_SEGMENT_MAX_MS=4000`.
- Sample rate constant for duration math: 24000 samples/sec, 2 bytes/sample => 48000 bytes/sec.

---

### Task 1: Assistant audio segmenter module

**Files:**
- Create: `assistant-audio-segmenter.js`
- Test: `scripts/check-segmenter.js`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `createAssistantAudioSegmenter(options) -> Segmenter`
    - `options`: `{ sampleRate=24000, bytesPerSample=2, silenceMs=250, silenceRms=0.01, minMs=400, maxMs=4000 }`
  - `Segmenter.push(chunk: Buffer) -> Segment[]` — returns zero or more completed segments.
  - `Segmenter.flush() -> Segment[]` — returns any remaining buffered audio as a final segment (possibly empty array if nothing buffered).
  - `Segmenter.reset() -> void` — clears all internal buffers/state.
  - `Segment` shape: `{ pcm: Buffer, byteLength: number }` where `pcm.length === byteLength` and `byteLength` is even.

**Design notes for the implementer:**
- Frame the RMS analysis on fixed windows of 10 ms = 240 samples = 480 bytes. Process the accumulated buffer window-by-window.
- Track `segmentBytes` (bytes committed to the current segment) and `trailingSilenceBytes` (contiguous low-energy bytes at the tail).
- A window counts as "silence" when its RMS `< silenceRms`.
- Cut rule (evaluate after appending each chunk, looping while a cut is possible):
  - If `segmentBytes >= maxBytes` (from `maxMs`): cut the first `maxBytes` (even) as a segment.
  - Else if `trailingSilenceBytes >= silenceBytes` (from `silenceMs`) AND `segmentBytes >= minBytes` (from `minMs`): cut everything buffered so far as one segment and reset trailing-silence tracking.
- Convert ms to bytes: `Math.round(ms / 1000 * sampleRate) * bytesPerSample`. Ensure even.
- `flush()` emits remaining buffered bytes as one segment (skip if 0 bytes) and resets.
- Reuse RMS math equivalent to `measurePcm16Level` in `server.js` (sum of squares over samples, `Math.sqrt(sumSquares/samples)`); the segmenter should compute its own so it stays self-contained.

- [ ] **Step 1: Write the failing test**

Create `scripts/check-segmenter.js`:

```js
const assert = require('node:assert/strict');
const { createAssistantAudioSegmenter } = require('../assistant-audio-segmenter');

const SAMPLE_RATE = 24000;
const BYTES_PER_SEC = SAMPLE_RATE * 2;

// Build a PCM buffer of `ms` milliseconds at a constant 16-bit amplitude.
function pcm(ms, amplitude) {
  const samples = Math.round((ms / 1000) * SAMPLE_RATE);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(amplitude, i * 2);
  return buf;
}

const LOUD = 8000; // ~0.24 rms, above threshold
const QUIET = 0; // silence

// 1. Silence gap after enough speech produces a cut.
{
  const seg = createAssistantAudioSegmenter({ silenceMs: 250, minMs: 400, maxMs: 4000, silenceRms: 0.01 });
  let out = [];
  out = out.concat(seg.push(pcm(500, LOUD))); // 500ms speech, above minMs
  assert.equal(out.length, 0, 'no cut before silence');
  out = out.concat(seg.push(pcm(300, QUIET))); // 300ms silence >= 250ms
  assert.equal(out.length, 1, 'one segment after silence gap');
  assert.equal(out[0].byteLength % 2, 0, 'cut on even byte boundary');
  assert.equal(out[0].pcm.length, out[0].byteLength, 'pcm length matches byteLength');
}

// 2. Silence gap before minMs does NOT cut.
{
  const seg = createAssistantAudioSegmenter({ silenceMs: 250, minMs: 400, maxMs: 4000, silenceRms: 0.01 });
  let out = [];
  out = out.concat(seg.push(pcm(100, LOUD))); // 100ms < minMs 400ms
  out = out.concat(seg.push(pcm(300, QUIET))); // silence but segment too short
  assert.equal(out.length, 0, 'no cut when segment below minMs');
}

// 3. Max-size cap forces a cut with no silence.
{
  const seg = createAssistantAudioSegmenter({ silenceMs: 250, minMs: 400, maxMs: 1000, silenceRms: 0.01 });
  const out = seg.push(pcm(1500, LOUD)); // 1500ms continuous speech, cap 1000ms
  assert.equal(out.length, 1, 'one segment at max cap');
  const expectedBytes = Math.round((1000 / 1000) * SAMPLE_RATE) * 2;
  assert.equal(out[0].byteLength, expectedBytes, 'segment capped at maxMs bytes');
}

// 4. flush() emits the remainder.
{
  const seg = createAssistantAudioSegmenter({ silenceMs: 250, minMs: 400, maxMs: 4000, silenceRms: 0.01 });
  seg.push(pcm(200, LOUD));
  const out = seg.flush();
  assert.equal(out.length, 1, 'flush emits remaining audio');
  assert.equal(out[0].byteLength, Math.round((200 / 1000) * SAMPLE_RATE) * 2, 'flush segment has all buffered bytes');
  assert.deepEqual(seg.flush(), [], 'flush after flush yields nothing');
}

// 5. reset() clears buffered audio.
{
  const seg = createAssistantAudioSegmenter();
  seg.push(pcm(200, LOUD));
  seg.reset();
  assert.deepEqual(seg.flush(), [], 'reset clears buffer');
}

// 6. Odd-length chunks are handled (buffer split across sample boundary).
{
  const seg = createAssistantAudioSegmenter({ maxMs: 4000 });
  const full = pcm(50, LOUD);
  seg.push(full.subarray(0, 3)); // 1.5 samples
  seg.push(full.subarray(3)); // remainder
  const out = seg.flush();
  assert.equal(out.length, 1, 'reassembles odd-split chunks');
  assert.equal(out[0].byteLength % 2, 0, 'flushed segment even length');
}

console.log('segmenter checks passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/check-segmenter.js`
Expected: FAIL with `Cannot find module '../assistant-audio-segmenter'`.

- [ ] **Step 3: Write minimal implementation**

Create `assistant-audio-segmenter.js`:

```js
const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_BYTES_PER_SAMPLE = 2;
const WINDOW_MS = 10;

function msToBytes(ms, sampleRate, bytesPerSample) {
  const bytes = Math.round((ms / 1000) * sampleRate) * bytesPerSample;
  return bytes % bytesPerSample === 0 ? bytes : bytes - (bytes % bytesPerSample);
}

function windowRms(buffer, start, end) {
  let sumSquares = 0;
  const samples = Math.floor((end - start) / 2);
  if (!samples) return 0;
  for (let i = 0; i < samples; i += 1) {
    const value = buffer.readInt16LE(start + i * 2) / 32768;
    sumSquares += value * value;
  }
  return Math.sqrt(sumSquares / samples);
}

function createAssistantAudioSegmenter(options = {}) {
  const sampleRate = options.sampleRate || DEFAULT_SAMPLE_RATE;
  const bytesPerSample = options.bytesPerSample || DEFAULT_BYTES_PER_SAMPLE;
  const silenceRms = options.silenceRms ?? 0.01;
  const silenceBytes = msToBytes(options.silenceMs ?? 250, sampleRate, bytesPerSample);
  const minBytes = msToBytes(options.minMs ?? 400, sampleRate, bytesPerSample);
  const maxBytes = msToBytes(options.maxMs ?? 4000, sampleRate, bytesPerSample);
  const windowBytes = msToBytes(WINDOW_MS, sampleRate, bytesPerSample);

  let buffer = Buffer.alloc(0);
  let analyzedBytes = 0; // bytes of `buffer` already classified into trailing-silence tracking
  let trailingSilenceBytes = 0;

  const analyzedWholeWindows = () => {
    // classify any full unanalyzed windows into trailing-silence tracking
    while (buffer.length - analyzedBytes >= windowBytes) {
      const start = analyzedBytes;
      const end = start + windowBytes;
      const rms = windowRms(buffer, start, end);
      if (rms < silenceRms) {
        trailingSilenceBytes += windowBytes;
      } else {
        trailingSilenceBytes = 0;
      }
      analyzedBytes = end;
    }
  };

  const takeSegment = (byteLength) => {
    const even = byteLength - (byteLength % bytesPerSample);
    const pcm = buffer.subarray(0, even);
    buffer = buffer.subarray(even);
    analyzedBytes = Math.max(0, analyzedBytes - even);
    trailingSilenceBytes = 0;
    return { pcm: Buffer.from(pcm), byteLength: even };
  };

  const push = (chunk) => {
    if (!chunk || !chunk.length) return [];
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
    const segments = [];
    let progressed = true;
    while (progressed) {
      progressed = false;
      analyzedWholeWindows();
      if (buffer.length >= maxBytes) {
        segments.push(takeSegment(maxBytes));
        progressed = true;
        continue;
      }
      if (trailingSilenceBytes >= silenceBytes && buffer.length >= minBytes) {
        segments.push(takeSegment(buffer.length));
        progressed = true;
      }
    }
    return segments;
  };

  const flush = () => {
    if (!buffer.length) return [];
    const segment = takeSegment(buffer.length);
    return segment.byteLength ? [segment] : [];
  };

  const reset = () => {
    buffer = Buffer.alloc(0);
    analyzedBytes = 0;
    trailingSilenceBytes = 0;
  };

  return { push, flush, reset };
}

module.exports = { createAssistantAudioSegmenter };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/check-segmenter.js`
Expected: PASS printing `segmenter checks passed`.

- [ ] **Step 5: Commit**

```bash
git add assistant-audio-segmenter.js scripts/check-segmenter.js
git commit -m "feat: add assistant audio segmenter for streaming RVC"
```

---

### Task 2: Wire segmenter and streaming config into server.js

**Files:**
- Modify: `server.js` (config block ~lines 8-16; connection-scope buffer setup ~lines 62-96; `queueAssistantAudioFlush` ~lines 231-246; binary message handler ~lines 249-259; `AgentAudioDone`/`UserStartedSpeaking` handling ~lines 272-276; barge-in discard ~lines 83-88)
- Test: `scripts/check-rvc-integration.js` (extend existing assertions)

**Interfaces:**
- Consumes: `createAssistantAudioSegmenter` from Task 1.
- Produces: no exported API; behavioral wiring inside the connection handler.

**Design notes for the implementer:**
- Add config near the other RVC env reads:
  - `const RVC_STREAMING = process.env.RVC_STREAMING !== '0';`
  - `const RVC_SEGMENT_SILENCE_MS = Number(process.env.RVC_SEGMENT_SILENCE_MS || 250);`
  - `const RVC_SEGMENT_SILENCE_RMS = Number(process.env.RVC_SEGMENT_SILENCE_RMS || 0.01);`
  - `const RVC_SEGMENT_MIN_MS = Number(process.env.RVC_SEGMENT_MIN_MS || 400);`
  - `const RVC_SEGMENT_MAX_MS = Number(process.env.RVC_SEGMENT_MAX_MS || 4000);`
- `queueAssistantAudioFlush` currently reads the shared `assistantAudioChunks`/`assistantAudioBytes`. Refactor it to accept explicit `(generation, chunks, byteLength)` so it can enqueue either a whole-turn buffer or a single segment. Keep the same flush object shape.
- Streaming path: create a per-connection segmenter; in the binary handler, when `RVC_STREAMING && rvcEnabled()`, feed the chunk to `segmenter.push(...)` and enqueue each returned segment as its own flush. Do NOT also append to `assistantAudioChunks` in this path.
- Non-streaming path (or RVC disabled): keep existing buffering into `assistantAudioChunks`.
- On `AgentAudioDone`: if streaming, `segmenter.flush()` and enqueue the trailing segment(s); otherwise keep the existing whole-buffer `queueAssistantAudioFlush`.
- On barge-in / discard (`discardAssistantAudioBuffer`): also call `segmenter.reset()`.
- `shouldBufferAssistantAudio()` must stay true while streaming so raw chunks are routed to the segmenter rather than sent directly.

- [ ] **Step 1: Write the failing test (extend integration check)**

Append these assertions to `scripts/check-rvc-integration.js`, immediately before the final `console.log('rvc integration checks passed');` line:

```js
  // Streaming mode wiring
  assert.match(server, /const RVC_STREAMING = process\.env\.RVC_STREAMING !== '0';/, 'server should read RVC_STREAMING with default on');
  assert.match(server, /RVC_SEGMENT_SILENCE_MS \|\| 250/, 'server should default RVC_SEGMENT_SILENCE_MS to 250');
  assert.match(server, /RVC_SEGMENT_SILENCE_RMS \|\| 0\.01/, 'server should default RVC_SEGMENT_SILENCE_RMS to 0.01');
  assert.match(server, /RVC_SEGMENT_MIN_MS \|\| 400/, 'server should default RVC_SEGMENT_MIN_MS to 400');
  assert.match(server, /RVC_SEGMENT_MAX_MS \|\| 4000/, 'server should default RVC_SEGMENT_MAX_MS to 4000');
  assert.match(server, /createAssistantAudioSegmenter/, 'server should use the assistant audio segmenter');
  assert.match(server, /segmenter\.push\(/, 'server should push assistant audio chunks into the segmenter');
  assert.match(server, /segmenter\.flush\(\)/, 'server should flush the segmenter on AgentAudioDone');
  assert.match(server, /segmenter\.reset\(\)/, 'server should reset the segmenter on barge-in/discard');
  assert.match(server, /const queueAssistantAudioFlush = \([^)]*chunks[^)]*byteLength/, 'queueAssistantAudioFlush should accept explicit chunks and byteLength');

  const segmenterModule = fs.readFileSync('assistant-audio-segmenter.js', 'utf8');
  assert.match(segmenterModule, /function createAssistantAudioSegmenter\(/, 'segmenter module should export a factory');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/check-rvc-integration.js`
Expected: FAIL on the first new assertion (e.g. `server should read RVC_STREAMING with default on`).

- [ ] **Step 3: Implement the wiring**

3a. Add the segmenter require at the top of `server.js`, after the `rvc-audio` require:

```js
const { createAssistantAudioSegmenter } = require('./assistant-audio-segmenter');
```

3b. Add config constants after `const RVC_F0_METHOD = ...` (~line 16):

```js
const RVC_STREAMING = process.env.RVC_STREAMING !== '0';
const RVC_SEGMENT_SILENCE_MS = Number(process.env.RVC_SEGMENT_SILENCE_MS || 250);
const RVC_SEGMENT_SILENCE_RMS = Number(process.env.RVC_SEGMENT_SILENCE_RMS || 0.01);
const RVC_SEGMENT_MIN_MS = Number(process.env.RVC_SEGMENT_MIN_MS || 400);
const RVC_SEGMENT_MAX_MS = Number(process.env.RVC_SEGMENT_MAX_MS || 4000);
```

3c. Inside `wss.on('connection', ...)`, near the other per-connection state (after `let deepgramClosed = false;`), add:

```js
  const assistantAudioSegmenter = createAssistantAudioSegmenter({
    sampleRate: 24000,
    bytesPerSample: 2,
    silenceMs: RVC_SEGMENT_SILENCE_MS,
    silenceRms: RVC_SEGMENT_SILENCE_RMS,
    minMs: RVC_SEGMENT_MIN_MS,
    maxMs: RVC_SEGMENT_MAX_MS,
  });
  const streamingEnabled = () => RVC_STREAMING && rvcEnabled();
```

3d. In `discardAssistantAudioBuffer`, add a segmenter reset:

```js
  const discardAssistantAudioBuffer = () => {
    assistantAudioGeneration += 1;
    abortAssistantAudioConversion();
    assistantAudioFlushQueue = [];
    assistantAudioSegmenter.reset();
    clearAssistantAudioBuffer();
  };
```

3e. Refactor `queueAssistantAudioFlush` to accept explicit chunks (replace the existing function ~lines 231-246):

```js
  const queueAssistantAudioFlush = (generation, chunks, byteLength) => {
    if (generation !== assistantAudioGeneration || !chunks.length || !byteLength) return;
    const flush = {
      generation,
      chunks,
      byteLength,
      ready: false,
      fallbackToOriginal: false,
      convertedAudio: undefined,
      controller: undefined,
    };
    assistantAudioFlushQueue.push(flush);
    void processAssistantAudioFlush(flush);
    void drainAssistantAudioFlushQueue();
  };

  const enqueueAssistantSegment = (generation, segment) => {
    if (!segment || !segment.byteLength) return;
    queueAssistantAudioFlush(generation, [segment.pcm], segment.byteLength);
  };
```

3f. Update the binary branch of `deepgram.on('message', ...)` (~lines 250-259) to route through the segmenter when streaming:

```js
    if (isBinary) {
      if (streamingEnabled()) {
        const generation = assistantAudioGeneration;
        const chunk = Buffer.from(data);
        const segments = assistantAudioSegmenter.push(chunk);
        segments.forEach((segment) => enqueueAssistantSegment(generation, segment));
      } else if (shouldBufferAssistantAudio()) {
        const chunk = Buffer.from(data);
        assistantAudioChunks.push(chunk);
        assistantAudioBytes += chunk.length;
      } else {
        sendToClient(data, true);
      }
      return;
    }
```

3g. Update the `AgentAudioDone` handling (~lines 273-276):

```js
    if (event.type === 'AgentAudioDone') {
      const generation = assistantAudioGeneration;
      if (streamingEnabled()) {
        assistantAudioSegmenter.flush().forEach((segment) => enqueueAssistantSegment(generation, segment));
      } else {
        queueAssistantAudioFlush(generation, assistantAudioChunks, assistantAudioBytes);
        clearAssistantAudioBuffer();
      }
    }
```

> Note: the previous `queueAssistantAudioFlush(generation)` read and cleared the shared buffer internally. Now the caller passes and clears it explicitly, so the non-streaming path clears `assistantAudioChunks` after enqueueing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --check server.js && node scripts/check-rvc-integration.js && node scripts/check-segmenter.js`
Expected: `node --check` prints nothing (exit 0); integration prints `rvc integration checks passed`; segmenter prints `segmenter checks passed`.

- [ ] **Step 5: Commit**

```bash
git add server.js scripts/check-rvc-integration.js
git commit -m "feat: stream RVC assistant audio in silence-delimited segments"
```

---

### Task 3: Browser playback lead + barge-in verification

**Files:**
- Modify: `public/app.js` (`scheduleAudioBuffer` ~lines 124-134)
- Test: `scripts/check-rvc-integration.js` (extend existing browser assertions)

**Interfaces:**
- Consumes: nothing new.
- Produces: no exported API; adds a small scheduling lead constant.

**Design notes for the implementer:**
- The existing `queuePlayback` promise chain and `nextPlaybackTime` scheduling already play consecutive per-turn WAV segments back-to-back, and `playbackGeneration` already cancels queued segments on barge-in. The only change is adding a small fixed lead so the first segment does not start exactly at `audioContext.currentTime` (which can underrun before segment 2 arrives).
- Add a `PLAYBACK_LEAD_SECONDS = 0.08` constant and use it when computing the initial start time.

- [ ] **Step 1: Write the failing test (extend integration check)**

Append to `scripts/check-rvc-integration.js`, before the final `console.log(...)`:

```js
  assert.match(browser, /const PLAYBACK_LEAD_SECONDS =/, 'browser should define a playback lead constant');
  assert.match(browser, /PLAYBACK_LEAD_SECONDS/, 'browser should apply the playback lead when scheduling');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/check-rvc-integration.js`
Expected: FAIL on `browser should define a playback lead constant`.

- [ ] **Step 3: Implement the lead**

3a. Add the constant near the top of `public/app.js` (after `const SAMPLE_RATE = 24000;`):

```js
const PLAYBACK_LEAD_SECONDS = 0.08;
```

3b. Update `scheduleAudioBuffer` (~lines 124-134) so the start time includes the lead when starting from idle:

```js
function scheduleAudioBuffer(audioBuffer, generation = playbackGeneration) {
  if (generation !== playbackGeneration) return;
  const node = audioContext.createBufferSource();
  node.buffer = audioBuffer;
  playbackNodes.add(node);
  node.addEventListener('ended', () => playbackNodes.delete(node), { once: true });
  node.connect(audioContext.destination);
  const earliestStart = audioContext.currentTime + PLAYBACK_LEAD_SECONDS;
  const startAt = Math.max(earliestStart, nextPlaybackTime);
  node.start(startAt);
  nextPlaybackTime = startAt + audioBuffer.duration;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/check-rvc-integration.js`
Expected: PASS printing `rvc integration checks passed`.

- [ ] **Step 5: Commit**

```bash
git add public/app.js scripts/check-rvc-integration.js
git commit -m "feat: add playback lead so streamed segments avoid underrun"
```

---

### Task 4: Documentation and env template updates

**Files:**
- Modify: `.env.example` (add streaming vars)
- Modify: `docs/architecture/deepgram-voice-agent-poc.md` (Environment variables section ~lines 102-118; RVC behavior note ~line 100)
- Modify: `rvc-service/README.md` (integration env var list ~lines 162-171)
- Modify: `package.json` (add a `check:segmenter` script)

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run check:segmenter` runs `node scripts/check-segmenter.js`.

- [ ] **Step 1: Add the segmenter check script to package.json**

In `package.json`, add to `scripts`: `"check:segmenter":"node scripts/check-segmenter.js"`. Resulting `scripts` object:

```json
{"start":"node server.js","dev:rvc":"bash scripts/dev-with-rvc.sh","check":"node --check server.js","check:audio-flow":"node scripts/check-audio-flow.js","check:rvc-integration":"node scripts/check-rvc-integration.js","check:segmenter":"node scripts/check-segmenter.js"}
```

- [ ] **Step 2: Update `.env.example`**

Add these lines to the RVC section of `.env.example` (match the existing comment style used there):

```bash
# Streaming mode: convert/play assistant audio in silence-delimited segments for faster response.
RVC_STREAMING=1
RVC_SEGMENT_SILENCE_MS=250
RVC_SEGMENT_SILENCE_RMS=0.01
RVC_SEGMENT_MIN_MS=400
RVC_SEGMENT_MAX_MS=4000
```

- [ ] **Step 3: Update architecture doc**

In `docs/architecture/deepgram-voice-agent-poc.md`, in the "Environment variables" list add:

```markdown
- `RVC_STREAMING` — set `0` to disable streaming and buffer the whole assistant turn before RVC conversion. Defaults to `1` (streaming on).
- `RVC_SEGMENT_SILENCE_MS`, `RVC_SEGMENT_SILENCE_RMS`, `RVC_SEGMENT_MIN_MS`, `RVC_SEGMENT_MAX_MS` — silence-gap segmentation tuning for streaming mode. Defaults are `250`, `0.01`, `400`, `4000`.
```

And update the RVC behavior paragraph (~line 100) to note that, with streaming enabled, the proxy splits assistant PCM at silence gaps and converts/emits each segment in order so playback starts before the full turn completes, still preserving ordering and barge-in.

- [ ] **Step 4: Update rvc-service README**

In `rvc-service/README.md` under "Service and integration environment variables", add:

```markdown
- `RVC_STREAMING` - stream assistant audio in silence-delimited segments. Defaults to `1`; set `0` for whole-turn conversion.
- `RVC_SEGMENT_SILENCE_MS`, `RVC_SEGMENT_SILENCE_RMS`, `RVC_SEGMENT_MIN_MS`, `RVC_SEGMENT_MAX_MS` - streaming segmentation tuning. Defaults `250`, `0.01`, `400`, `4000`.
```

- [ ] **Step 5: Verify all checks pass**

Run: `npm run check && npm run check:segmenter && npm run check:rvc-integration && npm run check:audio-flow`
Expected: all four commands exit 0 with their success messages.

- [ ] **Step 6: Commit**

```bash
git add .env.example docs/architecture/deepgram-voice-agent-poc.md rvc-service/README.md package.json
git commit -m "docs: document streaming mode configuration"
```

---

## Self-Review

**Spec coverage:**
- Segmenter module (spec §1) → Task 1.
- Sequential conversion pipeline reusing flush queue (spec §2) → Task 2.
- Configuration defaults (spec §3) → Task 2 (constants) + Task 4 (docs/.env).
- Browser playback minimal + lead (spec §4) → Task 3.
- RVC service unchanged (spec §5) → no task needed; noted.
- Error handling / fallback (spec) → preserved by reusing existing flush-queue logic in Task 2; no new code required because the flush object shape and `processAssistantAudioFlush`/`emitReadyAssistantAudioFlushes` are unchanged.
- Testing (spec) → segmenter unit tests (Task 1), integration assertions (Tasks 2-3), full check run (Task 4).

**Placeholder scan:** No TBD/TODO; all code steps contain complete code.

**Type consistency:** `createAssistantAudioSegmenter` factory and `push/flush/reset` + `Segment {pcm, byteLength}` are defined in Task 1 and consumed identically in Task 2. `queueAssistantAudioFlush(generation, chunks, byteLength)` new signature is defined and used consistently within Task 2. `PLAYBACK_LEAD_SECONDS` defined and used in Task 3.
