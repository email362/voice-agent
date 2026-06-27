const SAMPLE_RATE = 24000;
const startBtn = document.querySelector('#startBtn');
const stopBtn = document.querySelector('#stopBtn');
const statusEl = document.querySelector('#status');
const eventsEl = document.querySelector('#events');
const transcriptEl = document.querySelector('#transcript');

let socket;
let micStream;
let audioContext;
let source;
let processor;
let nextPlaybackTime = 0;
let keepAlive;


function setStatus(message) { statusEl.textContent = message; }
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
    if (socket?.readyState !== WebSocket.OPEN) return;
    const pcm = floatTo16BitPcm(downsample(event.inputBuffer.getChannelData(0), audioContext.sampleRate, SAMPLE_RATE));
    socket.send(pcm);
  };
  source.connect(processor);
  processor.connect(audioContext.destination);
}

function playPcm(arrayBuffer) {
  const int16 = new Int16Array(arrayBuffer);
  const audioBuffer = audioContext.createBuffer(1, int16.length, SAMPLE_RATE);
  const channel = audioBuffer.getChannelData(0);
  for (let i = 0; i < int16.length; i += 1) channel[i] = int16[i] / 32768;
  const node = audioContext.createBufferSource();
  node.buffer = audioBuffer;
  node.connect(audioContext.destination);
  const startAt = Math.max(audioContext.currentTime, nextPlaybackTime);
  node.start(startAt);
  nextPlaybackTime = startAt + audioBuffer.duration;
}

async function startConversation() {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  transcriptEl.textContent = '';
  eventsEl.textContent = '';
  await startMic();
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/agent`);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => { setStatus('Connected to proxy. Waiting for Deepgram welcome...'); });
  socket.addEventListener('message', (message) => {
    if (message.data instanceof ArrayBuffer) {
      playPcm(message.data);
      return;
    }
    const event = JSON.parse(message.data);
    logEvent(event);
    if (event.type === 'Welcome') socket.send(JSON.stringify(buildSettings()));
    if (event.type === 'SettingsApplied') setStatus('Live. Speak into your microphone.');
    if (event.type === 'ConversationText') addTranscript(event.role, event.content);
    if (event.type === 'Error' || event.type === 'ProxyError') setStatus(event.description || 'An error occurred.');
  });
  socket.addEventListener('close', stopConversation);
  keepAlive = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'KeepAlive' })), 8000);
}

function stopConversation() {
  clearInterval(keepAlive);
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  processor?.disconnect();
  source?.disconnect();
  micStream?.getTracks().forEach((track) => track.stop());
  audioContext?.close();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('Stopped.');
}

startBtn.addEventListener('click', () => startConversation().catch((error) => { logEvent({ type: 'BrowserError', description: error.message }); setStatus(error.message); stopConversation(); }));
stopBtn.addEventListener('click', stopConversation);
