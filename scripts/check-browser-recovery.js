const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const app = fs.readFileSync('public/app.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');

assert.match(app, /import \{ createConnectionLifecycle \} from '\/connection-lifecycle\.js';/);
assert.match(app, /const lifecycle = createConnectionLifecycle\(/);
assert.match(app, /lifecycle\.isActiveGeneration\(generation\)/);
assert.match(app, /lifecycle\.scheduleRetry\(generation\)/);
assert.match(app, /window\.addEventListener\('online', \(\) => lifecycle\.retryNow\(\)\)/);
assert.match(app, /event\.retryable === false/);
assert.match(app, /lifecycle\.terminalFailure\(generation\)/);
assert.match(app, /socketKeepAlive = setInterval/);
assert.match(app, /clearInterval\(socketKeepAlive\)/);
assert.match(server, /retryable: false/);
assert.match(server, /retryable: true/);
assert.match(app, /async function ensureMedia\(\{ userGesture = false \} = \{\}\)/);
assert.match(app, /audioContext\.state === 'suspended'/);
assert.match(app, /track\.readyState === 'live'/);
assert.match(app, /navigator\.wakeLock\.request\('screen'\)/);
assert.match(app, /document\.addEventListener\('visibilitychange'/);
assert.match(app, /await releaseWakeLock\(\)/);
assert.match(app, /showResumeAction\(error\.message\)/);
assert.match(html, /id="resumeBtn"/);

function createBrowserHarness() {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) {
      const listeners = new Map();
      elements.set(selector, {
        dataset: {},
        value: '',
        textContent: '',
        disabled: false,
        hidden: false,
        addEventListener(type, listener) { listeners.set(type, listener); },
        dispatch(type) { return listeners.get(type)?.(); },
        appendChild() {},
        scrollIntoView() {},
      });
    }
    return elements.get(selector);
  };
  const scheduledRetries = [];
  const intervals = new Set();
  const documentListeners = new Map();
  const media = { calls: 0, error: undefined, tracks: [] };
  const wakeLocks = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type, listener) { this.listeners.set(type, listener); }
    send() {}
    close() { this.readyState = FakeWebSocket.CLOSED; }
    deliver(type, event = {}) { this.listeners.get(type)?.(event); }
  }
  class FakeAudioContext {
    static instances = [];

    constructor() {
      this.currentTime = 0;
      this.sampleRate = 48000;
      this.destination = {};
      this.state = 'running';
      this.resumeCalls = 0;
      FakeAudioContext.instances.push(this);
    }

    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return { connect() {}, disconnect() {} }; }
    async resume() { this.resumeCalls += 1; this.state = 'running'; }
    async close() { this.state = 'closed'; }
  }
  const lifecycleSource = fs.readFileSync('public/connection-lifecycle.js', 'utf8').replaceAll('export ', '');
  const executableApp = app.replace("import { createConnectionLifecycle } from '/connection-lifecycle.js';", '');
  const context = {
    ArrayBuffer,
    AudioContext: FakeAudioContext,
    Date,
    DataView,
    Float32Array,
    Int16Array,
    JSON,
    Math,
    Uint8Array,
    WebSocket: FakeWebSocket,
    clearInterval(handle) { intervals.delete(handle); },
    clearTimeout() {},
    document: {
      visibilityState: 'visible',
      querySelector: element,
      createElement: () => ({ className: '', textContent: '', scrollIntoView() {} }),
      addEventListener(type, listener) { documentListeners.set(type, listener); },
    },
    location: { protocol: 'http:', host: 'localhost' },
    navigator: {
      mediaDevices: {
        async getUserMedia() {
          media.calls += 1;
          if (media.error) throw media.error;
          const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
          media.tracks.push(track);
          return { getAudioTracks: () => [track], getTracks: () => [track] };
        },
      },
      wakeLock: {
        async request(type) {
          assert.equal(type, 'screen');
          const listeners = new Map();
          const lock = {
            released: false,
            addEventListener(event, listener) { listeners.set(event, listener); },
            async release() {
              this.released = true;
              listeners.get('release')?.();
            },
          };
          wakeLocks.push(lock);
          return lock;
        },
      },
    },
    setInterval(callback) { const handle = { callback }; intervals.add(handle); return handle; },
    setTimeout(callback, delay) { const handle = { callback, delay }; scheduledRetries.push(handle); return handle; },
    window: { addEventListener() {} },
  };
  vm.runInNewContext(`${lifecycleSource}\n${executableApp}`, context);
  return {
    context,
    documentListeners,
    element,
    FakeAudioContext,
    FakeWebSocket,
    media,
    scheduledRetries,
    wakeLocks,
  };
}

async function settleAsyncWork() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

async function checkGenerationScopedErrorRecovery() {
  const { element, FakeWebSocket, scheduledRetries } = createBrowserHarness();
  await element('#startBtn').dispatch('click');
  await settleAsyncWork();
  const staleSocket = FakeWebSocket.instances[0];
  assert.equal(staleSocket.generation, 1);
  staleSocket.readyState = FakeWebSocket.OPEN;
  staleSocket.deliver('message', { data: JSON.stringify({ type: 'SettingsApplied' }) });
  staleSocket.deliver('error');
  assert.equal(scheduledRetries.length, 1, 'active socket errors should schedule recovery');

  scheduledRetries.shift().callback();
  await settleAsyncWork();
  const activeSocket = FakeWebSocket.instances[1];
  assert.equal(activeSocket.generation, 2);
  staleSocket.deliver('close');
  staleSocket.deliver('error');
  assert.equal(scheduledRetries.length, 0, 'stale socket close/error events should not schedule recovery');
  activeSocket.deliver('error');
  assert.equal(scheduledRetries.length, 1, 'the active generation should still schedule recovery');
}

async function checkActiveCloseRecovery() {
  const { element, FakeWebSocket, scheduledRetries } = createBrowserHarness();
  await element('#startBtn').dispatch('click');
  await settleAsyncWork();
  const activeSocket = FakeWebSocket.instances[0];
  assert.equal(activeSocket.generation, 1);
  activeSocket.readyState = FakeWebSocket.OPEN;
  activeSocket.deliver('message', { data: JSON.stringify({ type: 'SettingsApplied' }) });
  activeSocket.deliver('close');
  assert.equal(scheduledRetries.length, 1, 'an active socket close should schedule exactly one recovery');
  activeSocket.deliver('close');
  assert.equal(scheduledRetries.length, 1, 'repeated close delivery should not schedule duplicate recovery');
}

async function checkRetryReusesLiveMedia() {
  const { element, FakeAudioContext, FakeWebSocket, media, scheduledRetries, wakeLocks } = createBrowserHarness();
  await element('#startBtn').dispatch('click');
  await settleAsyncWork();
  assert.equal(media.calls, 1, 'start should acquire microphone media');
  assert.equal(FakeAudioContext.instances.length, 1, 'start should create one audio context');
  assert.equal(wakeLocks.length, 1, 'a user gesture should acquire the screen wake lock');

  const activeSocket = FakeWebSocket.instances[0];
  FakeAudioContext.instances[0].state = 'suspended';
  activeSocket.deliver('error');
  scheduledRetries.shift().callback();
  await settleAsyncWork();
  assert.equal(FakeWebSocket.instances.length, 2, 'socket recovery should reconnect');
  assert.equal(media.calls, 1, 'socket recovery should reuse a live microphone track');
  assert.equal(FakeAudioContext.instances.length, 1, 'socket recovery should reuse the audio context');
  assert.equal(FakeAudioContext.instances[0].resumeCalls, 1, 'socket recovery should resume a suspended audio context');
}

async function checkGestureRecoveryAfterMediaFailure() {
  const { element, FakeWebSocket, media, scheduledRetries } = createBrowserHarness();
  await element('#startBtn').dispatch('click');
  await settleAsyncWork();
  const activeSocket = FakeWebSocket.instances[0];
  media.tracks[0].readyState = 'ended';
  media.error = new Error('Tap to restore microphone');
  activeSocket.deliver('error');
  scheduledRetries.shift().callback();
  await settleAsyncWork();

  assert.equal(FakeWebSocket.instances.length, 1, 'media failure should pause new socket attempts');
  assert.equal(element('#resumeBtn').hidden, false, 'media failure should reveal the resume action');
  assert.equal(element('#status').textContent, 'Tap to restore microphone');

  media.error = undefined;
  await element('#resumeBtn').dispatch('click');
  await settleAsyncWork();
  assert.equal(element('#resumeBtn').hidden, true, 'successful gesture recovery should hide the resume action');
  assert.equal(FakeWebSocket.instances.length, 2, 'successful gesture recovery should retry immediately');
}

async function checkVisibilityAndStopWakeLockHandling() {
  const { context, documentListeners, element, wakeLocks } = createBrowserHarness();
  await element('#startBtn').dispatch('click');
  await settleAsyncWork();
  await wakeLocks[0].release();
  documentListeners.get('visibilitychange')();
  await settleAsyncWork();
  assert.equal(wakeLocks.length, 2, 'visible running conversations should reacquire the wake lock');

  await element('#stopBtn').dispatch('click');
  assert.equal(wakeLocks[1].released, true, 'stop should release the active wake lock');
  context.document.visibilityState = 'hidden';
  documentListeners.get('visibilitychange')();
  await settleAsyncWork();
  assert.equal(wakeLocks.length, 2, 'hidden or stopped conversations should not acquire a wake lock');
}

Promise.all([
  checkGenerationScopedErrorRecovery(),
  checkActiveCloseRecovery(),
  checkRetryReusesLiveMedia(),
  checkGestureRecoveryAfterMediaFailure(),
  checkVisibilityAndStopWakeLockHandling(),
])
  .then(() => console.log('browser recovery integration checks passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
