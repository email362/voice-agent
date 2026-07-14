async function buildServiceHealth({
  hasDeepgramKey,
  rvcServiceUrl,
  timeoutMs = 1500,
  fetchImpl = fetch,
}) {
  const ready = Boolean(hasDeepgramKey);
  const configured = Boolean(rvcServiceUrl);
  const rvc = { configured, serviceUrl: rvcServiceUrl || '', reachable: false, ready: false, error: null };
  if (configured) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${rvcServiceUrl.replace(/\/$/, '')}/health`, { signal: controller.signal });
      rvc.reachable = response.ok;
      if (!response.ok) throw new Error(`RVC health returned HTTP ${response.status}`);
      const body = await response.json();
      rvc.ready = body.ok === true;
      if (!rvc.ready) rvc.error = body.backend?.error || body.model?.error || 'RVC reported unhealthy';
    } catch (error) {
      rvc.error = error.name === 'AbortError' ? `RVC health timed out after ${timeoutMs}ms` : error.message;
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    ok: ready,
    ready,
    degraded: ready && configured && !rvc.ready,
    hasDeepgramKey: ready,
    rvc,
  };
}

module.exports = { buildServiceHealth };
