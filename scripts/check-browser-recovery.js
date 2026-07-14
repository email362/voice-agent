const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const app = fs.readFileSync('public/app.js', 'utf8');
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
    constructor() {
      this.currentTime = 0;
      this.sampleRate = 48000;
      this.destination = {};
    }

    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return { connect() {}, disconnect() {} }; }
    close() {}
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
      querySelector: element,
      createElement: () => ({ className: '', textContent: '', scrollIntoView() {} }),
    },
    location: { protocol: 'http:', host: 'localhost' },
    navigator: {
      mediaDevices: {
        async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; },
      },
    },
    setInterval(callback) { const handle = { callback }; intervals.add(handle); return handle; },
    setTimeout(callback, delay) { const handle = { callback, delay }; scheduledRetries.push(handle); return handle; },
    window: { addEventListener() {} },
  };
  vm.runInNewContext(`${lifecycleSource}\n${executableApp}`, context);
  return { element, FakeWebSocket, scheduledRetries };
}

async function checkGenerationScopedErrorRecovery() {
  const { element, FakeWebSocket, scheduledRetries } = createBrowserHarness();
  await element('#startBtn').dispatch('click');
  const staleSocket = FakeWebSocket.instances[0];
  assert.equal(staleSocket.generation, 1);
  staleSocket.readyState = FakeWebSocket.OPEN;
  staleSocket.deliver('message', { data: JSON.stringify({ type: 'SettingsApplied' }) });
  staleSocket.deliver('error');
  assert.equal(scheduledRetries.length, 1, 'active socket errors should schedule recovery');

  scheduledRetries.shift().callback();
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
  const activeSocket = FakeWebSocket.instances[0];
  assert.equal(activeSocket.generation, 1);
  activeSocket.readyState = FakeWebSocket.OPEN;
  activeSocket.deliver('message', { data: JSON.stringify({ type: 'SettingsApplied' }) });
  activeSocket.deliver('close');
  assert.equal(scheduledRetries.length, 1, 'an active socket close should schedule exactly one recovery');
  activeSocket.deliver('close');
  assert.equal(scheduledRetries.length, 1, 'repeated close delivery should not schedule duplicate recovery');
}

Promise.all([checkGenerationScopedErrorRecovery(), checkActiveCloseRecovery()])
  .then(() => console.log('browser recovery integration checks passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
