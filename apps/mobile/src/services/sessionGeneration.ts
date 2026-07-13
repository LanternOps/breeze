let generation = 0;
let storageTail: Promise<void> = Promise.resolve();
let sessionTransitionTail: Promise<void> = Promise.resolve();

export class SessionGenerationStaleError extends Error {
  constructor() {
    super('This operation belongs to an expired session.');
    this.name = 'SessionGenerationStaleError';
  }
}

export function captureSessionGeneration(): number {
  return generation;
}

export function isCurrentSessionGeneration(candidate: number): boolean {
  return candidate === generation;
}

export function advanceSessionGeneration(): number {
  generation += 1;
  return generation;
}

/** Serialize writes and wipes of the shared SecureStore auth keys. */
export async function runAuthStorageExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const previous = storageTail;
  let release!: () => void;
  storageTail = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

/**
 * Serialize the complete native cookie transition and its local credential
 * commit. React Native has one shared cookie jar per app process, so keeping
 * the HTTP response and SecureStore/Redux continuation in one FIFO boundary
 * prevents a late account-A writer from diverging from the cookie's account.
 */
export async function runAuthSessionTransition<T>(operation: () => Promise<T>): Promise<T> {
  const previous = sessionTransitionTail;
  let release!: () => void;
  sessionTransitionTail = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}
