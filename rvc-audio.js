const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_BITS_PER_SAMPLE = 16;

function pcm16ToWav(pcm, options = {}) {
  const sampleRate = options.sampleRate || DEFAULT_SAMPLE_RATE;
  const channels = options.channels || DEFAULT_CHANNELS;
  const bitsPerSample = options.bitsPerSample || DEFAULT_BITS_PER_SAMPLE;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const data = Buffer.from(pcm);
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

function normalizeServiceUrl(serviceUrl) {
  return serviceUrl.replace(/\/+$/, '');
}

function isRvcConfigured(serviceUrl) {
  return Boolean(serviceUrl && serviceUrl.trim());
}

class RvcConversionTimeoutError extends Error {
  constructor(message = 'RVC conversion timed out') {
    super(message);
    this.name = 'RvcConversionTimeoutError';
  }
}

async function convertPcmWithRvc(pcm, options = {}) {
  const serviceUrl = normalizeServiceUrl(options.serviceUrl || '');
  if (!serviceUrl) throw new Error('RVC service URL is not configured');

  const pitch = options.pitch ?? 0;
  const indexRate = options.indexRate ?? 0.5;
  const f0Method = options.f0Method || 'rmvpe';
  const timeoutMs = options.timeoutMs || 120000;
  const signal = options.signal;
  const wav = pcm16ToWav(pcm, options);
  const url = `${serviceUrl}/convert?pitch=${encodeURIComponent(pitch)}&index_rate=${encodeURIComponent(indexRate)}&f0_method=${encodeURIComponent(f0Method)}`;
  const controller = new AbortController();
  const timeoutError = new RvcConversionTimeoutError();
  let timedOut = false;
  const abortController = () => controller.abort(signal?.reason);
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError);
  }, timeoutMs);

  try {
    if (signal) {
      if (signal.aborted) {
        abortController();
      } else {
        signal.addEventListener('abort', abortController, { once: true });
      }
    }
    const form = new FormData();
    form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'deepgram-tts.wav');
    const response = await fetch(url, { method: 'POST', body: form, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`RVC conversion failed with ${response.status}: ${body}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', abortController);
  }
}

module.exports = {
  pcm16ToWav,
  convertPcmWithRvc,
  isRvcConfigured,
  RvcConversionTimeoutError,
};
