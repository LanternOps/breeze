// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...(a as [])) }));

import { resetEmailConfiguredCache, useEmailConfigured } from './useEmailConfigured';

const res = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;

describe('useEmailConfigured (#9256)', () => {
  beforeEach(() => { vi.clearAllMocks(); resetEmailConfiguredCache(); });

  it('returns the server flag', async () => {
    fetchWithAuth.mockResolvedValue(res({ emailConfigured: false }));
    const { result } = renderHook(() => useEmailConfigured());
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('stays undefined when an older API omits the field (never coerced to false)', async () => {
    fetchWithAuth.mockResolvedValue(res({ id: 'p' }));
    const { result } = renderHook(() => useEmailConfigured());
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toBeUndefined();
  });

  it.each([
    ['non-ok response', () => fetchWithAuth.mockResolvedValue(res({}, false))],
    ['thrown fetch', () => fetchWithAuth.mockRejectedValue(new Error('net'))],
    ['bad json', () => fetchWithAuth.mockResolvedValue({ ok: true, json: async () => { throw new Error('x'); } })],
  ])('stays undefined on %s and is not cached', async (_n, arrange) => {
    arrange();
    const first = renderHook(() => useEmailConfigured());
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(first.result.current).toBeUndefined();
    fetchWithAuth.mockResolvedValue(res({ emailConfigured: true }));
    const second = renderHook(() => useEmailConfigured());
    await waitFor(() => expect(second.result.current).toBe(true));
  });

  it('shares one request across mounts and serves later mounts from cache', async () => {
    fetchWithAuth.mockResolvedValue(res({ emailConfigured: true }));
    const a = renderHook(() => useEmailConfigured());
    const b = renderHook(() => useEmailConfigured());
    await waitFor(() => expect(a.result.current).toBe(true));
    await waitFor(() => expect(b.result.current).toBe(true));
    const c = renderHook(() => useEmailConfigured());
    expect(c.result.current).toBe(true);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });
});
