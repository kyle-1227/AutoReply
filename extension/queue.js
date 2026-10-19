// Keep writes ordered; a failed operation must not block the next one.
export function createQueue() {
  let pending = Promise.resolve();
  return job => {
    const next = pending.then(job);
    pending = next.catch(() => {});
    return next;
  };
}
