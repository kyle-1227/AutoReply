// Keep writes ordered; a failed operation must not block the next one.
export function createQueue() {
  let pending = Promise.resolve();
  return job => {
    const next = pending.then(job);
    pending = next.catch(() => {});
    return next;
  };
}

export function waitForDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
