const assert = require('node:assert/strict');
const { buildServiceHealth } = require('../service-health');

(async () => {
  const disabled = await buildServiceHealth({ hasDeepgramKey: true, rvcServiceUrl: '', fetchImpl: () => assert.fail('must not fetch') });
  assert.equal(disabled.ready, true);
  assert.equal(disabled.degraded, false);
  assert.equal(disabled.rvc.configured, false);

  const healthy = await buildServiceHealth({
    hasDeepgramKey: true,
    rvcServiceUrl: 'http://127.0.0.1:5055',
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  });
  assert.equal(healthy.rvc.reachable, true);
  assert.equal(healthy.rvc.ready, true);
  assert.equal(healthy.degraded, false);

  const unavailable = await buildServiceHealth({
    hasDeepgramKey: true,
    rvcServiceUrl: 'http://127.0.0.1:5055',
    fetchImpl: async () => { throw new Error('connection refused'); },
  });
  assert.equal(unavailable.ready, true);
  assert.equal(unavailable.degraded, true);
  assert.equal(unavailable.rvc.reachable, false);
  assert.match(unavailable.rvc.error, /connection refused/);

  const unhealthy = await buildServiceHealth({
    hasDeepgramKey: true,
    rvcServiceUrl: 'http://127.0.0.1:5055',
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false }) }),
  });
  assert.equal(unhealthy.rvc.reachable, true);
  assert.equal(unhealthy.rvc.ready, false);
  assert.equal(unhealthy.degraded, true);

  const timedOut = await buildServiceHealth({
    hasDeepgramKey: true,
    rvcServiceUrl: 'http://127.0.0.1:5055',
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }),
  });
  assert.equal(timedOut.degraded, true);
  assert.match(timedOut.rvc.error, /timed out after 5ms/);

  console.log('service health checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
