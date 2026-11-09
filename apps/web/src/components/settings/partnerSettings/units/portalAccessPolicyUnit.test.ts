import '@/lib/i18n';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makePolicyView } from '../../portalAccess/viewFixture';
import { usePartnerSettingsDraftStore } from '../partnerSettingsDraftStore';
import {
  loadPortalAccessPolicy,
  usePortalAccessPolicyUnit,
  type PortalAccessPolicyUnitValue,
} from './portalAccessPolicyUnit';

const fetchWithAuth = vi.fn();
vi.mock('@/stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a), handleSessionExpired: vi.fn() }));
vi.mock('../../../shared/Toast', () => ({ showToast: vi.fn() }));

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;
const store = () => usePartnerSettingsDraftStore.getState();
const slice = () => store().slices.portalAccessPolicy as { draft: PortalAccessPolicyUnitValue | null; baseline: PortalAccessPolicyUnitValue | null };
const view = makePolicyView({ kind: 'partner' });

beforeEach(async () => {
  vi.clearAllMocks();
  store().reset();
  store().setPartner('p1');
  fetchWithAuth.mockResolvedValueOnce(json(200, { data: view }));
  await store().ensureLoaded('portalAccessPolicy', loadPortalAccessPolicy);
});

describe('portal access policy save unit', () => {
  it('loads the partner view with an empty draft; clean until edited', () => {
    expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me/portal-access-policy');
    expect(slice().draft).toEqual({ view, draft: {} });
    const { result } = renderHook(() => usePortalAccessPolicyUnit());
    expect(result.current.isDirty()).toBe(false);
    act(() => store().setDraft<PortalAccessPolicyUnitValue>('portalAccessPolicy', v => ({ ...v, draft: { passwordMode: 'sso_only' } })));
    expect(result.current.isDirty()).toBe(true);
  });

  it('header Save PATCHes the partner policy with only the changed fields and re-baselines', async () => {
    const saved = makePolicyView({ kind: 'partner', values: { selfRegistrationMode: 'approval' } });
    fetchWithAuth.mockResolvedValueOnce(json(200, { data: saved }));
    store().setDraft<PortalAccessPolicyUnitValue>('portalAccessPolicy', v => ({ ...v, draft: { selfRegistrationMode: 'approval' } }));
    const { result } = renderHook(() => usePortalAccessPolicyUnit());
    const outcome = await result.current.save();
    expect(outcome.status).toBe('saved');
    const [url, init] = fetchWithAuth.mock.calls[1];
    expect(url).toBe('/orgs/partners/me/portal-access-policy');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ selfRegistrationMode: 'approval' });
    expect(slice().baseline).toEqual({ view: saved, draft: {} });
    expect(result.current.isDirty()).toBe(false);
  });

  it('a 400 SSO_ONLY_NEEDS_SSO is a failed outcome and keeps the draft', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(400, { error: 'x', code: 'PORTAL_ACCESS_POLICY_SSO_ONLY_NEEDS_SSO', field: 'passwordMode' }));
    store().setDraft<PortalAccessPolicyUnitValue>('portalAccessPolicy', v => ({ ...v, draft: { passwordMode: 'sso_only' } }));
    const { result } = renderHook(() => usePortalAccessPolicyUnit());
    expect(await result.current.save()).toEqual({ status: 'failed' });
    expect(slice().draft?.draft).toEqual({ passwordMode: 'sso_only' });
    expect(result.current.isDirty()).toBe(true);
  });

  it.each([
    ['a 403 from the partner-wide write gate', () => fetchWithAuth.mockResolvedValueOnce(json(403, { error: 'Forbidden', code: 'ACCESS_DENIED' }))],
    ['a network error', () => fetchWithAuth.mockRejectedValueOnce(new TypeError('Failed to fetch'))],
    ['a 200 without a policy view', () => fetchWithAuth.mockResolvedValueOnce(json(200, { data: { owner: null } }))],
  ])('%s is a failed outcome and keeps the draft', async (_label, arrange) => {
    arrange();
    store().setDraft<PortalAccessPolicyUnitValue>('portalAccessPolicy', v => ({ ...v, draft: { selfRegistrationMode: 'approval' } }));
    const { result } = renderHook(() => usePortalAccessPolicyUnit());
    expect(await result.current.save()).toEqual({ status: 'failed' });
    expect(slice().draft?.draft).toEqual({ selfRegistrationMode: 'approval' });
    expect(slice().baseline).toEqual({ view, draft: {} });
    expect(result.current.isDirty()).toBe(true);
  });
});
