import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('../stores/auth', () => ({ fetchWithAuth: h.fetchWithAuth }));

import { useWispServerState } from './wispVisibility';

const res = (ok: boolean, body: unknown) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;

describe('useWispServerState (W08 #9921)', () => {
  beforeEach(() => h.fetchWithAuth.mockReset());

  it('loading → on/off from wispEnabled; a failed read is off', async () => {
    h.fetchWithAuth.mockResolvedValueOnce(res(true, { wispEnabled: true }));
    const on = renderHook(() => useWispServerState());
    expect(on.result.current).toBe('loading');
    await waitFor(() => expect(on.result.current).toBe('on'));
    h.fetchWithAuth.mockResolvedValueOnce(res(false, {}));
    const off = renderHook(() => useWispServerState());
    await waitFor(() => expect(off.result.current).toBe('off'));
  });

  it('enabled: false asks nothing and reads off; enabling starts at loading, never a stale off', async () => {
    h.fetchWithAuth.mockResolvedValue(res(true, { wispEnabled: true }));
    const hook = renderHook(({ enabled }) => useWispServerState({ enabled }), { initialProps: { enabled: false } });
    expect(hook.result.current).toBe('off');
    expect(h.fetchWithAuth).not.toHaveBeenCalled();
    hook.rerender({ enabled: true });
    expect(hook.result.current).toBe('loading');
    await waitFor(() => expect(hook.result.current).toBe('on'));
    expect(h.fetchWithAuth).toHaveBeenCalledTimes(1);
  });
});
