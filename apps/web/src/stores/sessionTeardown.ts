type SessionTeardown = () => void;

const teardownCallbacks = new Set<SessionTeardown>();

export function registerSessionTeardown(callback: SessionTeardown): () => void {
  teardownCallbacks.add(callback);
  return () => teardownCallbacks.delete(callback);
}

export function runSessionTeardown(): void {
  for (const callback of teardownCallbacks) {
    try {
      callback();
    } catch {
      // Terminal teardown is best-effort per layer. One broken consumer must
      // not preserve another consumer's state across accounts.
    }
  }
}
