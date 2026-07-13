let generation = 0;
let terminalEpoch = 0;
let storageTail: Promise<void> = Promise.resolve();
let sessionTransitionTail: Promise<void> = Promise.resolve();
let cancelActiveTransition: (() => void) | null = null;
const activeRequestControllers = new Set<AbortController>();

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

export function terminateSessionGeneration(): number {
  generation += 1;
  terminalEpoch += 1;
  cancelActiveTransition?.();
  for (const controller of activeRequestControllers) controller.abort();
  return generation;
}

export function registerAuthRequestController(controller: AbortController): () => void {
  activeRequestControllers.add(controller);
  return () => { activeRequestControllers.delete(controller); };
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
 * Serialize a SecureStore mutation and fence both sides of the write against
 * terminal logout/reauthentication. The write itself cannot be cancelled by
 * the native keychain, so the post-write check prevents its caller from
 * continuing into a retry or credential install after the boundary.
 */
export async function runAuthStorageForSessionGeneration<T>(
  candidate: number,
  operation: () => Promise<T>,
): Promise<T> {
  return runAuthStorageExclusive(async () => {
    if (!isCurrentSessionGeneration(candidate)) throw new SessionGenerationStaleError();
    const result = await operation();
    if (!isCurrentSessionGeneration(candidate)) throw new SessionGenerationStaleError();
    return result;
  });
}

/**
 * Serialize the complete native cookie transition and its local credential
 * commit. React Native has one shared cookie jar per app process, so keeping
 * the HTTP response and SecureStore/Redux continuation in one FIFO boundary
 * prevents a late account-A writer from diverging from the cookie's account.
 */
export async function runAuthSessionTransition<T>(operation: () => Promise<T>): Promise<T> {
  const invocationTerminalEpoch = terminalEpoch;
  const previous = sessionTransitionTail;
  let release!: () => void;
  sessionTransitionTail = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => undefined);
  if (invocationTerminalEpoch !== terminalEpoch) {
    release();
    throw new SessionGenerationStaleError();
  }
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new SessionGenerationStaleError());
  });
  cancelActiveTransition = cancel;
  try {
    return await Promise.race([operation(), cancelled]);
  } finally {
    if (cancelActiveTransition === cancel) cancelActiveTransition = null;
    release();
  }
}
