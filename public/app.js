import { createConnectionLifecycle } from '/connection-lifecycle.js';

const SAMPLE_RATE = 24000;
const PLAYBACK_LEAD_SECONDS = 0.08;
const startBtn = document.querySelector('#startBtn');
const stopBtn = document.querySelector('#stopBtn');
const resumeBtn = document.querySelector('#resumeBtn');
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
let wakeLock;
let wakeLockOperation = 0;
let mediaOperation = 0;
let desiredRunning = false;

const STALE_MEDIA_OPERATION = 'StaleMediaOperation';


function setStatus(message) { statusEl.textContent = message; }
function showResumeAction(message) {
  setStatus(message);
  resumeBtn.hidden = false;
}
function staleMediaOperationError() {
  const error = new Error('Media recovery was superseded.');
  error.name = STALE_MEDIA_OPERATION;
  return error;
}
function isStaleMediaOperation(error) { return error?.name === STALE_MEDIA_OPERATION; }
function isCurrentMediaOperation(operation) { return desiredRunning && operation === mediaOperation; }
function requireCurrentMediaOperation(operation, acquiredStream) {
  if (isCurrentMediaOperation(operation)) return;
  acquiredStream?.getTracks().forEach((track) => track.stop());
  throw staleMediaOperationError();
}
function invalidateMediaOperations() {
  desiredRunning = false;
  mediaOperation += 1;
}
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

function connectMicGraph() {
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

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    logEvent({ type: 'WakeLockUnavailable', description: 'Keep the iPhone screen awake in device settings.' });
    return;
  }
  if (document.visibilityState !== 'visible') return;
  if (wakeLock && !wakeLock.released) return;
  const operation = ++wakeLockOperation;
  const requestedWakeLock = await navigator.wakeLock.request('screen');
  if (!desiredRunning || operation !== wakeLockOperation || document.visibilityState !== 'visible') {
    await requestedWakeLock.release();
    return;
  }
  wakeLock = requestedWakeLock;
  requestedWakeLock.addEventListener('release', () => {
    if (wakeLock === requestedWakeLock) wakeLock = undefined;
  }, { once: true });
}

async function releaseWakeLock() {
  wakeLockOperation += 1;
  const activeWakeLock = wakeLock;
  wakeLock = undefined;
  await activeWakeLock?.release();
}

async function ensureMedia({ userGesture = false } = {}) {
  const operation = ++mediaOperation;
  requireCurrentMediaOperation(operation);
  const track = micStream?.getAudioTracks()[0];
  const hasLiveTrack = Boolean(track && track.readyState === 'live');
  if (!hasLiveTrack) {
    processor?.disconnect();
    source?.disconnect();
    processor = undefined;
    source = undefined;
    micStream?.getTracks().forEach((item) => item.stop());
    let acquiredStream;
    try {
      acquiredStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      requireCurrentMediaOperation(operation);
      throw error;
    }
    requireCurrentMediaOperation(operation, acquiredStream);
    micStream = acquiredStream;
  }
  if (!audioContext || audioContext.state === 'closed') {
    processor?.disconnect();
    source?.disconnect();
    processor = undefined;
    source = undefined;
    audioContext = new AudioContext();
  }
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
    } catch (error) {
      requireCurrentMediaOperation(operation);
      throw error;
    }
    requireCurrentMediaOperation(operation);
  }
  if (!source || !processor) connectMicGraph();
  if (userGesture) {
    try {
      await requestWakeLock();
    } catch (error) {
      requireCurrentMediaOperation(operation);
      logEvent({ type: 'WakeLockWarning', description: error.message });
    }
    requireCurrentMediaOperation(operation);
  }
  requireCurrentMediaOperation(operation);
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
  invalidateMediaOperations();
  releaseWakeLock().catch((error) => logEvent({ type: 'WakeLockWarning', description: error.message }));
  releaseBrowserResources({ preserveStatus: true });
}

function handleConnectionFailure(generation, error) {
  if (isStaleMediaOperation(error)) return;
  if (!lifecycle.isActiveGeneration(generation)) return;
  logEvent({ type: 'BrowserError', description: error.message });
  canStreamMic = false;
  setMicState('idle', 'Mic needs attention');
  closeActiveSocket();
  showResumeAction(error.message);
}

async function connectConversation(generation) {
  if (!lifecycle.isActiveGeneration(generation)) return;
  const operation = mediaOperation + 1;
  await ensureMedia();
  if (!isCurrentMediaOperation(operation) || !lifecycle.isActiveGeneration(generation)) return;
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
  desiredRunning = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  transcriptEl.textContent = '';
  eventsEl.textContent = '';
  canStreamMic = false;
  outboundAudioFrames = 0;
  outboundAudioBytes = 0;
  lastAudioStatusAt = 0;
  resumeBtn.hidden = true;
  setMicState('connecting', 'Mic warming up');
  const operation = mediaOperation + 1;
  await ensureMedia({ userGesture: true });
  if (startupGeneration !== browserStartupGeneration) {
    releaseBrowserResources({ preserveStatus: true });
    return;
  }
  if (!isCurrentMediaOperation(operation)) {
    releaseBrowserResources({ preserveStatus: true });
    return;
  }
  lifecycle.start();
}

async function stopConversation() {
  browserStartupGeneration += 1;
  invalidateMediaOperations();
  lifecycle.stop();
  resumeBtn.hidden = true;
  try {
    await releaseWakeLock();
  } catch (error) {
    logEvent({ type: 'WakeLockWarning', description: error.message });
  }
  releaseBrowserResources();
}

startBtn.addEventListener('click', () => startConversation().catch(async (error) => {
  if (isStaleMediaOperation(error)) return;
  logEvent({ type: 'BrowserError', description: error.message });
  setStatus(error.message);
  browserStartupGeneration += 1;
  invalidateMediaOperations();
  lifecycle.stop();
  try {
    await releaseWakeLock();
  } catch (wakeLockError) {
    logEvent({ type: 'WakeLockWarning', description: wakeLockError.message });
  }
  releaseBrowserResources({ preserveStatus: true });
}));
stopBtn.addEventListener('click', () => stopConversation());
resumeBtn.addEventListener('click', async () => {
  const recoveryGeneration = lifecycle.snapshot().generation;
  const operation = mediaOperation + 1;
  try {
    await ensureMedia({ userGesture: true });
    const snapshot = lifecycle.snapshot();
    if (!isCurrentMediaOperation(operation) || !snapshot.desiredRunning || snapshot.generation !== recoveryGeneration) return;
    resumeBtn.hidden = true;
    lifecycle.retryNow();
  } catch (error) {
    if (isStaleMediaOperation(error) || !desiredRunning || !lifecycle.snapshot().desiredRunning) return;
    showResumeAction(error.message);
  }
});
window.addEventListener('online', () => {
  if (lifecycle.snapshot().state === 'retry-wait') lifecycle.retryNow();
});
document.addEventListener('visibilitychange', async () => {
  const visibilitySnapshot = lifecycle.snapshot();
  if (document.visibilityState !== 'visible' || !visibilitySnapshot.desiredRunning) return;
  requestWakeLock().catch((error) => logEvent({ type: 'WakeLockWarning', description: error.message }));
  if (visibilitySnapshot.state === 'connecting') return;
  const recoveryGeneration = lifecycle.snapshot().generation;
  const operation = mediaOperation + 1;
  try {
    await ensureMedia();
    const snapshot = lifecycle.snapshot();
    if (!isCurrentMediaOperation(operation) || !snapshot.desiredRunning || snapshot.generation !== recoveryGeneration) return;
    if (snapshot.state === 'retry-wait') lifecycle.retryNow();
  } catch (error) {
    if (isStaleMediaOperation(error) || !desiredRunning || !lifecycle.snapshot().desiredRunning) return;
    showResumeAction(error.message);
  }
});
