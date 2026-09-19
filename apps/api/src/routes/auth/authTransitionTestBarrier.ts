import { createHash, timingSafeEqual } from 'node:crypto';

const TEST_SECRET_MIN_LENGTH = 32;
const BARRIER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,96}$/;
const BARRIER_TIMEOUT_MS = 30_000;

type Barrier = {
  release: () => void;
  timeout: ReturnType<typeof setTimeout>;
};

const barriers = new Map<string, Barrier>();

function configuredSecret(): string | null {
  const e2eMode = process.env.E2E_MODE === '1' || process.env.E2E_MODE === 'true';
  const secret = process.env.AUTH_TRANSITION_TEST_CONTROL_SECRET;
  if (process.env.NODE_ENV !== 'test' || !e2eMode) return null;
  if (!secret || secret.length < TEST_SECRET_MIN_LENGTH) return null;
  return secret;
}

export function authTransitionTestControlAuthorized(suppliedSecret: string | undefined): boolean {
  const expected = configuredSecret();
  if (!expected || !suppliedSecret) return false;
  const expectedDigest = createHash('sha256').update(expected).digest();
  const suppliedDigest = createHash('sha256').update(suppliedSecret).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

export async function waitForAuthTransitionTestBarrier(
  barrierId: string | undefined,
  suppliedSecret: string | undefined,
): Promise<void> {
  if (!barrierId || !BARRIER_ID_PATTERN.test(barrierId)) return;
  if (!authTransitionTestControlAuthorized(suppliedSecret)) return;

  await new Promise<void>((resolve, reject) => {
    if (barriers.has(barrierId)) {
      reject(new Error('Duplicate auth transition test barrier'));
      return;
    }
    const timeout = setTimeout(() => {
      barriers.delete(barrierId);
      reject(new Error('Auth transition test barrier timed out'));
    }, BARRIER_TIMEOUT_MS);
    barriers.set(barrierId, {
      timeout,
      release: () => {
        clearTimeout(timeout);
        barriers.delete(barrierId);
        resolve();
      },
    });
  });
}

export function authTransitionTestBarrierStatus(
  barrierId: string,
  suppliedSecret: string | undefined,
): 'admitted' | null {
  if (!authTransitionTestControlAuthorized(suppliedSecret)) return null;
  return barriers.has(barrierId) ? 'admitted' : null;
}

export function releaseAuthTransitionTestBarrier(
  barrierId: string,
  suppliedSecret: string | undefined,
): boolean {
  if (!authTransitionTestControlAuthorized(suppliedSecret)) return false;
  const barrier = barriers.get(barrierId);
  if (!barrier) return false;
  barrier.release();
  return true;
}

export const __testOnly = Object.freeze({
  reset: () => {
    for (const barrier of barriers.values()) clearTimeout(barrier.timeout);
    barriers.clear();
  },
});
