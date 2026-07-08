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
  let analyzedBytes = 0;
  let trailingSilenceBytes = 0;

  const analyzeUntilCut = () => {
    while (buffer.length - analyzedBytes >= windowBytes) {
      const start = analyzedBytes;
      const end = start + windowBytes;
      const rms = windowRms(buffer, start, end);
      if (rms < silenceRms) {
        trailingSilenceBytes += windowBytes;
      } else {
        if (trailingSilenceBytes >= silenceBytes && analyzedBytes - trailingSilenceBytes >= minBytes) {
          return analyzedBytes;
        }
        trailingSilenceBytes = 0;
      }
      analyzedBytes = end;
    }
    if (trailingSilenceBytes >= silenceBytes && analyzedBytes - trailingSilenceBytes >= minBytes) {
      return analyzedBytes;
    }
    return 0;
  };

  const takeSegment = (byteLength) => {
    const even = byteLength - (byteLength % bytesPerSample);
    const pcm = buffer.subarray(0, even);
    buffer = buffer.subarray(even);
    analyzedBytes = 0;
    trailingSilenceBytes = 0;
    return { pcm: Buffer.from(pcm), byteLength: even };
  };

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

  const hasBufferedAudio = () => buffer.length > 0;

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

  return { push, flush, reset, hasBufferedAudio };
}

module.exports = { createAssistantAudioSegmenter };
