type SessionTeardown = () => void;

const teardownCallbacks = new Set<SessionTeardown>();
let sessionGeneration = 0;

export function captureWebSessionGeneration(): number {
  return sessionGeneration;
}

export function isCurrentWebSessionGeneration(generation: number): boolean {
  return generation === sessionGeneration;
}

export function advanceWebSessionGeneration(): number {
  sessionGeneration += 1;
  return sessionGeneration;
}

export class StaleWebSessionError extends Error {
  constructor() {
    super('This operation belongs to an expired web session.');
    this.name = 'StaleWebSessionError';
  }
}

export async function awaitForWebSession<T>(generation: number, promise: Promise<T>): Promise<T> {
  const result = await promise;
  if (!isCurrentWebSessionGeneration(generation)) throw new StaleWebSessionError();
  return result;
}

export function registerSessionTeardown(callback: SessionTeardown): () => void {
  teardownCallbacks.add(callback);
  return () => teardownCallbacks.delete(callback);
}

export function runSessionTeardown(): void {
  advanceWebSessionGeneration();
  for (const callback of teardownCallbacks) {
    try {
      callback();
    } catch {
      // Terminal teardown is best-effort per layer. One broken consumer must
      // not preserve another consumer's state across accounts.
    }
  }
}
