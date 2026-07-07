# Streaming Mode for Voice Agent Responsiveness

## Goal

Reduce time-to-first-audio when RVC voice conversion is enabled. Today the proxy
buffers the entire assistant turn until Deepgram sends `AgentAudioDone`, converts
the whole turn through RVC, then plays it. This design converts and plays assistant
speech in segments so playback starts after the first segment instead of the whole
turn. The raw Deepgram (non-RVC) path already streams and is unaffected.

## Key Constraint

Deepgram's Voice Agent API emits no mid-turn audio boundary events. Assistant audio
arrives as a continuous binary PCM stream (24 kHz linear16 mono) between one
`AgentStartedSpeaking` and one `AgentAudioDone`. `ConversationText` carries the full
turn text with no audio-time alignment. Therefore the proxy must derive its own cut
points via silence-gap detection on the PCM stream, with a max-size safety cap.

## Architecture

### 1. Assistant audio segmenter (new module `assistant-audio-segmenter.js`)

A pure, stateful helper independent of the WebSocket:

- Input: assistant PCM chunks (24 kHz linear16 mono, little-endian).
- Maintains a rolling buffer and tracks accumulated duration.
- Computes short-window RMS per frame (reuse the logic in `measurePcm16Level`).
- Emits a segment when any of:
  - a contiguous low-energy gap of at least `RVC_SEGMENT_SILENCE_MS` is detected at a
    frame boundary AND the current segment is at least `RVC_SEGMENT_MIN_MS`, OR
  - the buffered segment reaches `RVC_SEGMENT_MAX_MS` (safety cap), OR
  - `flush()` is called (on `AgentAudioDone`), emitting any remainder.
- All cuts are on whole samples (even byte offsets).
- Interface: `push(chunk) -> Segment[]`, `flush() -> Segment[]`, `reset()`.
  A `Segment` is `{ pcm: Buffer, byteLength: number }`.

### 2. Sequential conversion pipeline (`server.js`)

Reuse the existing flush-queue + generation machinery:

- When `RVC_STREAMING` is on and RVC is enabled, feed incoming assistant PCM into the
  segmenter instead of appending to `assistantAudioChunks`. Each emitted segment
  becomes its own flush enqueued on `assistantAudioFlushQueue` with its own
  `AbortController`, via the existing `queueAssistantAudioFlush` path (refactored to
  accept an explicit chunk set rather than reading the shared buffer).
- On `AgentAudioDone`, call `segmenter.flush()` and enqueue the trailing segment.
- Segments convert in arrival order (the RVC engine serializes on its conversion lock).
  `emitReadyAssistantAudioFlushes()` already emits strictly in order and only when the
  queue head is ready, giving in-order playback for free.
- The first segment plays while later segments are still queued/converting.
- Barge-in (`UserStartedSpeaking`) still bumps `assistantAudioGeneration`, aborts
  in-flight conversions, drops stale segments, and resets the segmenter.

When `RVC_STREAMING` is off, behavior is unchanged: buffer the whole turn and enqueue
a single flush on `AgentAudioDone`.

### 3. Configuration (streaming default ON)

New environment variables (read in `server.js`):

- `RVC_STREAMING` — default `1`. Set `0` for whole-turn behavior.
- `RVC_SEGMENT_SILENCE_MS` — silence gap that triggers a cut. Default `250`.
- `RVC_SEGMENT_SILENCE_RMS` — RMS threshold below which audio counts as silence.
  Default `0.01`.
- `RVC_SEGMENT_MIN_MS` — minimum segment length before a silence cut is allowed.
  Default `400`.
- `RVC_SEGMENT_MAX_MS` — hard cap that forces a cut regardless of silence.
  Default `4000`.

### 4. Browser playback (`public/app.js`) — minimal

No structural change. Converted WAV segments already route through the format-aware,
serialized `queuePlayback`/`playAudio` path and schedule back-to-back via
`nextPlaybackTime`; barge-in cancels queued segments through `playbackGeneration`.
Verification only: confirm multiple per-turn WAV segments schedule seamlessly and
that barge-in cancels pending segments. Add a small optional playback lead so the
first segment does not underrun before the next arrives.

### 5. RVC service — unchanged

The service converts one WAV file per request. Streaming sends more, smaller requests;
no service-side change required.

## Data Flow

```
Deepgram PCM chunk
  -> server.js binary handler
  -> (RVC on + streaming) segmenter.push()
     -> zero or more Segments
        -> each: queue flush (own AbortController)
           -> RVC /convert (serialized by engine lock)
              -> emit in order via emitReadyAssistantAudioFlushes()
                 -> browser queuePlayback -> Web Audio schedule
AgentAudioDone -> segmenter.flush() -> final segment -> queue -> emit -> close-after-audio
```

## Error Handling & Fallback

- Segment conversion failure or timeout: keep the existing per-session fallback
  (`rvcDisabledForSession = true`), aborting in-flight conversions. Already-emitted
  converted segments plus subsequent original-audio segments remain ordered because
  the flush queue already supports mixed converted/original emission in order.
- Trailing segment below `RVC_SEGMENT_MIN_MS` on `AgentAudioDone`: emit as-is (do not
  drop audio).
- Barge-in mid-turn: generation bump + segmenter reset discards buffered and queued
  segments.

## Testing

- Unit tests for the segmenter with synthetic PCM: silence-gap cut, max-size cut,
  final flush remainder, even-byte cut guarantee, min-length suppression.
- Extend `scripts/check-rvc-integration.js` to assert: segmenter is wired into the
  binary handler, `RVC_STREAMING` gating exists, per-segment flushes are enqueued,
  and the new config defaults are present.
- `node --check server.js` and existing checks still pass.
- Manual A/B: run with `RVC_STREAMING=0` vs `1`; confirm lower perceived
  first-audio latency and acceptable segment seams.

## Trade-offs

- Silence-gap cuts land at natural pauses, minimizing RVC f0/seam artifacts, but
  latency depends on speech pacing; `RVC_SEGMENT_MAX_MS` bounds the worst case.
- GPU conversion stays serialized, so total throughput is unchanged; the win is that
  playback starts after segment 1 rather than the whole turn.
- Segment boundaries can still produce minor discontinuities; overlap-add crossfade
  was considered and deferred (YAGNI) unless artifacts prove objectionable.
