import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
}));
vi.mock('../../services/authBrowserTransition', () => ({ resolveAuthBinding: vi.fn() }));
vi.mock('./binding', () => ({ requestAuthBinding: vi.fn() }));
vi.mock('../../db/schema/authBrowserTransitions', () => ({
  authBrowserTransitions: {
    id: 'id', generation: 'generation', state: 'state', bindingDigest: 'bindingDigest',
  },
}));
import {
  __testOnly,
  authTransitionTestBarrierStatus,
  releaseAuthTransitionTestBarrier,
  waitForAuthTransitionTestBarrier,
} from './authTransitionTestBarrier';
import {
  AUTH_TRANSITION_TEST_SECRET_HEADER,
  authTransitionTestControlRoutes,
} from './authTransitionTestControl';

const secret = 'browser-contract-test-secret-32-chars-minimum';

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.E2E_MODE = 'true';
  process.env.AUTH_TRANSITION_TEST_CONTROL_SECRET = secret;
  __testOnly.reset();
});

afterEach(() => {
  __testOnly.reset();
  delete process.env.AUTH_TRANSITION_TEST_CONTROL_SECRET;
});

describe('auth transition test-only finalization barrier', () => {
  it('announces admission, blocks outside DB work, and releases deterministically', async () => {
    let settled = false;
    const waiting = waitForAuthTransitionTestBarrier('issuer-a', secret)
      .then(() => { settled = true; });

    expect(authTransitionTestBarrierStatus('issuer-a', secret)).toBe('admitted');
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(releaseAuthTransitionTestBarrier('issuer-a', secret)).toBe(true);
    await waiting;
    expect(settled).toBe(true);
  });

  it('is inert without the exact test runtime and configured secret', async () => {
    process.env.NODE_ENV = 'production';

    await expect(waitForAuthTransitionTestBarrier('issuer-prod', secret)).resolves.toBeUndefined();
    expect(authTransitionTestBarrierStatus('issuer-prod', secret)).toBeNull();
    expect(releaseAuthTransitionTestBarrier('issuer-prod', secret)).toBe(false);
  });

  it('is inert for an incorrect secret and never creates observable state', async () => {
    await expect(waitForAuthTransitionTestBarrier('issuer-wrong', 'wrong-secret'))
      .resolves.toBeUndefined();

    expect(authTransitionTestBarrierStatus('issuer-wrong', secret)).toBeNull();
  });

  it('keeps control routes hidden without authorization and releases an admitted barrier', async () => {
    const hidden = await authTransitionTestControlRoutes.request(
      '/__test/auth-transition/barriers/route-a',
    );
    expect(hidden.status).toBe(404);

    const waiting = waitForAuthTransitionTestBarrier('route-a', secret);
    const admitted = await authTransitionTestControlRoutes.request(
      '/__test/auth-transition/barriers/route-a',
      { headers: { [AUTH_TRANSITION_TEST_SECRET_HEADER]: secret } },
    );
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toEqual({ status: 'admitted' });

    const released = await authTransitionTestControlRoutes.request(
      '/__test/auth-transition/barriers/route-a/release',
      { method: 'POST', headers: { [AUTH_TRANSITION_TEST_SECRET_HEADER]: secret } },
    );
    expect(released.status).toBe(204);
    await waiting;
  });
});
