import { describe, it, expect, vi, beforeEach } from 'vitest';

const showToast = vi.fn();
vi.mock('../components/shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

import { runAction, ActionError } from './runAction';

function res(body: unknown, status = 200): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => showToast.mockReset());

describe('runAction', () => {
  it('returns parsed data and toasts success when successMessage given', async () => {
    const out = await runAction<{ id: string }>({
      request: async () => res({ id: 'x' }),
      successMessage: 'Done',
      errorFallback: 'fb',
    });
    expect(out).toEqual({ id: 'x' });
    expect(showToast).toHaveBeenCalledWith({ message: 'Done', type: 'success' });
  });

  it('no success toast when successMessage omitted', async () => {
    await runAction({ request: async () => res({ ok: 1 }), errorFallback: 'fb' });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('toasts + throws ActionError on !ok with readable message', async () => {
    await expect(runAction({
      request: async () => res({ error: 'boom', code: 'X' }, 422),
      errorFallback: 'fb',
    })).rejects.toBeInstanceOf(ActionError);
    expect(showToast).toHaveBeenCalledWith({ message: 'boom', type: 'error' });
  });

  it('treats 200 + {success:false} as failure', async () => {
    await expect(runAction({
      request: async () => res({ success: false, message: 'nope' }, 200),
      errorFallback: 'fb',
    })).rejects.toMatchObject({ message: 'nope' });
    expect(showToast).toHaveBeenCalledWith({ message: 'nope', type: 'error' });
  });

  it('treats 200 + {testResult:{success:false}} as failure', async () => {
    await expect(runAction({
      request: async () => res({ testResult: { success: false, message: 'bad token' } }, 200),
      errorFallback: 'fb',
    })).rejects.toMatchObject({ message: 'bad token' });
  });

  it('applies friendly(code) when provided', async () => {
    await expect(runAction({
      request: async () => res({ error: 'raw', code: 'NO_MACS' }, 412),
      errorFallback: 'fb',
      friendly: (c) => (c === 'NO_MACS' ? 'No MAC on file' : undefined),
    })).rejects.toMatchObject({ code: 'NO_MACS', message: 'No MAC on file' });
    expect(showToast).toHaveBeenCalledWith({ message: 'No MAC on file', type: 'error' });
  });

  it('calls onUnauthorized and throws on 401', async () => {
    const onUnauthorized = vi.fn();
    await expect(runAction({
      request: async () => res({ error: 'unauth' }, 401),
      errorFallback: 'fb',
      onUnauthorized,
    })).rejects.toBeInstanceOf(ActionError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('non-JSON body -> fallback message and error toast', async () => {
    await expect(runAction({
      request: async () => new Response('<html>', { status: 500 }),
      errorFallback: 'Server error',
    })).rejects.toMatchObject({ message: 'Server error' });
    expect(showToast).toHaveBeenCalledWith({ message: 'Server error', type: 'error' });
  });

  it('network reject -> fallback toast + ActionError status 0', async () => {
    await expect(runAction({
      request: async () => { throw new Error('network down'); },
      errorFallback: 'Network error',
    })).rejects.toMatchObject({ message: 'Network error', status: 0 });
    expect(showToast).toHaveBeenCalledWith({ message: 'Network error', type: 'error' });
  });

  it('successMessage as function receives result and toasts formatted string', async () => {
    const out = await runAction<{ id: string }>({
      request: async () => res({ id: '7' }),
      successMessage: (d) => `Created ${d.id}`,
      errorFallback: 'fb',
    });
    expect(out).toEqual({ id: '7' });
    expect(showToast).toHaveBeenCalledWith({ message: 'Created 7', type: 'success' });
  });

  it('401 is silent (no toast) and calls onUnauthorized', async () => {
    const onUnauthorized = vi.fn();
    await expect(runAction({
      request: async () => res({ error: 'unauth' }, 401),
      errorFallback: 'fb',
      onUnauthorized,
    })).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('parseSuccess throws -> toasted failure with errorFallback', async () => {
    await expect(runAction({
      request: async () => res({ val: 1 }, 200),
      errorFallback: 'Parse failed',
      parseSuccess: () => { throw new Error('bad shape'); },
    })).rejects.toMatchObject({ message: 'Parse failed', status: 200 });
    expect(showToast).toHaveBeenCalledWith({ message: 'Parse failed', type: 'error' });
  });

  it('successMessage function throws -> generic success toast, value returned, error logged', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await runAction<{ ok: number }>({
      request: async () => res({ ok: 1 }),
      successMessage: () => { throw new Error('x'); },
      errorFallback: 'fb',
    });
    expect(out).toEqual({ ok: 1 });
    // The action succeeded — a formatter bug must NOT silence feedback (M1).
    expect(showToast).toHaveBeenCalledWith({ message: 'Done', type: 'success' });
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('toasts exactly once on failure (no double-toast with caller catch pattern)', async () => {
    // Mirrors the documented caller contract: runAction toasts the failure and
    // throws ActionError; the caller's catch must NOT re-toast a non-401
    // ActionError. Asserts runAction itself emits a single toast.
    let caught: unknown;
    try {
      await runAction({
        request: async () => res({ error: 'boom' }, 422),
        errorFallback: 'fb',
      });
    } catch (err) {
      caught = err;
      // Documented caller pattern:
      if (err instanceof ActionError && err.status === 401) { /* redirect */ }
      else if (!(err instanceof ActionError)) showToast({ message: 'extra', type: 'error' });
      // ActionError non-401 -> already toasted by runAction, caller stays silent
    }
    expect(caught).toBeInstanceOf(ActionError);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({ message: 'boom', type: 'error' });
  });
});
