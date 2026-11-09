import '@/lib/i18n';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePolicyView } from '../../portalAccess/viewFixture';
import { registerSsoOnlyConfirmHost, useSsoOnlyConfirmRequests } from '../../portalAccess/ssoOnlyConfirmRequests';
import { showToast } from '../../../shared/Toast';
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

describe('portal access policy save unit — validity', () => {
  it('an invalid session length the form reported makes the tab invalid', () => {
    const { result } = renderHook(() => usePortalAccessPolicyUnit());
    expect(result.current.validity().customerPortal?.isValid).toBe(true);
    act(() => store().setDraft<PortalAccessPolicyUnitValue>('portalAccessPolicy', v => ({ ...v, hoursInvalid: true })));
    expect(result.current.validity().customerPortal).toEqual({
      isValid: false, invalidCount: 1, firstInvalidFieldId: 'portal-access-policy-session-hours',
    });
  });
});

// ── W4 (#11381) D12: the partner save goes through the sso_only confirmation ──
describe('portal access policy save unit — sso_only confirmation', () => {
  const ORG_A = '11111111-1111-4111-8111-111111111111';
  const ORG_B = '33333333-3333-4333-8333-333333333333';
  const confirmRequired = (digest: string) => json(409, {
    error: 'confirm', code: 'PORTAL_ACCESS_POLICY_SSO_ONLY_CONFIRM_REQUIRED',
    impact: {
      impactDigest: digest,
      flips: [
        { orgId: ORG_A, orgName: 'Acme', passwordsToClear: 3, strandedTotal: 2 },
        { orgId: ORG_B, orgName: 'Globex', passwordsToClear: 0, strandedTotal: 5 },
      ],
    },
  });
  let unregister: () => void = () => {};
  beforeEach(() => { unregister = registerSsoOnlyConfirmHost(); });
  afterEach(() => { unregister(); useSsoOnlyConfirmRequests.getState().respond(false); });

  const pending = () => useSsoOnlyConfirmRequests.getState().pending;

  it('partner save lists affected orgs and saves with the acknowledged digest', async () => {
    const saved = makePolicyView({ kind: 'partner', values: { passwordMode: 'sso_only' } });
    fetchWithAuth.mockResolvedValueOnce(confirmRequired('d1')).mockResolvedValueOnce(json(200, { data: saved }));
    store().setDraft<PortalAccessPolicyUnitValue>('portalAccessPolicy', v => ({ ...v, draft: { passwordMode: 'sso_only' } }));
    const { result } = renderHook(() => usePortalAccessPolicyUnit());
    const outcome = result.current.save();
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    expect(pending()!.impact.flips.map((f) => f.orgName)).toEqual(['Acme', 'Globex']);
    expect(pending()!.changed).toBe(false);
    act(() => useSsoOnlyConfirmRequests.getState().respond(true));
    expect((await outcome).status).toBe('saved');
    const [url, init] = fetchWithAuth.mock.calls[2];
    expect(url).toBe('/orgs/partners/me/portal-access-policy?acknowledge=d1');
    expect(init.method).toBe('PATCH');
    expect(slice().baseline).toEqual({ view: saved, draft: {} });
  });

  it('declining is a cancelled outcome: nothing re-sent, draft kept, no error toast', async () => {
    fetchWithAuth.mockResolvedValueOnce(confirmRequired('d1'));
    store().setDraft<PortalAccessPolicyUnitValue>('portalAccessPolicy', v => ({ ...v, draft: { passwordMode: 'sso_only' } }));
    const { result } = renderHook(() => usePortalAccessPolicyUnit());
    const outcome = result.current.save();
    await vi.waitFor(() => expect(pending()).not.toBeNull());
    act(() => useSsoOnlyConfirmRequests.getState().respond(false));
    expect(await outcome).toEqual({ status: 'cancelled' });
    expect(fetchWithAuth).toHaveBeenCalledTimes(2); // load + the refused PATCH
    expect(slice().draft?.draft).toEqual({ passwordMode: 'sso_only' });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a fresh 409 after confirming asks again, marked as changed', async () => {
    const saved = makePolicyView({ kind: 'partner', values: { passwordMode: 'sso_only' } });
    fetchWithAuth
      .mockResolvedValueOnce(confirmRequired('d1'))
      .mockResolvedValueOnce(confirmRequired('d2'))
      .mockResolvedValueOnce(json(200, { data: saved }));
    store().setDraft<PortalAccessPolicyUnitValue>('portalAccessPolicy', v => ({ ...v, draft: { passwordMode: 'sso_only' } }));
    const { result } = renderHook(() => usePortalAccessPolicyUnit());
    const outcome = result.current.save();
    await vi.waitFor(() => expect(pending()?.impact.impactDigest).toBe('d1'));
    act(() => useSsoOnlyConfirmRequests.getState().respond(true));
    await vi.waitFor(() => expect(pending()?.impact.impactDigest).toBe('d2'));
    expect(pending()!.changed).toBe(true);
    act(() => useSsoOnlyConfirmRequests.getState().respond(true));
    expect((await outcome).status).toBe('saved');
    expect(fetchWithAuth.mock.calls[3][0]).toBe('/orgs/partners/me/portal-access-policy?acknowledge=d2');
  });

  it('with no dialog host mounted the confirmation is declined, never left hanging', async () => {
    unregister();
    fetchWithAuth.mockResolvedValueOnce(confirmRequired('d1'));
    store().setDraft<PortalAccessPolicyUnitValue>('portalAccessPolicy', v => ({ ...v, draft: { passwordMode: 'sso_only' } }));
    const { result } = renderHook(() => usePortalAccessPolicyUnit());
    expect(await result.current.save()).toEqual({ status: 'cancelled' });
  });
});
