import { createConnectionLifecycle } from '/connection-lifecycle.js';

const SAMPLE_RATE = 24000;
const PLAYBACK_LEAD_SECONDS = 0.08;
const startBtn = document.querySelector('#startBtn');
const stopBtn = document.querySelector('#stopBtn');
const statusEl = document.querySelector('#status');
const eventsEl = document.querySelector('#events');
const transcriptEl = document.querySelector('#transcript');
const micIndicator = document.querySelector('#micIndicator');
const micLabel = document.querySelector('#micLabel');

let socket;
let micStream;
let audioContext;
let source;
let processor;
let nextPlaybackTime = 0;
let playbackNodes = new Set();
let playbackQueue = Promise.resolve();
let canStreamMic = false;
let outboundAudioFrames = 0;
let outboundAudioBytes = 0;
let lastAudioStatusAt = 0;
let playbackGeneration = 0;
let browserStartupGeneration = 0;
let socketCleanup;


function setStatus(message) { statusEl.textContent = message; }
function setMicState(state, label) {
  micIndicator.dataset.state = state;
  micLabel.textContent = label;
}
function logEvent(event) { eventsEl.textContent = `${JSON.stringify(event, null, 2)}\n\n${eventsEl.textContent}`.slice(0, 12000); }
function addTranscript(role, content) {
  const bubble = document.createElement('div');
  bubble.className = `bubble ${role}`;
  bubble.textContent = `${role}: ${content}`;
  transcriptEl.appendChild(bubble);
  bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function buildSettings() {
  return {
    type: 'Settings',
    audio: {
      input: { encoding: 'linear16', sample_rate: SAMPLE_RATE },
      output: { encoding: 'linear16', sample_rate: SAMPLE_RATE, container: 'none' },
    },
    agent: {
      language: document.querySelector('#language').value,
      listen: { provider: { type: 'deepgram', model: 'flux-general-en', version: 'v2' } },
      think: {
        provider: { type: 'open_ai', model: document.querySelector('#thinkModel').value, temperature: 0.7 },
        prompt: document.querySelector('#prompt').value,
      },
      speak: { provider: { type: 'deepgram', model: document.querySelector('#voiceModel').value } },
      greeting: document.querySelector('#greeting').value,
    },
  };
}

function floatTo16BitPcm(float32) {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

function downsample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const length = Math.round(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) output[i] = input[Math.floor(i * ratio)];
  return output;
}

async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  audioContext = new AudioContext();
  nextPlaybackTime = audioContext.currentTime;
  source = audioContext.createMediaStreamSource(micStream);
  processor = audioContext.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event) => {
    if (!canStreamMic || socket?.readyState !== WebSocket.OPEN) return;
    const pcm = floatTo16BitPcm(downsample(event.inputBuffer.getChannelData(0), audioContext.sampleRate, SAMPLE_RATE));
    socket.send(pcm);
    outboundAudioFrames += 1;
    outboundAudioBytes += pcm.byteLength;
    const now = Date.now();
    if (now - lastAudioStatusAt > 2000) {
      lastAudioStatusAt = now;
      setMicState('streaming', `Mic streaming (${outboundAudioFrames} frames)`);
      setStatus(`Live. Streaming microphone audio (${outboundAudioFrames} frames, ${Math.round(outboundAudioBytes / 1024)} KB).`);
    }
  };
  source.connect(processor);
  processor.connect(audioContext.destination);
}

function stopPlayback() {
  playbackGeneration += 1;
  playbackQueue = Promise.resolve();
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

function isWavAudio(arrayBuffer) {
  const header = new Uint8Array(arrayBuffer.slice(0, 12));
  return String.fromCharCode(...header.slice(0, 4)) === 'RIFF' && String.fromCharCode(...header.slice(8, 12)) === 'WAVE';
}

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

async function playWav(arrayBuffer, generation = playbackGeneration) {
  const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  if (generation !== playbackGeneration) return;
  scheduleAudioBuffer(decoded, generation);
}

function playPcm(arrayBuffer, generation = playbackGeneration) {
  if (generation !== playbackGeneration) return;
  const int16 = new Int16Array(arrayBuffer);
  const audioBuffer = audioContext.createBuffer(1, int16.length, SAMPLE_RATE);
  const channel = audioBuffer.getChannelData(0);
  for (let i = 0; i < int16.length; i += 1) channel[i] = int16[i] / 32768;
  scheduleAudioBuffer(audioBuffer, generation);
}

async function playAudio(arrayBuffer, generation = playbackGeneration) {
  if (isWavAudio(arrayBuffer)) {
    await playWav(arrayBuffer, generation);
    return;
  }
  playPcm(arrayBuffer, generation);
}

function queuePlayback(arrayBuffer, generation = playbackGeneration) {
  const queued = playbackQueue
    .catch(() => {})
    .then(async () => {
      if (generation !== playbackGeneration) return;
      await playAudio(arrayBuffer, generation);
    });
  playbackQueue = queued;
  return queued;
}

function closeActiveSocket() {
  const activeSocket = socket;
  socketCleanup?.();
  socketCleanup = undefined;
  if (socket === activeSocket) socket = undefined;
  if (activeSocket && activeSocket.readyState !== WebSocket.CLOSED && activeSocket.readyState !== WebSocket.CLOSING) activeSocket.close();
}

function releaseBrowserResources({ preserveStatus = false, statusMessage = 'Stopped.' } = {}) {
  canStreamMic = false;
  setMicState('idle', 'Mic idle');
  stopPlayback();
  closeActiveSocket();
  processor?.disconnect();
  source?.disconnect();
  micStream?.getTracks().forEach((track) => track.stop());
  audioContext?.close();
  processor = undefined;
  source = undefined;
  micStream = undefined;
  audioContext = undefined;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  if (!preserveStatus) setStatus(statusMessage);
}

function recoverConnection(generation, conversationSocket) {
  if (!lifecycle.isActiveGeneration(generation) || conversationSocket !== socket) return;
  canStreamMic = false;
  setMicState('connecting', 'Mic reconnecting');
  stopPlayback();
  closeActiveSocket();
  lifecycle.scheduleRetry(generation);
}

function failTerminally(generation, description) {
  if (!lifecycle.isActiveGeneration(generation)) return;
  setStatus(description || 'An error occurred.');
  lifecycle.terminalFailure(generation);
  releaseBrowserResources({ preserveStatus: true });
}

function handleConnectionFailure(generation, error) {
  if (!lifecycle.isActiveGeneration(generation)) return;
  logEvent({ type: 'BrowserError', description: error.message });
  recoverConnection(generation, socket);
}

async function connectConversation(generation) {
  if (!lifecycle.isActiveGeneration(generation)) return;
  closeActiveSocket();
  canStreamMic = false;
  setMicState('connecting', 'Mic reconnecting');
  let settingsApplied = false;
  let socketKeepAlive;
  let socketCleanedUp = false;
  const clearSocket = () => {
    if (socketCleanedUp) return;
    socketCleanedUp = true;
    clearInterval(socketKeepAlive);
    if (socket === conversationSocket) socket = undefined;
    if (socketCleanup === clearSocket) socketCleanup = undefined;
  };
  const conversationSocket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/agent`);
  conversationSocket.generation = generation;
  socket = conversationSocket;
  socketCleanup = clearSocket;
  conversationSocket.binaryType = 'arraybuffer';
  const isActiveSocket = () => lifecycle.isActiveGeneration(generation) && conversationSocket === socket;
  conversationSocket.addEventListener('open', () => {
    if (!isActiveSocket()) {
      clearSocket();
      return;
    }
    setStatus('Connected to proxy. Waiting for Deepgram welcome...');
  });
  conversationSocket.addEventListener('message', (message) => {
    if (!isActiveSocket()) {
      clearSocket();
      return;
    }
    if (message.data instanceof ArrayBuffer) {
      const playbackToken = playbackGeneration;
      queuePlayback(message.data, playbackToken).catch((error) => logEvent({ type: 'PlaybackError', description: error.message }));
      return;
    }
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    logEvent(event);
    if (event.type === 'UserStartedSpeaking') stopPlayback();
    if (event.type === 'Welcome') conversationSocket.send(JSON.stringify(buildSettings()));
    if (event.type === 'SettingsApplied') {
      settingsApplied = true;
      lifecycle.markLive(generation);
      canStreamMic = true;
      setMicState('live', 'Mic live');
      setStatus('Live. Speak into your microphone.');
    }
    if (event.type === 'ConversationText') addTranscript(event.role, event.content);
    if (event.type === 'Error' || event.type === 'ProxyError') {
      setStatus(event.description || 'An error occurred.');
      if (event.retryable === false || (event.type === 'Error' && !settingsApplied)) {
        failTerminally(generation, event.description);
        return;
      }
      recoverConnection(generation, conversationSocket);
    }
  });
  conversationSocket.addEventListener('error', () => {
    if (!isActiveSocket()) {
      clearSocket();
      return;
    }
    recoverConnection(generation, conversationSocket);
  });
  conversationSocket.addEventListener('close', () => {
    if (!isActiveSocket()) {
      clearSocket();
      return;
    }
    clearSocket();
    canStreamMic = false;
    setMicState('connecting', 'Mic reconnecting');
    stopPlayback();
    lifecycle.scheduleRetry(generation);
  });
  socketKeepAlive = setInterval(() => {
    if (!isActiveSocket()) {
      clearSocket();
      return;
    }
    if (conversationSocket.readyState === WebSocket.OPEN) conversationSocket.send(JSON.stringify({ type: 'KeepAlive' }));
  }, 8000);
}

const lifecycle = createConnectionLifecycle({
  connect: (generation) => {
    connectConversation(generation).catch((error) => handleConnectionFailure(generation, error));
  },
  onStateChange: ({ state, retryAttempt }) => {
    if (state === 'retry-wait') setStatus(`Disconnected. Retrying automatically (attempt ${retryAttempt})...`);
  },
});

async function startConversation() {
  const startupGeneration = ++browserStartupGeneration;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  transcriptEl.textContent = '';
  eventsEl.textContent = '';
  canStreamMic = false;
  outboundAudioFrames = 0;
  outboundAudioBytes = 0;
  lastAudioStatusAt = 0;
  setMicState('connecting', 'Mic warming up');
  await startMic();
  if (startupGeneration !== browserStartupGeneration) {
    releaseBrowserResources({ preserveStatus: true });
    return;
  }
  lifecycle.start();
}

function stopConversation() {
  browserStartupGeneration += 1;
  lifecycle.stop();
  releaseBrowserResources();
}

startBtn.addEventListener('click', () => startConversation().catch((error) => {
  logEvent({ type: 'BrowserError', description: error.message });
  setStatus(error.message);
  browserStartupGeneration += 1;
  lifecycle.stop();
  releaseBrowserResources({ preserveStatus: true });
}));
stopBtn.addEventListener('click', () => stopConversation());
window.addEventListener('online', () => lifecycle.retryNow());
