// useFeatureLink.test.ts
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
