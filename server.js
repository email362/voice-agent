require('dotenv').config();
const path = require('node:path');
const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');
const WebSocket = require('ws');
const { convertPcmWithRvc, isRvcConfigured } = require('./rvc-audio');

const PORT = Number(process.env.PORT || 3000);
const DEEPGRAM_AGENT_URL = process.env.DEEPGRAM_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEBUG_AUDIO = process.env.DEBUG_AUDIO === '1';
const RVC_SERVICE_URL = process.env.RVC_SERVICE_URL ?? 'http://127.0.0.1:5055';
const RVC_TIMEOUT_MS = Number(process.env.RVC_TIMEOUT_MS || 120000);
const RVC_PITCH = Number(process.env.RVC_PITCH || 0);
const RVC_INDEX_RATE = Number(process.env.RVC_INDEX_RATE || 0.5);
const RVC_F0_METHOD = process.env.RVC_F0_METHOD || 'rmvpe';

const app = Fastify({ logger: true });
app.register(fastifyStatic, { root: path.join(__dirname, 'public') });

app.get('/health', async () => ({
  ok: Boolean(DEEPGRAM_API_KEY),
  hasDeepgramKey: Boolean(DEEPGRAM_API_KEY),
  rvc: {
    configured: isRvcConfigured(RVC_SERVICE_URL),
    serviceUrl: RVC_SERVICE_URL,
  },
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
    client.send(JSON.stringify({ type: 'ProxyError', description: 'Missing DEEPGRAM_API_KEY. Copy .env.example to .env and add your key.' }));
    client.close(1011, 'Missing Deepgram API key');
    return;
  }

  let clientAudioFrames = 0;
  let clientAudioBytes = 0;
  let lastClientAudioLogAt = Date.now();
  let assistantAudioChunks = [];
  let assistantAudioBytes = 0;
  let assistantAudioGeneration = 0;
  let assistantAudioConversionController;
  let assistantAudioFlushChain = Promise.resolve();
  let rvcDisabledForSession = false;
  const rvcEnabled = () => isRvcConfigured(RVC_SERVICE_URL) && !rvcDisabledForSession;
  const clearAssistantAudioBuffer = () => {
    assistantAudioChunks = [];
    assistantAudioBytes = 0;
  };
  const abortAssistantAudioConversion = () => {
    assistantAudioConversionController?.abort();
    assistantAudioConversionController = undefined;
  };
  const discardAssistantAudioBuffer = () => {
    assistantAudioGeneration += 1;
    abortAssistantAudioConversion();
    clearAssistantAudioBuffer();
  };
  const logAudioProgress = () => {
    if (!DEBUG_AUDIO) return;
    const now = Date.now();
    if (now - lastClientAudioLogAt < 2000) return;
    lastClientAudioLogAt = now;
    app.log.info({ clientAudioFrames, clientAudioBytes }, 'client audio forwarded to Deepgram');
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

  const sendOriginalAssistantAudio = (chunks) => {
    chunks.forEach((chunk) => sendToClient(chunk, true));
  };

  const endConversation = (errorMessage) => {
    discardAssistantAudioBuffer();
    if (errorMessage) sendToClient(JSON.stringify({ type: 'ProxyError', description: errorMessage }));
    if (client.readyState !== WebSocket.CLOSED) client.close(1011, errorMessage || 'Deepgram websocket error');
    if (deepgram.readyState !== WebSocket.CLOSED) deepgram.close();
  };

  const flushAssistantAudio = async (generation) => {
    if (generation !== assistantAudioGeneration || !assistantAudioChunks.length) return;
    const chunks = assistantAudioChunks;
    const byteLength = assistantAudioBytes;
    clearAssistantAudioBuffer();

    if (!rvcEnabled()) {
      sendOriginalAssistantAudio(chunks);
      return;
    }

    const conversionController = new AbortController();
    assistantAudioConversionController = conversionController;
    try {
      app.log.info({ byteLength, serviceUrl: RVC_SERVICE_URL }, 'converting assistant audio with RVC');
      const converted = await convertPcmWithRvc(Buffer.concat(chunks, byteLength), {
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
      app.log.info({ inputBytes: byteLength, outputBytes: converted.length }, 'RVC conversion complete');
      if (generation !== assistantAudioGeneration) return;
      sendToClient(converted, true);
    } catch (error) {
      if (generation !== assistantAudioGeneration) return;
      rvcDisabledForSession = true;
      app.log.error({ err: error, byteLength }, 'RVC conversion failed; falling back to original assistant audio for this session');
      sendOriginalAssistantAudio(chunks);
      discardAssistantAudioBuffer();
    } finally {
      if (assistantAudioConversionController === conversionController) assistantAudioConversionController = undefined;
    }
  };
  const queueAssistantAudioFlush = (generation) => {
    assistantAudioFlushChain = assistantAudioFlushChain
      .catch(() => {})
      .then(() => flushAssistantAudio(generation));
    return assistantAudioFlushChain;
  };

  deepgram.on('open', () => sendToClient(JSON.stringify({ type: 'ProxyConnected' })));
  deepgram.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (rvcEnabled()) {
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
      void queueAssistantAudioFlush(generation);
    }
  });
  deepgram.on('error', (error) => endConversation(error.message));
  deepgram.on('close', (code, reason) => {
    sendToClient(JSON.stringify({ type: 'ProxyClosed', code, reason: reason.toString() }));
    if (client.readyState === WebSocket.OPEN) client.close();
  });

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
  client.on('close', () => {
    discardAssistantAudioBuffer();
    deepgram.close();
  });
  client.on('error', () => deepgram.close());
});

app.listen({ port: PORT, host: '0.0.0.0' });
