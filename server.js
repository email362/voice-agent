require('dotenv').config();
const path = require('node:path');
const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');
const WebSocket = require('ws');
const { convertPcmWithRvc, isRvcConfigured, RvcConversionTimeoutError } = require('./rvc-audio');
const { createAssistantAudioSegmenter } = require('./assistant-audio-segmenter');
const { buildServiceHealth } = require('./service-health');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DEEPGRAM_AGENT_URL = process.env.DEEPGRAM_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEBUG_AUDIO = process.env.DEBUG_AUDIO === '1';
const RVC_SERVICE_URL = process.env.RVC_SERVICE_URL ?? 'http://127.0.0.1:5055';
const RVC_HEALTH_TIMEOUT_MS = Number(process.env.RVC_HEALTH_TIMEOUT_MS || 1500);
const RVC_TIMEOUT_MS = Number(process.env.RVC_TIMEOUT_MS || 120000);
const RVC_PITCH = Number(process.env.RVC_PITCH || 0);
const RVC_INDEX_RATE = Number(process.env.RVC_INDEX_RATE || 0.5);
const RVC_F0_METHOD = process.env.RVC_F0_METHOD || 'rmvpe';
const RVC_STREAMING = process.env.RVC_STREAMING !== '0';
const RVC_SEGMENT_SILENCE_MS = Number(process.env.RVC_SEGMENT_SILENCE_MS || 250);
const RVC_SEGMENT_SILENCE_RMS = Number(process.env.RVC_SEGMENT_SILENCE_RMS || 0.01);
const RVC_SEGMENT_MIN_MS = Number(process.env.RVC_SEGMENT_MIN_MS || 400);
const RVC_SEGMENT_MAX_MS = Number(process.env.RVC_SEGMENT_MAX_MS || 4000);

const app = Fastify({ logger: true });
app.register(fastifyStatic, { root: path.join(__dirname, 'public') });

function measurePcm16Level(buffer) {
  let peak = 0;
  let sumSquares = 0;
  const samples = Math.floor(buffer.length / 2);
  if (!samples) return { peak: 0, rms: 0 };
  for (let index = 0; index < samples; index += 1) {
    const value = buffer.readInt16LE(index * 2) / 32768;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    sumSquares += value * value;
  }
  return { peak, rms: Math.sqrt(sumSquares / samples) };
}

app.get('/health', async () => buildServiceHealth({
  hasDeepgramKey: Boolean(DEEPGRAM_API_KEY),
  rvcServiceUrl: RVC_SERVICE_URL,
  timeoutMs: RVC_HEALTH_TIMEOUT_MS,
}));

const server = app.server;
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/ws/agent') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client));
});

wss.on('connection', (client) => {
  if (!DEEPGRAM_API_KEY) {
    client.send(JSON.stringify({
      type: 'ProxyError',
      description: 'Missing DEEPGRAM_API_KEY. Copy .env.example to .env and add your key.',
      retryable: false,
    }));
    client.close(1011, 'Missing Deepgram API key');
    return;
  }

  let clientAudioFrames = 0;
  let clientAudioBytes = 0;
  let clientAudioPeak = 0;
  let clientAudioSumSquares = 0;
  let clientAudioSamples = 0;
  let lastClientAudioLogAt = Date.now();
  let assistantAudioChunks = [];
  let assistantAudioBytes = 0;
  let assistantAudioGeneration = 0;
  let assistantAudioFlushRunning = false;
  let assistantAudioFlushQueue = [];
  let rvcDisabledForSession = false;
  let deepgramClosed = false;
  const rvcEnabled = () => isRvcConfigured(RVC_SERVICE_URL) && !rvcDisabledForSession;
  const segmenter = createAssistantAudioSegmenter({
    sampleRate: 24000,
    bytesPerSample: 2,
    silenceMs: RVC_SEGMENT_SILENCE_MS,
    silenceRms: RVC_SEGMENT_SILENCE_RMS,
    minMs: RVC_SEGMENT_MIN_MS,
    maxMs: RVC_SEGMENT_MAX_MS,
  });
  const streamingEnabled = () => RVC_STREAMING && rvcEnabled();
  const clearAssistantAudioBuffer = () => {
    assistantAudioChunks = [];
    assistantAudioBytes = 0;
  };
  const abortAssistantAudioConversion = () => {
    assistantAudioFlushQueue.forEach((flush) => flush.controller?.abort());
  };
  const discardAssistantAudioBuffer = () => {
    assistantAudioGeneration += 1;
    abortAssistantAudioConversion();
    assistantAudioFlushQueue = [];
    segmenter.reset();
    clearAssistantAudioBuffer();
  };
  const closeClientAfterAssistantAudio = () => {
    if (!deepgramClosed) return;
    if (assistantAudioFlushQueue.length) return;
    if (assistantAudioChunks.length) {
      discardAssistantAudioBuffer();
    }
    if (client.readyState === WebSocket.OPEN) client.close();
  };
  const logAudioProgress = () => {
    if (!DEBUG_AUDIO) return;
    const now = Date.now();
    if (now - lastClientAudioLogAt < 2000) return;
    lastClientAudioLogAt = now;
    const clientAudioRms = clientAudioSamples ? Math.sqrt(clientAudioSumSquares / clientAudioSamples) : 0;
    app.log.info(
      {
        clientAudioFrames,
        clientAudioBytes,
        clientAudioPeak: Number(clientAudioPeak.toFixed(4)),
        clientAudioRms: Number(clientAudioRms.toFixed(4)),
      },
      'client audio forwarded to Deepgram',
    );
    clientAudioPeak = 0;
    clientAudioSumSquares = 0;
    clientAudioSamples = 0;
  };

  const deepgram = new WebSocket(DEEPGRAM_AGENT_URL, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  const sendToClient = (data, isBinary = false) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  };
  const sendToDeepgram = (data, isBinary = false) => {
    if (deepgram.readyState === WebSocket.OPEN) deepgram.send(data, { binary: isBinary });
  };
  const shouldBufferAssistantAudio = () =>
    rvcEnabled() || segmenter.hasBufferedAudio() || assistantAudioChunks.length > 0 || assistantAudioFlushQueue.length > 0 || assistantAudioFlushRunning;

  const sendOriginalAssistantAudio = (chunks) => {
    chunks.forEach((chunk) => sendToClient(chunk, true));
  };

  const finalizeAssistantAudioFlush = (flush, convertedAudio = undefined) => {
    if (flush.generation !== assistantAudioGeneration) return;
    flush.ready = true;
    if (convertedAudio) {
      flush.convertedAudio = convertedAudio;
      flush.fallbackToOriginal = false;
    } else {
      flush.fallbackToOriginal = true;
    }
  };

  const emitReadyAssistantAudioFlushes = () => {
    while (assistantAudioFlushQueue.length) {
      const flush = assistantAudioFlushQueue[0];
      if (flush.generation !== assistantAudioGeneration) {
        assistantAudioFlushQueue.shift();
        continue;
      }
      if (!flush.ready) return;
      assistantAudioFlushQueue.shift();
      if (rvcDisabledForSession || flush.fallbackToOriginal || !flush.convertedAudio) {
        sendOriginalAssistantAudio(flush.chunks);
      } else {
        sendToClient(flush.convertedAudio, true);
      }
    }
    closeClientAfterAssistantAudio();
  };

  const endConversation = (errorMessage) => {
    discardAssistantAudioBuffer();
    if (errorMessage) sendToClient(JSON.stringify({ type: 'ProxyError', description: errorMessage, retryable: true }));
    if (client.readyState !== WebSocket.CLOSED) client.close(1011, errorMessage || 'Deepgram websocket error');
    if (deepgram.readyState !== WebSocket.CLOSED) deepgram.close();
  };

  const processAssistantAudioFlush = async (flush) => {
    if (flush.generation !== assistantAudioGeneration || !flush.chunks.length) return;

    if (!rvcEnabled()) {
      finalizeAssistantAudioFlush(flush);
      emitReadyAssistantAudioFlushes();
      return;
    }

    const conversionController = new AbortController();
    flush.controller = conversionController;
    try {
      app.log.info({ byteLength: flush.byteLength, serviceUrl: RVC_SERVICE_URL }, 'converting assistant audio with RVC');
      const converted = await convertPcmWithRvc(Buffer.concat(flush.chunks, flush.byteLength), {
        serviceUrl: RVC_SERVICE_URL,
        sampleRate: 24000,
        channels: 1,
        bitsPerSample: 16,
        pitch: RVC_PITCH,
        indexRate: RVC_INDEX_RATE,
        f0Method: RVC_F0_METHOD,
        timeoutMs: RVC_TIMEOUT_MS,
        signal: conversionController.signal,
      });
      app.log.info({ inputBytes: flush.byteLength, outputBytes: converted.length }, 'RVC conversion complete');
      if (flush.generation !== assistantAudioGeneration || conversionController.signal.aborted || !rvcEnabled()) {
        finalizeAssistantAudioFlush(flush);
      } else {
        finalizeAssistantAudioFlush(flush, converted);
      }
    } catch (error) {
      if (flush.generation !== assistantAudioGeneration) return;
      if (error instanceof RvcConversionTimeoutError) {
        rvcDisabledForSession = true;
        app.log.error({ err: error, byteLength: flush.byteLength }, 'RVC conversion timed out; falling back to original assistant audio for this session');
        abortAssistantAudioConversion();
        finalizeAssistantAudioFlush(flush);
        return;
      }
      if (conversionController.signal.aborted) {
        finalizeAssistantAudioFlush(flush);
        return;
      }
      rvcDisabledForSession = true;
      app.log.error({ err: error, byteLength: flush.byteLength }, 'RVC conversion failed; falling back to original assistant audio for this session');
      abortAssistantAudioConversion();
      finalizeAssistantAudioFlush(flush);
    } finally {
      if (flush.controller === conversionController) flush.controller = undefined;
      emitReadyAssistantAudioFlushes();
    }
  };
  const drainAssistantAudioFlushQueue = async () => {
    if (assistantAudioFlushRunning) return;
    assistantAudioFlushRunning = true;
    try {
      emitReadyAssistantAudioFlushes();
    } finally {
      assistantAudioFlushRunning = false;
    }
  };
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

  const flushPendingAssistantAudio = (generation) => {
    segmenter.flush().forEach((segment) => enqueueAssistantSegment(generation, segment));
    queueAssistantAudioFlush(generation, assistantAudioChunks, assistantAudioBytes);
    clearAssistantAudioBuffer();
  };

  deepgram.on('open', () => sendToClient(JSON.stringify({ type: 'ProxyConnected' })));
  deepgram.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (streamingEnabled()) {
        const generation = assistantAudioGeneration;
        const chunk = Buffer.from(data);
        const segments = segmenter.push(chunk);
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

    let event;
    try {
      event = JSON.parse(data.toString());
      if (DEBUG_AUDIO) app.log.info({ type: event.type, code: event.code }, 'Deepgram event');
    } catch {
      if (DEBUG_AUDIO) app.log.info({ bytes: data.length }, 'Deepgram non-JSON text message');
      sendToClient(data, false);
      return;
    }

    sendToClient(data, false);
    if (event.type === 'UserStartedSpeaking') discardAssistantAudioBuffer();
    if (event.type === 'AgentAudioDone') {
      const generation = assistantAudioGeneration;
      flushPendingAssistantAudio(generation);
    }
  });
  deepgram.on('error', (error) => endConversation(error.message));
  deepgram.on('close', (code, reason) => {
    deepgramClosed = true;
    sendToClient(JSON.stringify({ type: 'ProxyClosed', code, reason: reason.toString() }));
    flushPendingAssistantAudio(assistantAudioGeneration);
    closeClientAfterAssistantAudio();
  });

  client.on('message', (data, isBinary) => {
    if (DEBUG_AUDIO) {
      if (isBinary) {
        clientAudioFrames += 1;
        clientAudioBytes += data.length;
        const level = measurePcm16Level(data);
        clientAudioPeak = Math.max(clientAudioPeak, level.peak);
        clientAudioSumSquares += level.rms * level.rms * Math.floor(data.length / 2);
        clientAudioSamples += Math.floor(data.length / 2);
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
  client.on('close', () => {
    discardAssistantAudioBuffer();
    deepgram.close();
  });
  client.on('error', () => deepgram.close());
});

app.listen({ port: PORT, host: HOST }).catch((error) => {
  app.log.error(error);
  process.exitCode = 1;
});
