require('dotenv').config();
const path = require('node:path');
const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 3000);
const DEEPGRAM_AGENT_URL = process.env.DEEPGRAM_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

const app = Fastify({ logger: true });
app.register(fastifyStatic, { root: path.join(__dirname, 'public') });

app.get('/health', async () => ({ ok: true, hasDeepgramKey: Boolean(DEEPGRAM_API_KEY) }));

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

  const deepgram = new WebSocket(DEEPGRAM_AGENT_URL, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  const sendToClient = (data, isBinary = false) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  };
  const sendToDeepgram = (data, isBinary = false) => {
    if (deepgram.readyState === WebSocket.OPEN) deepgram.send(data, { binary: isBinary });
  };

  deepgram.on('open', () => sendToClient(JSON.stringify({ type: 'ProxyConnected' })));
  deepgram.on('message', (data, isBinary) => sendToClient(data, isBinary));
  deepgram.on('error', (error) => sendToClient(JSON.stringify({ type: 'ProxyError', description: error.message })));
  deepgram.on('close', (code, reason) => {
    sendToClient(JSON.stringify({ type: 'ProxyClosed', code, reason: reason.toString() }));
    if (client.readyState === WebSocket.OPEN) client.close();
  });

  client.on('message', (data, isBinary) => sendToDeepgram(data, isBinary));
  client.on('close', () => deepgram.close());
  client.on('error', () => deepgram.close());
});

app.listen({ port: PORT, host: '0.0.0.0' });
