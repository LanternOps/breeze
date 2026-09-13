import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showToast = vi.fn();
vi.mock('../components/shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

import { ActionError } from './runAction';
import { runClientAction } from './runClientAction';
import { TRUST_DENIED_EVENT, type TrustDenial } from './trustProbation';

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  showToast.mockReset();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
});

describe('runClientAction', () => {
  it('returns the client value unwrapped and fires runAction’s success toast', async () => {
    const out = await runClientAction(async () => ({ id: 'd-1', name: 'Monthly report' }), {
      errorFallback: 'fb',
      successMessage: 'Deliverable saved',
    });
    expect(out).toEqual({ id: 'd-1', name: 'Monthly report' });
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({ message: 'Deliverable saved', type: 'success' });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('re-materialises an ActionError so the thrown error keeps status 409 and code DUPLICATE_NAME', async () => {
    const body = { error: 'A deliverable with this name already exists', code: 'DUPLICATE_NAME' };
    const thrown = new ActionError(body.error, 409, body.code, body);
    let caught: unknown;
    try {
      await runClientAction(async () => { throw thrown; }, { errorFallback: 'fb' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ActionError);
    const err = caught as ActionError;
    expect(err.status).toBe(409);
    expect(err.code).toBe('DUPLICATE_NAME');
    expect(err.message).toBe(body.error);
    expect(err.body).toEqual(body);
    expect(showToast).toHaveBeenCalledWith({ message: body.error, type: 'error' });
  });

  it('routes a 401 ActionError to runAction’s onUnauthorized without an error toast', async () => {
    const onUnauthorized = vi.fn();
    await expect(
      runClientAction(async () => { throw new ActionError('Unauthorized', 401); }, {
        errorFallback: 'fb',
        onUnauthorized,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('round-trips a 403 trust-denial body so runAction dispatches the trust event', async () => {
    const denial: TrustDenial = {
      error: 'TRUST_PROBATION',
      capability: 'device_execute',
      reason: 'Account under review',
      reviewRequested: true,
      meetingUrl: 'https://example.test/meet',
    };
    const handler = vi.fn((e: Event) => {
      // A mounted TrustProbationBanner owns the UI, so no generic toast.
      e.preventDefault();
    });
    window.addEventListener(TRUST_DENIED_EVENT, handler);
    try {
      let caught: unknown;
      try {
        await runClientAction(async () => { throw new ActionError('denied', 403, undefined, denial); }, {
          errorFallback: 'fb',
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ActionError);
      expect((caught as ActionError).status).toBe(403);
      expect((caught as ActionError).body).toEqual(denial);
      expect(handler).toHaveBeenCalledTimes(1);
      expect((handler.mock.calls[0][0] as CustomEvent<TrustDenial>).detail).toEqual(denial);
      expect(showToast).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(TRUST_DENIED_EVENT, handler);
    }
  });

  it('treats a client that rejected a 2xx (malformed envelope) as a toasted failure, not success', async () => {
    const thrown = new ActionError('Unexpected response shape (200): missing data envelope', 200);
    let caught: unknown;
    try {
      await runClientAction(async () => { throw thrown; }, { errorFallback: 'fb', successMessage: 'Saved' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ActionError);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({ message: thrown.message, type: 'error' });
  });

  it('logs and rethrows a non-ActionError through runAction’s fallback toast', async () => {
    const boom = new SyntaxError('Unexpected token < in JSON');
    let caught: unknown;
    try {
      await runClientAction(async () => { throw boom; }, { errorFallback: 'Could not save' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ActionError);
    expect((caught as ActionError).status).toBe(0);
    expect((caught as ActionError).message).toBe('Could not save');
    expect(errSpy).toHaveBeenCalledWith('[runClientAction]', boom);
    expect(showToast).toHaveBeenCalledWith({ message: 'Could not save', type: 'error' });
  });
});
