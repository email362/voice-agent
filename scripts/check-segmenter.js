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
