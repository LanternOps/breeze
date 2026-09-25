// useFeatureLink.test.ts
import { act, renderHook } from '@testing-library/react';
import '@/lib/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFeatureLink } from './useFeatureLink';
import { fetchWithAuth } from '../../../stores/auth';
import { showToast } from '../../shared/Toast';
import { navigateTo } from '@/lib/navigation';
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const POLICY = '10000000-0000-4000-8000-000000000009';
const LINK = '30000000-0000-4000-8000-000000000001';
const payload = { featureType: 'monitors' as const, featurePolicyId: null,
  inlineSettings: { items: [{ monitorId: '20000000-0000-4000-8000-000000000001', enabled: true }] } };

describe('feature Save action feedback', () => {
  it.each([null, LINK])('shows success for Save with existing link %s', async (existingId) => {
    const row = { id: LINK, ...payload };
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify(row), { status: 200 }));
    const { result } = renderHook(() => useFeatureLink(POLICY));
    await act(async () => { expect(await result.current.save(existingId, payload)).toEqual(row); });
    expect(fetchWithAuth).toHaveBeenCalledWith(existingId
      ? `/configuration-policies/${POLICY}/features/${LINK}` : `/configuration-policies/${POLICY}/features`,
    expect.objectContaining({ method: existingId ? 'PATCH' : 'POST' }));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
  it.each([200, 403])('surfaces a failed body at HTTP %s and retains inline error', async (status) => {
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ success: false, error: 'Denied' }), { status }));
    const { result } = renderHook(() => useFeatureLink(POLICY));
    await act(async () => { expect(await result.current.save(LINK, payload)).toBeNull(); });
    expect(result.current.error).toBeTruthy();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
  it('redirects on 401 without an extra toast', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response('{}', { status: 401 }));
    const { result } = renderHook(() => useFeatureLink(POLICY));
    await act(async () => { expect(await result.current.save(LINK, payload)).toBeNull(); });
    expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true });
    expect(showToast).not.toHaveBeenCalled();
  });
});

// #6644 review finding 4: the hook is shared by every feature tab.
describe('shared hook stays feature-neutral', () => {
  beforeEach(() => vi.clearAllMocks());
  it('falls back to a neutral error, never the monitor-specific "Failed to save monitor"', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () => new Response(JSON.stringify({}), { status: 500 }));
    const { result } = renderHook(() => useFeatureLink(POLICY));
    await act(async () => { await result.current.save(LINK, { ...payload, featureType: 'patch' as never }); });
    await act(async () => { await result.current.remove(LINK); });
    const messages = vi.mocked(showToast).mock.calls.map(([toast]) => toast.message);
    expect(messages).toHaveLength(2);
    for (const message of messages) expect(message).not.toMatch(/monitor/i);
  });
  it('toasts success on remove by default; successMessage overrides and null silences', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () => new Response(null, { status: 204 }));
    const { result } = renderHook(() => useFeatureLink(POLICY));
    await act(async () => { expect(await result.current.remove(LINK, { successMessage: null })).toBe(true); });
    expect(showToast).not.toHaveBeenCalled();
    await act(async () => { expect(await result.current.remove(LINK)).toBe(true); });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    vi.mocked(showToast).mockClear();
    await act(async () => { expect(await result.current.remove(LINK, { successMessage: 'Removed' })).toBe(true); });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Removed' }));
  });
  it.each([200, 403])('remove surfaces failed body at HTTP %s', async (status) => {
    vi.clearAllMocks();
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ success: false, error: 'Denied' }), { status }));
    const { result } = renderHook(() => useFeatureLink(POLICY));
    await act(async () => { expect(await result.current.remove(LINK)).toBe(false); });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
  it('remove redirects on 401 without an extra toast', async () => {
    vi.clearAllMocks();
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response('{}', { status: 401 }));
    const { result } = renderHook(() => useFeatureLink(POLICY));
    await act(async () => { expect(await result.current.remove(LINK)).toBe(false); });
    expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true });
    expect(showToast).not.toHaveBeenCalled();
  });
});
