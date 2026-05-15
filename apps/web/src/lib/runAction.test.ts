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

  it('non-JSON body -> fallback message', async () => {
    await expect(runAction({
      request: async () => new Response('<html>', { status: 500 }),
      errorFallback: 'Server error',
    })).rejects.toMatchObject({ message: 'Server error' });
  });

  it('network reject -> fallback toast + ActionError status 0', async () => {
    await expect(runAction({
      request: async () => { throw new Error('network down'); },
      errorFallback: 'Network error',
    })).rejects.toMatchObject({ message: 'Network error', status: 0 });
    expect(showToast).toHaveBeenCalledWith({ message: 'Network error', type: 'error' });
  });
});
