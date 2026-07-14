const assert = require('node:assert/strict');
const fs = require('node:fs');

async function loadModule() {
  const source = fs.readFileSync('public/connection-lifecycle.js', 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

(async () => {
  const { createConnectionLifecycle, retryDelayMs } = await loadModule();
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(retryDelayMs), [1000, 2000, 4000, 8000, 15000, 15000]);

  const scheduled = [];
  const cancelled = [];
  const connections = [];
  const sockets = [];
  const states = [];
  const lifecycle = createConnectionLifecycle({
    connect: (generation) => {
      connections.push(generation);
      sockets.push({ generation, close: () => lifecycle.scheduleRetry(generation) });
    },
    schedule: (fn, delay) => {
      const handle = { fn, delay };
      scheduled.push(handle);
      return handle;
    },
    cancel: (handle) => cancelled.push(handle),
    onStateChange: (snapshot) => states.push(snapshot),
  });

  lifecycle.start();
  assert.deepEqual(connections, [1]);
  assert.equal(lifecycle.snapshot().state, 'connecting');
  assert.equal(sockets[0].close(), true);
  assert.equal(scheduled[0].delay, 1000);
  assert.equal(lifecycle.scheduleRetry(1), false, 'duplicate close/error must not schedule twice');
  scheduled.shift().fn();
  assert.deepEqual(connections, [1, 2]);
  assert.equal(sockets[0].close(), false, 'stale socket close is ignored');
  lifecycle.markLive(2);
  assert.equal(lifecycle.snapshot().retryAttempt, 0);
  lifecycle.scheduleRetry(2);
  assert.equal(scheduled[0].delay, 1000, 'live resets backoff');
  lifecycle.retryNow();
  assert.deepEqual(connections, [1, 2, 3]);
  lifecycle.terminalFailure(3);
  assert.equal(lifecycle.snapshot().desiredRunning, false);
  assert.equal(lifecycle.snapshot().state, 'idle');
  lifecycle.start();
  lifecycle.scheduleRetry(4);
  lifecycle.stop();
  assert.equal(lifecycle.snapshot().desiredRunning, false);
  assert.ok(cancelled.length >= 2, 'immediate retry and stop cancel timers');
  assert.equal(states.at(-1).state, 'idle');

  console.log('connection lifecycle checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
