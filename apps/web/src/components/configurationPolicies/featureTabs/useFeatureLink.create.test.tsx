import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import '@/lib/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFeatureLink } from './useFeatureLink';
import { PolicyCreateContext, type PolicyCreateApi } from './policyCreateContext';
import { fetchWithAuth } from '../../../stores/auth';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const NEW_ID = '10000000-0000-4000-8000-0000000000aa';
const payload = { featureType: 'patch' as const, inlineSettings: { sources: ['os'] } };

function wrapperWith(api: PolicyCreateApi) {
  return ({ children }: { children: ReactNode }) => (
    <PolicyCreateContext.Provider value={api}>{children}</PolicyCreateContext.Provider>
  );
}

beforeEach(() => {
  vi.mocked(fetchWithAuth).mockReset();
});

describe('a feature save on a policy that does not exist yet (W03d C1)', () => {
  it('creates the policy through the page first, then saves the feature on the new id', async () => {
    const calls: string[] = [];
    const api: PolicyCreateApi = {
      ensurePolicy: vi.fn(async () => {
        calls.push('create');
        return { ok: true as const, id: NEW_ID, created: true };
      }),
      reportFirstFeatureSave: vi.fn(),
    };
    vi.mocked(fetchWithAuth).mockImplementation(async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ id: 'link-1', ...payload }), { status: 201 });
    });
    const { result } = renderHook(() => useFeatureLink(''), { wrapper: wrapperWith(api) });
    let saved: unknown;
    await act(async () => {
      saved = await result.current.save(null, payload);
    });
    expect(saved).toEqual(expect.objectContaining({ id: 'link-1' }));
    expect(calls).toEqual(['create', `/configuration-policies/${NEW_ID}/features`]);
    expect(api.reportFirstFeatureSave).toHaveBeenCalledWith({ featureType: 'patch', ok: true });
  });

  it('sends no feature request when the page cannot create the policy, and shows why', async () => {
    const api: PolicyCreateApi = {
      ensurePolicy: vi.fn(async () => ({ ok: false as const, message: 'Name the policy first.' })),
      reportFirstFeatureSave: vi.fn(),
    };
    const { result } = renderHook(() => useFeatureLink(''), { wrapper: wrapperWith(api) });
    await act(async () => {
      expect(await result.current.save(null, payload)).toBeNull();
    });
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(result.current.error).toBe('Name the policy first.');
    expect(api.reportFirstFeatureSave).not.toHaveBeenCalled();
  });

  it('reports a feature save that failed after the create, so the page can say the policy is inactive', async () => {
    const api: PolicyCreateApi = {
      ensurePolicy: vi.fn(async () => ({ ok: true as const, id: NEW_ID, created: true })),
      reportFirstFeatureSave: vi.fn(),
    };
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ error: 'Invalid settings' }), { status: 400 }));
    const { result } = renderHook(() => useFeatureLink(''), { wrapper: wrapperWith(api) });
    await act(async () => {
      expect(await result.current.save(null, payload)).toBeNull();
    });
    expect(api.reportFirstFeatureSave).toHaveBeenCalledWith({ featureType: 'patch', ok: false });
  });

  it('a save on an existing policy never asks the page to create one', async () => {
    const api: PolicyCreateApi = { ensurePolicy: vi.fn(), reportFirstFeatureSave: vi.fn() };
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ id: 'link-1' }), { status: 201 }));
    const { result } = renderHook(() => useFeatureLink('pol-1'), { wrapper: wrapperWith(api) });
    await act(async () => {
      await result.current.save(null, payload);
    });
    expect(api.ensurePolicy).not.toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenCalledWith('/configuration-policies/pol-1/features', expect.anything());
  });

  it('without a policy id or a create provider, nothing is sent to a malformed URL', async () => {
    const { result } = renderHook(() => useFeatureLink(''));
    await act(async () => {
      expect(await result.current.save(null, payload)).toBeNull();
      expect(await result.current.remove('link-1')).toBe(false);
    });
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
