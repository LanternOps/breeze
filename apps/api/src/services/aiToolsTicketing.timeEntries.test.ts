import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({ listTimeEntries: vi.fn(), getRunningTimer: vi.fn(), getTimesheet: vi.fn() }));
vi.mock('./timeEntryService', () => svc);

import { aiTools } from './aiToolNames';
import './aiTools';

const partnerAuth = (over: Record<string, unknown> = {}) => ({
  scope: 'partner', partnerId: 'p1', orgId: null, accessibleOrgIds: ['o1', 'o2'],
  canAccessOrg: (id: string) => ['o1', 'o2'].includes(id),
  user: { id: 'u1', isPlatformAdmin: false }, ...over,
}) as never;

beforeEach(() => { svc.listTimeEntries.mockReset(); svc.getRunningTimer.mockReset(); svc.getTimesheet.mockReset(); });

describe('list_time_entries', () => {
  const tool = aiTools.get('list_time_entries')!;
  it('is registered as a Tier-1 tickets-domain read', () => {
    expect(tool.tier).toBe(1); expect(tool.domain).toBe('tickets'); expect(tool.searchHint.length).toBeLessThanOrEqual(120);
  });
  it('refuses organization-scoped callers exactly like the route (partner/system only)', async () => {
    const out = JSON.parse(await tool.handler({}, partnerAuth({ scope: 'organization', orgId: 'o1' })));
    expect(out).toMatchObject({ error: expect.any(String), code: 'PARTNER_SCOPE_REQUIRED' });
    expect(svc.listTimeEntries).not.toHaveBeenCalled();
  });
  it('denies an orgId outside the accessible set', async () => {
    const out = JSON.parse(await tool.handler({ orgId: 'o9' }, partnerAuth()));
    expect(out.error).toMatch(/organization/i);
    expect(svc.listTimeEntries).not.toHaveBeenCalled();
  });
  it('pins userId to the caller unless the caller manages all, threads accessibleOrgIds (never null for partner), clamps limit', async () => {
    svc.listTimeEntries.mockResolvedValue({ entries: [{ id: 'e1', durationMinutes: 30 }], total: 1 });
    const out = JSON.parse(await tool.handler({ userId: 'someone-else', limit: 999, running: true }, partnerAuth()));
    expect(svc.listTimeEntries).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', accessibleOrgIds: ['o1', 'o2'], limit: 200, offset: 0, running: true }));
    expect(out).toEqual({ entries: [{ id: 'e1', durationMinutes: 30 }], total: 1, limit: 200, offset: 0 });
  });
  it('lets a platform admin filter by another user, and system scope passes null accessibleOrgIds', async () => {
    svc.listTimeEntries.mockResolvedValue({ entries: [], total: 0 });
    await tool.handler({ userId: 'u2' }, partnerAuth({ scope: 'system', user: { id: 'u1', isPlatformAdmin: true } }));
    expect(svc.listTimeEntries).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u2', accessibleOrgIds: null }));
  });
});

describe('get_running_timer', () => {
  const tool = aiTools.get('get_running_timer')!;
  it('returns the caller\'s running entry or null', async () => {
    svc.getRunningTimer.mockResolvedValue({ id: 'e1', startedAt: '2026-09-17T10:00:00Z' });
    expect(JSON.parse(await tool.handler({}, partnerAuth()))).toEqual({ running: { id: 'e1', startedAt: '2026-09-17T10:00:00Z' } });
    expect(svc.getRunningTimer).toHaveBeenCalledWith('u1');
  });
  it('needs a user principal', async () => {
    expect(JSON.parse(await tool.handler({}, partnerAuth({ user: undefined }))).error).toMatch(/user/i);
  });
});

describe('get_timesheet', () => {
  const tool = aiTools.get('get_timesheet')!;
  it('rejects another user\'s timesheet for a non-admin, exactly like the route', async () => {
    expect(JSON.parse(await tool.handler({ weekStart: '2026-09-14', userId: 'u2' }, partnerAuth())).error).toMatch(/admin/i);
    expect(svc.getTimesheet).not.toHaveBeenCalled();
  });
  it('returns the timesheet for a valid week', async () => {
    svc.getTimesheet.mockResolvedValue({ weekStart: '2026-09-14', days: [], totals: { totalMinutes: 0, billableMinutes: 0, billableAmounts: [] } });
    const out = JSON.parse(await tool.handler({ weekStart: '2026-09-14' }, partnerAuth()));
    expect(svc.getTimesheet).toHaveBeenCalledWith('u1', new Date('2026-09-14'), ['o1', 'o2']);
    expect(out.timesheet.totals.totalMinutes).toBe(0);
  });
  it('rejects an unparseable weekStart', async () => {
    expect(JSON.parse(await tool.handler({ weekStart: 'next monday' }, partnerAuth())).error).toMatch(/weekStart/);
  });
});

describe('time read authorization boundaries', () => {
  it.each(['get_running_timer', 'get_timesheet'])('%s refuses organization scope', async (name) => {
    const out = JSON.parse(await aiTools.get(name)!.handler({ weekStart: '2026-09-14' }, partnerAuth({ scope: 'organization' })));
    expect(out.code).toBe('PARTNER_SCOPE_REQUIRED');
    expect(svc.getRunningTimer).not.toHaveBeenCalled();
    expect(svc.getTimesheet).not.toHaveBeenCalled();
  });
  it('requires a user for listing entries', async () => {
    const out = JSON.parse(await aiTools.get('list_time_entries')!.handler({}, partnerAuth({ user: undefined })));
    expect(out.error).toMatch(/user/i);
    expect(svc.listTimeEntries).not.toHaveBeenCalled();
  });
  it.each([null, undefined, []])('fails closed for partner org allowlist %s', async (accessibleOrgIds) => {
    svc.listTimeEntries.mockResolvedValue({ entries: [], total: 0 });
    svc.getTimesheet.mockResolvedValue({ days: [] });
    const auth = partnerAuth({ accessibleOrgIds });
    await aiTools.get('list_time_entries')!.handler({}, auth);
    await aiTools.get('get_timesheet')!.handler({ weekStart: '2026-09-14' }, auth);
    expect(svc.listTimeEntries).toHaveBeenCalledWith(expect.objectContaining({ accessibleOrgIds: [] }));
    expect(svc.getTimesheet).toHaveBeenCalledWith('u1', expect.any(Date), []);
  });
  it('does not treat system scope alone as a manage-all grant', async () => {
    svc.listTimeEntries.mockResolvedValue({ entries: [], total: 0 });
    await aiTools.get('list_time_entries')!.handler({ userId: 'u2' }, partnerAuth({ scope: 'system' }));
    expect(svc.listTimeEntries).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', accessibleOrgIds: null }));
    const out = JSON.parse(await aiTools.get('get_timesheet')!.handler({ weekStart: '2026-09-14', userId: 'u2' }, partnerAuth({ scope: 'system' })));
    expect(out.error).toMatch(/admin/i);
    expect(svc.getTimesheet).not.toHaveBeenCalled();
  });
  it('returns null when no timer is running', async () => {
    svc.getRunningTimer.mockResolvedValue(undefined);
    expect(JSON.parse(await aiTools.get('get_running_timer')!.handler({}, partnerAuth()))).toEqual({ running: null });
  });
});
