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
assert.match(app, /window\.addEventListener\('online'/);
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
  const windowListeners = new Map();
  const media = { calls: 0, defer: false, error: undefined, pending: [], tracks: [] };
  const createMediaStream = () => {
    const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
    media.tracks.push(track);
    return { getAudioTracks: () => [track], getTracks: () => [track] };
  };
  media.resolveAt = (index = 0) => {
    const [request] = media.pending.splice(index, 1);
    assert.ok(request, 'expected a deferred media request');
    const stream = createMediaStream();
    request.resolve(stream);
    return stream;
  };
  media.resolveNext = () => media.resolveAt(0);
  media.rejectNext = (error) => {
    const request = media.pending.shift();
    assert.ok(request, 'expected a deferred media request');
    request.reject(error);
  };
  const wakeLocks = [];
  const wakeLockRequests = { error: undefined };
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
      this.sources = [];
      this.processors = [];
      FakeAudioContext.instances.push(this);
    }

    createMediaStreamSource(stream) {
      const source = { context: this, disconnected: false, stream, connect() {}, disconnect() { this.disconnected = true; } };
      this.sources.push(source);
      return source;
    }
    createScriptProcessor() {
      const processor = { context: this, disconnected: false, connect() {}, disconnect() { this.disconnected = true; } };
      this.processors.push(processor);
      return processor;
    }
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
          if (media.defer) return new Promise((resolve, reject) => media.pending.push({ resolve, reject }));
          return createMediaStream();
        },
      },
      wakeLock: {
        async request(type) {
          assert.equal(type, 'screen');
          if (wakeLockRequests.error) throw wakeLockRequests.error;
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
    window: { addEventListener(type, listener) { windowListeners.set(type, listener); } },
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
    wakeLockRequests,
    windowListeners,
    lifecycleSnapshot: () => vm.runInNewContext('lifecycle.snapshot()', context),
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

async function checkWakeLockDenialDoesNotStopStartup() {
  const { element, FakeWebSocket, lifecycleSnapshot, wakeLockRequests } = createBrowserHarness();
  wakeLockRequests.error = new Error('Wake Lock permission denied');

  await element('#startBtn').dispatch('click');
  await settleAsyncWork();

  assert.equal(FakeWebSocket.instances.length, 1, 'wake-lock denial should still create the first WebSocket');
  assert.equal(lifecycleSnapshot().desiredRunning, true, 'wake-lock denial should preserve desired-running state');
  assert.match(element('#events').textContent, /"type": "WakeLockWarning"/);
  assert.match(element('#events').textContent, /Wake Lock permission denied/);
}

async function checkLiveRecoverySignalsDoNotReplaceSocket() {
  const { documentListeners, element, FakeWebSocket, windowListeners } = createBrowserHarness();
  await element('#startBtn').dispatch('click');
  await settleAsyncWork();
  const activeSocket = FakeWebSocket.instances[0];
  activeSocket.readyState = FakeWebSocket.OPEN;
  activeSocket.deliver('message', { data: JSON.stringify({ type: 'SettingsApplied' }) });

  windowListeners.get('online')();
  documentListeners.get('visibilitychange')();
  await settleAsyncWork();

  assert.equal(FakeWebSocket.instances.length, 1, 'online/visible signals while live must not replace the healthy socket');
}

async function checkOnlineAcceleratesRetryWait() {
  const { element, FakeWebSocket, scheduledRetries, windowListeners } = createBrowserHarness();
  await element('#startBtn').dispatch('click');
  await settleAsyncWork();
  FakeWebSocket.instances[0].deliver('error');
  assert.equal(scheduledRetries.length, 1, 'socket failure should enter retry-wait');

  windowListeners.get('online')();
  await settleAsyncWork();

  assert.equal(FakeWebSocket.instances.length, 2, 'online should accelerate a pending retry');
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

async function checkClosedContextRebuildsGraph() {
  const { element, FakeAudioContext, FakeWebSocket, scheduledRetries } = createBrowserHarness();
  await element('#startBtn').dispatch('click');
  await settleAsyncWork();
  const originalContext = FakeAudioContext.instances[0];
  const originalSource = originalContext.sources[0];
  await originalContext.close();

  FakeWebSocket.instances[0].deliver('error');
  scheduledRetries.shift().callback();
  await settleAsyncWork();

  assert.equal(FakeAudioContext.instances.length, 2, 'closed context recovery should create a new audio context');
  assert.equal(originalSource.disconnected, true, 'closed context recovery should disconnect the old graph');
  assert.equal(FakeAudioContext.instances[1].sources.length, 1, 'closed context recovery should build a graph on the new context');
  assert.equal(typeof FakeAudioContext.instances[1].processors[0].onaudioprocess, 'function', 'the rebuilt graph should process microphone audio');
  assert.equal(FakeWebSocket.instances.length, 2, 'closed context recovery should continue to a new socket');
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

async function checkDeferredMediaCannotSurviveStop() {
  const { element, FakeWebSocket, media, scheduledRetries } = createBrowserHarness();
  await element('#startBtn').dispatch('click');
  await settleAsyncWork();
  media.tracks[0].readyState = 'ended';
  media.defer = true;
  FakeWebSocket.instances[0].deliver('error');
  scheduledRetries.shift().callback();
  await settleAsyncWork();
  assert.equal(media.pending.length, 1, 'recovery should be waiting for deferred media');

  await element('#stopBtn').dispatch('click');
  const staleStream = media.resolveNext();
  await settleAsyncWork();
  assert.equal(staleStream.getAudioTracks()[0].readyState, 'ended', 'media acquired after Stop should be stopped');
  assert.equal(FakeWebSocket.instances.length, 1, 'media acquired after Stop should not create another socket');
  assert.equal(element('#resumeBtn').hidden, true, 'stale success should not reveal Resume');
  assert.equal(element('#status').textContent, 'Stopped.', 'stale success should not replace the stopped UI');
}

async function checkDeferredMediaFailureCannotSurviveStop() {
  const { element, FakeWebSocket, media, scheduledRetries } = createBrowserHarness();
  await element('#startBtn').dispatch('click');
  await settleAsyncWork();
  media.tracks[0].readyState = 'ended';
  media.defer = true;
  FakeWebSocket.instances[0].deliver('error');
  scheduledRetries.shift().callback();
  await settleAsyncWork();

  await element('#stopBtn').dispatch('click');
  media.rejectNext(new Error('late media failure'));
  await settleAsyncWork();
  assert.equal(element('#resumeBtn').hidden, true, 'stale media failure should not reveal Resume');
  assert.equal(element('#status').textContent, 'Stopped.', 'stale media failure should not replace the stopped UI');
}

async function checkDeferredResumeCannotSurviveStop() {
  const { element, FakeWebSocket, media, scheduledRetries } = createBrowserHarness();
  await element('#startBtn').dispatch('click');
  await settleAsyncWork();
  media.tracks[0].readyState = 'ended';
  media.error = new Error('gesture required');
  FakeWebSocket.instances[0].deliver('error');
  scheduledRetries.shift().callback();
  await settleAsyncWork();
  assert.equal(element('#resumeBtn').hidden, false, 'media failure should expose Resume before the gesture test');

  media.error = undefined;
  media.defer = true;
  const resumeAttempt = element('#resumeBtn').dispatch('click');
  await settleAsyncWork();
  await element('#stopBtn').dispatch('click');
  const staleStream = media.resolveNext();
  await resumeAttempt;
  await settleAsyncWork();
  assert.equal(staleStream.getAudioTracks()[0].readyState, 'ended', 'deferred Resume media should be stopped after Stop');
  assert.equal(FakeWebSocket.instances.length, 1, 'deferred Resume should not retry after Stop');
  assert.equal(element('#resumeBtn').hidden, true, 'deferred Resume should not change stopped UI');
  assert.equal(element('#status').textContent, 'Stopped.', 'deferred Resume should preserve stopped status');
}

async function checkVisibilityDoesNotSupersedeConnectingRecovery() {
  const { documentListeners, element, FakeWebSocket, media, scheduledRetries } = createBrowserHarness();
  await element('#startBtn').dispatch('click');
  await settleAsyncWork();
  media.tracks[0].readyState = 'ended';
  media.defer = true;
  FakeWebSocket.instances[0].deliver('error');
  scheduledRetries.shift().callback();
  documentListeners.get('visibilitychange')();
  await settleAsyncWork();
  assert.equal(media.pending.length, 1, 'visibility while connecting should not supersede active media recovery');

  const currentStream = media.resolveNext();
  await settleAsyncWork();
  assert.equal(currentStream.getAudioTracks()[0].readyState, 'live', 'active recovery media should remain live');
  assert.equal(FakeWebSocket.instances.length, 2, 'active recovery should create one replacement socket');
  assert.equal(element('#resumeBtn').hidden, true, 'visibility during recovery should not expose Resume');
}

Promise.all([
  checkWakeLockDenialDoesNotStopStartup(),
  checkLiveRecoverySignalsDoNotReplaceSocket(),
  checkOnlineAcceleratesRetryWait(),
  checkGenerationScopedErrorRecovery(),
  checkActiveCloseRecovery(),
  checkRetryReusesLiveMedia(),
  checkClosedContextRebuildsGraph(),
  checkGestureRecoveryAfterMediaFailure(),
  checkVisibilityAndStopWakeLockHandling(),
  checkDeferredMediaCannotSurviveStop(),
  checkDeferredMediaFailureCannotSurviveStop(),
  checkDeferredResumeCannotSurviveStop(),
  checkVisibilityDoesNotSupersedeConnectingRecovery(),
])
  .then(() => console.log('browser recovery integration checks passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
