import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import {
  createSeries,
  fetchSeriesList,
  fetchSeriesOwnerCandidates,
  previewSeriesRecipients,
  replaceSeriesTargets,
  seriesFriendlyError,
  setChildRecipientOverride,
  transferSeriesOwner,
} from './seriesApi';

const json = (payload: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(payload) });

describe('seriesApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists series cross-org and treats 403 as "not available"', async () => {
    fetchWithAuth.mockReturnValueOnce(json({ data: [{ series: { id: 's-1' }, targets: [], orgs: [] }] }));
    expect(await fetchSeriesList()).toHaveLength(1);
    expect(fetchWithAuth).toHaveBeenLastCalledWith('/reports/series', { skipOrgIdInjection: true });
    fetchWithAuth.mockReturnValueOnce(json({ error: 'forbidden' }, 403));
    expect(await fetchSeriesList()).toBeNull();
  });

  it('creates through runAction with a success toast and returns the detail', async () => {
    fetchWithAuth.mockReturnValueOnce(json({ series: { id: 's-9' }, targets: [], orgs: [] }, 201));
    const detail = await createSeries(
      { name: 'N', type: 'device_inventory', format: 'pdf', schedule: 'monthly', config: {}, targetMode: 'all', orgIds: [], recipientRule: { primaryContact: true, roles: [] }, internalCc: [] },
      { errorFallback: 'fail', successMessage: 'ok' },
    );
    expect(detail.series.id).toBe('s-9');
    const [url, init] = fetchWithAuth.mock.calls[0]!;
    expect(url).toBe('/reports/series');
    expect(init).toMatchObject({ method: 'POST', skipOrgIdInjection: true });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'ok' }));
  });

  it('maps series error tokens to friendly copy', async () => {
    fetchWithAuth.mockReturnValueOnce(json({ error: 'series_config_org_specific' }, 400));
    await expect(createSeries(
      { name: 'N', type: 'device_inventory', format: 'pdf', schedule: 'monthly', config: {}, targetMode: 'all', orgIds: [], recipientRule: { primaryContact: true, roles: [] }, internalCc: [] },
      { errorFallback: 'fail' },
    )).rejects.toMatchObject({ status: 400 });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: seriesFriendlyError('series_config_org_specific'),
    }));
    expect(seriesFriendlyError('unrelated_code')).toBeUndefined();
    // W02 maps a transient owner-authority lookup failure to 503 series_authority_unverifiable.
    expect(seriesFriendlyError('series_authority_unverifiable')).toBeTruthy();
  });

  it('explains a targets write that names a hidden organization (series_target_org_hidden)', async () => {
    fetchWithAuth.mockReturnValueOnce(json({ error: 'series_target_org_hidden', orgIds: ['org-qs'] }, 400));
    await expect(replaceSeriesTargets('s-1', { targetMode: 'selected', orgIds: ['org-qs'] }, { errorFallback: 'fail' }))
      .rejects.toMatchObject({ status: 400 });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: "Quick Support and the unassigned-devices holding organization can't be covered by a multi-org report.",
    }));
  });

  // Pre-release sweep: the server says WHY an owner is refused
  // (resolveLivePartnerReportAuthority reasons); the toast must say the same.
  it.each([
    ['permission_removed', "That user can't own a multi-org report: their role doesn't grant the Reports export permission (reports:export)."],
    ['partner_access_not_all', "That user can't own a multi-org report: they need access to every organization."],
    ['user_inactive', "That user's account isn't active, so they can't own a multi-org report."],
    ['membership_removed', "That user is no longer a member of your partner, so they can't own a multi-org report."],
    ['owner_not_partner_user', "That user doesn't belong to your partner, so they can't own a multi-org report."],
    ['partner_inaccessible', "That user doesn't belong to your partner, so they can't own a multi-org report."],
    ['tenant_inactive', "Your partner account isn't active, so a multi-org report can't get a new owner."],
    ['some_future_reason', "That user can't own a multi-org report."],
    [undefined, "That user can't own a multi-org report."],
  ])('transfer-owner refusal with reason %s names that reason', async (reason, message) => {
    fetchWithAuth.mockReturnValueOnce(json({ error: 'series_owner_ineligible', ...(reason ? { reason } : {}) }, 400));
    await expect(transferSeriesOwner('s-1', 'u-2', { errorFallback: 'fail' })).rejects.toMatchObject({ status: 400 });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message }));
  });

  it('previews without a toast and throws on failure', async () => {
    fetchWithAuth.mockReturnValueOnce(json({ totalCustomerRecipients: 3, orgCount: 2, orgsWithoutCustomerRecipient: [] }));
    const body = { targetMode: 'all' as const, orgIds: [], recipientRule: { primaryContact: true, roles: [] }, internalCc: ['ops@msp.example'] };
    expect((await previewSeriesRecipients(body)).totalCustomerRecipients).toBe(3);
    expect(fetchWithAuth).toHaveBeenLastCalledWith('/reports/series/recipients/preview', expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }));
    fetchWithAuth.mockReturnValueOnce(json({}, 500));
    await expect(previewSeriesRecipients(body)).rejects.toThrow();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('switches an add override to remove with one upserting POST (W02 upserts mode on series children)', async () => {
    fetchWithAuth.mockReturnValue(json({}));
    await setChildRecipientOverride('rep-1', 'c-1', 'add', 'remove', { errorFallback: 'fail', successMessage: 'ok' });
    expect(fetchWithAuth.mock.calls.map(([u, i]) => [u, (i as { method?: string }).method])).toEqual([
      ['/reports/rep-1/recipients', 'POST'],
    ]);
    expect(JSON.parse((fetchWithAuth.mock.calls[0]![1] as { body: string }).body)).toEqual({ contactId: 'c-1', mode: 'remove' });
  });

  it('returns to the rule with a single DELETE', async () => {
    fetchWithAuth.mockReturnValue(json({}));
    await setChildRecipientOverride('rep-1', 'c-1', 'remove', 'default', { errorFallback: 'fail' });
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(fetchWithAuth.mock.calls[0]![1]).toMatchObject({ method: 'DELETE' });
  });

  it('offers only active users with access to every organization as owners', async () => {
    fetchWithAuth.mockReturnValueOnce(json({ data: [
      { id: 'u-1', name: 'Ada', email: 'ada@x.io', status: 'active', orgAccess: 'all' },
      { id: 'u-2', name: 'Bo', email: 'bo@x.io', status: 'active', orgAccess: 'selected' },
      { id: 'u-3', name: 'Cy', email: 'cy@x.io', status: 'disabled', orgAccess: 'all' },
    ] }));
    expect(await fetchSeriesOwnerCandidates()).toEqual([{ id: 'u-1', name: 'Ada', email: 'ada@x.io' }]);
    fetchWithAuth.mockReturnValueOnce(json({}, 403));
    expect(await fetchSeriesOwnerCandidates()).toBe('forbidden');
  });
});
