const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

export function retryDelayMs(attemptIndex) {
  const index = Math.max(0, Math.min(Number(attemptIndex) || 0, RETRY_DELAYS_MS.length - 1));
  return RETRY_DELAYS_MS[index];
}

export function createConnectionLifecycle({
  connect,
  schedule = setTimeout,
  cancel = clearTimeout,
  onStateChange = () => {},
}) {
  let desiredRunning = false;
  let state = 'idle';
  let generation = 0;
  let retryAttempt = 0;
  let retryHandle;

  const snapshot = () => ({ desiredRunning, state, generation, retryAttempt, retryPending: retryHandle !== undefined });
  const publish = () => onStateChange(snapshot());
  const clearRetry = () => {
    if (retryHandle === undefined) return;
    cancel(retryHandle);
    retryHandle = undefined;
  };
  const attemptConnection = () => {
    if (!desiredRunning) return;
    clearRetry();
    state = 'connecting';
    generation += 1;
    publish();
    connect(generation);
  };

  return {
    start() {
      if (desiredRunning) return false;
      desiredRunning = true;
      retryAttempt = 0;
      attemptConnection();
      return true;
    },
    markLive(candidateGeneration) {
      if (!desiredRunning || candidateGeneration !== generation) return false;
      clearRetry();
      retryAttempt = 0;
      state = 'live';
      publish();
      return true;
    },
    scheduleRetry(candidateGeneration) {
      if (!desiredRunning || candidateGeneration !== generation || retryHandle !== undefined || state === 'retry-wait') return false;
      const delay = retryDelayMs(retryAttempt);
      retryAttempt += 1;
      state = 'retry-wait';
      retryHandle = schedule(() => {
        retryHandle = undefined;
        attemptConnection();
      }, delay);
      publish();
      return true;
    },
    retryNow() {
      if (!desiredRunning) return false;
      clearRetry();
      attemptConnection();
      return true;
    },
    terminalFailure(candidateGeneration) {
      if (candidateGeneration !== generation) return false;
      desiredRunning = false;
      clearRetry();
      state = 'idle';
      publish();
      return true;
    },
    stop() {
      desiredRunning = false;
      clearRetry();
      generation += 1;
      retryAttempt = 0;
      state = 'idle';
      publish();
    },
    isActiveGeneration(candidateGeneration) {
      return desiredRunning && candidateGeneration === generation;
    },
    snapshot,
  };
}
