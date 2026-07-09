# Streaming Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the reviewed streaming-mode ordering, close, segment-boundary, and playback-gap bugs before merge.

**Architecture:** Treat the segmenter as a first-class audio buffer by exposing whether it has pending PCM, and centralize final draining of segmenter + fallback chunks so `AgentAudioDone` and Deepgram close preserve ordering. Update the segmenter to cut as soon as a silence threshold is reached during analysis, not after an entire pushed chunk is classified. Apply browser playback lead only when playback is idle so queued chunks remain gapless.

**Tech Stack:** Node.js, Fastify, `ws`, existing plain Node check scripts with `node:assert/strict`. No new dependencies.

## Global Constraints

- Assistant audio format is 24 kHz, linear16 (16-bit), mono, little-endian. Samples are 2 bytes; all buffer cuts MUST be on even byte offsets.
- Preserve existing whole-turn behavior when `RVC_STREAMING=0`: buffer assistant audio into `assistantAudioChunks` and flush it as one turn.
- Preserve barge-in semantics: `UserStartedSpeaking` bumps `assistantAudioGeneration`, aborts in-flight conversions, clears queued segments, resets the segmenter, and clears fallback chunks.
- Preserve ordering on RVC failure: audio already buffered in the segmenter must be emitted before later audio buffered in `assistantAudioChunks`.
- Preserve close behavior without dropping segmenter-residual audio: if Deepgram closes while segmenter PCM is pending, drain it before closing the browser socket.
- Preserve config defaults: `RVC_STREAMING=1`, `RVC_SEGMENT_SILENCE_MS=250`, `RVC_SEGMENT_SILENCE_RMS=0.01`, `RVC_SEGMENT_MIN_MS=400`, `RVC_SEGMENT_MAX_MS=4000`.
- No new npm dependencies. Tests use `node:assert/strict` and run under plain `node`, matching existing `scripts/check-*.js` style.

---

### Task 1: Segmenter Buffered-State and Embedded-Silence Cuts

**Files:**
- Modify: `assistant-audio-segmenter.js`
- Modify: `scripts/check-segmenter.js`

**Interfaces:**
- Consumes: existing `createAssistantAudioSegmenter(options)` factory.
- Produces: adds `Segmenter.hasBufferedAudio() -> boolean`.
- Preserves: `push(chunk: Buffer) -> Segment[]`, `flush() -> Segment[]`, `reset() -> void`, `Segment = { pcm: Buffer, byteLength: number }`.

**Root causes addressed:**
- Server needs to know whether segmenter has pending PCM after RVC failure and before close.
- The current segmenter analyzes all windows in a pushed chunk before checking the cut condition, so `speech -> silence >= threshold -> speech` inside one chunk misses the silence boundary.

- [ ] **Step 1: Write the failing tests**

Append these test cases to `scripts/check-segmenter.js` before `console.log('segmenter checks passed');`:

```js
// 7. Silence inside a single pushed chunk cuts before later speech resets the gap.
{
  const seg = createAssistantAudioSegmenter({ silenceMs: 250, minMs: 400, maxMs: 4000, silenceRms: 0.01 });
  const out = seg.push(Buffer.concat([pcm(500, LOUD), pcm(300, QUIET), pcm(200, LOUD)]));
  assert.equal(out.length, 1, 'embedded silence gap should cut within a single push');
  assert.equal(out[0].byteLength, Math.round((800 / 1000) * SAMPLE_RATE) * 2, 'cut should include speech plus silence gap only');
  const trailing = seg.flush();
  assert.equal(trailing.length, 1, 'later speech remains buffered after embedded-silence cut');
  assert.equal(trailing[0].byteLength, Math.round((200 / 1000) * SAMPLE_RATE) * 2, 'later speech is emitted on flush');
}

// 8. hasBufferedAudio reflects push, flush, and reset state.
{
  const seg = createAssistantAudioSegmenter();
  assert.equal(seg.hasBufferedAudio(), false, 'new segmenter starts empty');
  seg.push(pcm(50, LOUD));
  assert.equal(seg.hasBufferedAudio(), true, 'push marks segmenter as buffered');
  seg.flush();
  assert.equal(seg.hasBufferedAudio(), false, 'flush clears buffered state');
  seg.push(pcm(50, LOUD));
  seg.reset();
  assert.equal(seg.hasBufferedAudio(), false, 'reset clears buffered state');
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/check-segmenter.js`

Expected: FAIL. The embedded-silence test should produce `0 !== 1` before the implementation, or `seg.hasBufferedAudio is not a function` if the new API assertion is reached first.

- [ ] **Step 3: Implement incremental silence-cut analysis**

In `assistant-audio-segmenter.js`, replace `analyzedWholeWindows` with an analysis helper that returns a cut point immediately when enough trailing silence has been observed:

```js
  const analyzeUntilCut = () => {
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
      if (trailingSilenceBytes >= silenceBytes && analyzedBytes - trailingSilenceBytes >= minBytes) {
        return analyzedBytes;
      }
    }
    return 0;
  };
```

Update `takeSegment` so every cut resets analysis state for the leftover buffer, avoiding stale classified windows after max-cap cuts:

```js
  const takeSegment = (byteLength) => {
    const even = byteLength - (byteLength % bytesPerSample);
    const pcm = buffer.subarray(0, even);
    buffer = buffer.subarray(even);
    analyzedBytes = 0;
    trailingSilenceBytes = 0;
    return { pcm: Buffer.from(pcm), byteLength: even };
  };
```

Update `push` so silence cuts are preferred before max-cap cuts and so analysis continues after each cut:

```js
  const push = (chunk) => {
    if (!chunk || !chunk.length) return [];
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
    const segments = [];
    while (true) {
      const silenceCut = analyzeUntilCut();
      if (silenceCut) {
        segments.push(takeSegment(silenceCut));
        continue;
      }
      if (buffer.length >= maxBytes) {
        segments.push(takeSegment(maxBytes));
        continue;
      }
      break;
    }
    return segments;
  };
```

Add `hasBufferedAudio` before the returned object:

```js
  const hasBufferedAudio = () => buffer.length > 0;
```

Return it from the factory:

```js
  return { push, flush, reset, hasBufferedAudio };
```

- [ ] **Step 4: Run focused tests**

Run: `node scripts/check-segmenter.js`

Expected: PASS printing `segmenter checks passed`.

- [ ] **Step 5: Commit**

```bash
git add assistant-audio-segmenter.js scripts/check-segmenter.js
git commit -m "fix: cut streaming audio at embedded silence gaps"
```

---

### Task 2: Server Ordering and Close Draining

**Files:**
- Modify: `server.js`
- Modify: `scripts/check-rvc-integration.js`

**Interfaces:**
- Consumes: `segmenter.hasBufferedAudio() -> boolean` from Task 1.
- Produces: `flushPendingAssistantAudio(generation)` internal helper in `server.js`.

**Root causes addressed:**
- After RVC failure, `rvcEnabled()` becomes false. If the queue drains before `AgentAudioDone`, later audio can bypass buffering and be sent directly while older PCM remains inside the segmenter.
- On Deepgram close before `AgentAudioDone`, queued segments may finish but segmenter-residual PCM is never flushed.

- [ ] **Step 1: Write failing structural tests**

Append these assertions to `scripts/check-rvc-integration.js` before the final `console.log('rvc integration checks passed');`:

```js
  assert.match(server, /segmenter\.hasBufferedAudio\(\)/, 'server should account for pending segmenter audio when deciding whether to buffer');
  assert.match(server, /const flushPendingAssistantAudio = \(generation\) => \{[\s\S]*segmenter\.flush\(\)\.forEach\(\(segment\) => enqueueAssistantSegment\(generation, segment\)\);[\s\S]*queueAssistantAudioFlush\(generation, assistantAudioChunks, assistantAudioBytes\);[\s\S]*clearAssistantAudioBuffer\(\);[\s\S]*\};/, 'server should drain segmenter audio before fallback chunks in one helper');
  assert.match(server, /if \(event\.type === 'AgentAudioDone'\) \{[\s\S]*flushPendingAssistantAudio\(generation\);[\s\S]*\}/, 'AgentAudioDone should drain all pending assistant audio');
  assert.match(server, /deepgram\.on\('close',[\s\S]*flushPendingAssistantAudio\(assistantAudioGeneration\);[\s\S]*closeClientAfterAssistantAudio\(\);[\s\S]*\}\);/, 'Deepgram close should drain pending segmenter audio before closing client');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/check-rvc-integration.js`

Expected: FAIL on the first new server assertion.

- [ ] **Step 3: Implement buffering and draining fixes**

Update `shouldBufferAssistantAudio` in `server.js` so direct passthrough is blocked while the segmenter has older pending PCM:

```js
  const shouldBufferAssistantAudio = () =>
    rvcEnabled() || segmenter.hasBufferedAudio() || assistantAudioChunks.length > 0 || assistantAudioFlushQueue.length > 0 || assistantAudioFlushRunning;
```

Add this helper after `enqueueAssistantSegment`:

```js
  const flushPendingAssistantAudio = (generation) => {
    segmenter.flush().forEach((segment) => enqueueAssistantSegment(generation, segment));
    queueAssistantAudioFlush(generation, assistantAudioChunks, assistantAudioBytes);
    clearAssistantAudioBuffer();
  };
```

Replace the `AgentAudioDone` handler body with:

```js
    if (event.type === 'AgentAudioDone') {
      const generation = assistantAudioGeneration;
      flushPendingAssistantAudio(generation);
    }
```

Update the Deepgram close handler to drain pending assistant audio before asking `closeClientAfterAssistantAudio` to close or wait:

```js
  deepgram.on('close', (code, reason) => {
    deepgramClosed = true;
    sendToClient(JSON.stringify({ type: 'ProxyClosed', code, reason: reason.toString() }));
    flushPendingAssistantAudio(assistantAudioGeneration);
    closeClientAfterAssistantAudio();
  });
```

Do not change `discardAssistantAudioBuffer`: it already resets the segmenter, aborts conversions, clears queue, and clears fallback chunks for barge-in/end-conversation.

- [ ] **Step 4: Run focused tests**

Run: `node --check server.js && node scripts/check-rvc-integration.js && node scripts/check-segmenter.js`

Expected: PASS printing `rvc integration checks passed` and `segmenter checks passed`; `node --check server.js` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add server.js scripts/check-rvc-integration.js
git commit -m "fix: preserve streaming audio order across RVC fallback and close"
```

---

### Task 3: Browser Playback Lead Only When Idle

**Files:**
- Modify: `public/app.js`
- Modify: `scripts/check-rvc-integration.js`

**Interfaces:**
- Consumes: existing `PLAYBACK_LEAD_SECONDS` constant.
- Produces: no new API.

**Root cause addressed:**
- `PLAYBACK_LEAD_SECONDS` is currently applied to every buffer. If the next chunk arrives shortly before `nextPlaybackTime`, the new start floor can be later than `nextPlaybackTime`, creating a gap.

- [ ] **Step 1: Write failing structural test**

Replace the current weak playback-lead usage assertion in `scripts/check-rvc-integration.js` with these two assertions:

```js
  assert.match(browser, /const playbackIsIdle = nextPlaybackTime <= audioContext\.currentTime;/, 'browser should detect idle playback before applying lead');
  assert.match(browser, /const earliestStart = playbackIsIdle \? audioContext\.currentTime \+ PLAYBACK_LEAD_SECONDS : audioContext\.currentTime;/, 'browser should apply playback lead only when idle');
```

Keep the existing declaration assertion:

```js
  assert.match(browser, /const PLAYBACK_LEAD_SECONDS =/, 'browser should define a playback lead constant');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/check-rvc-integration.js`

Expected: FAIL on `browser should detect idle playback before applying lead`.

- [ ] **Step 3: Implement idle-only lead**

Update `scheduleAudioBuffer` in `public/app.js`:

```js
function scheduleAudioBuffer(audioBuffer, generation = playbackGeneration) {
  if (generation !== playbackGeneration) return;
  const node = audioContext.createBufferSource();
  node.buffer = audioBuffer;
  playbackNodes.add(node);
  node.addEventListener('ended', () => playbackNodes.delete(node), { once: true });
  node.connect(audioContext.destination);
  const playbackIsIdle = nextPlaybackTime <= audioContext.currentTime;
  const earliestStart = playbackIsIdle ? audioContext.currentTime + PLAYBACK_LEAD_SECONDS : audioContext.currentTime;
  const startAt = Math.max(earliestStart, nextPlaybackTime);
  node.start(startAt);
  nextPlaybackTime = startAt + audioBuffer.duration;
}
```

- [ ] **Step 4: Run focused tests**

Run: `node scripts/check-rvc-integration.js`

Expected: PASS printing `rvc integration checks passed`.

- [ ] **Step 5: Commit**

```bash
git add public/app.js scripts/check-rvc-integration.js
git commit -m "fix: apply playback lead only when playback is idle"
```

---

### Task 4: Final Verification and Review

**Files:**
- No planned code changes.

**Interfaces:**
- Consumes: fixes from Tasks 1-3.
- Produces: verified clean branch ready for merge/PR decision.

- [ ] **Step 1: Run all project checks**

Run:

```bash
npm run check && npm run check:segmenter && npm run check:rvc-integration && npm run check:audio-flow
```

Expected: all commands exit 0. Expected success output includes:

```text
segmenter checks passed
rvc integration checks passed
audio-flow checks passed
```

- [ ] **Step 2: Request final code review**

Dispatch a reviewer over the full branch range from `a289fd0` to `HEAD`, with explicit focus on these scenarios:

```text
- RVC failure mid-turn: segmenter residual audio emitted before later fallback chunks.
- Deepgram close before AgentAudioDone: pending segmenter audio is drained before browser close.
- Embedded silence inside one pushed chunk: segmenter cuts at the silence boundary.
- Multiple browser chunks arriving before nextPlaybackTime: no lead-induced gap.
- RVC_STREAMING=0 whole-turn behavior remains intact.
```

- [ ] **Step 3: Commit only if documentation changed during fixes**

No commit is expected in this task unless the review uncovers a doc/test adjustment. If no changes are made, do not create an empty commit.

## Self-Review

**Spec coverage:**
- High #1 RVC failure reorder: Task 2.
- High #2 Deepgram close drops final segmenter audio: Task 2.
- Medium embedded silence missed inside one chunk: Task 1.
- Medium playback lead gap: Task 3.
- Full verification/re-review: Task 4.

**Placeholder scan:** No TODO/TBD/placeholders. Every code-changing step includes concrete code and commands.

**Type consistency:** `hasBufferedAudio()` is introduced in Task 1 and consumed in Task 2. `flushPendingAssistantAudio(generation)` is introduced and used only inside Task 2. Playback variables in Task 3 are local to `scheduleAudioBuffer`.
