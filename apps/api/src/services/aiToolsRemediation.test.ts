import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('./aiToolsSiteScope', () => ({ resolveSiteAllowedDeviceIds: vi.fn() }));

import { and, desc, eq, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { remediationSuggestions as suggestions } from '../db/schema/remediationSuggestions';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerRemediationTools } from './aiToolsRemediation';
import { resolveSiteAllowedDeviceIds } from './aiToolsSiteScope';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const tools = new Map<string, AiTool>();
registerRemediationTools(tools);
const orgCondition = vi.fn(() => eq(suggestions.orgId, ORG));
const auth = (over = {}) => ({
  scope: 'partner', accessibleOrgIds: [ORG], canAccessOrg: (id: string) => id === ORG,
  orgCondition, ...over,
}) as unknown as AuthContext;
const run = async (input: Record<string, unknown> = {}, over = {}) =>
  JSON.parse(await tools.get('list_remediation_suggestions')!.handler(input, auth(over)));
function query(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain), where: vi.fn((_condition?: SQL) => chain),
    orderBy: vi.fn(() => chain), limit: vi.fn(async () => rows),
  };
  return chain;
}
let page: ReturnType<typeof query>;
const row = { id: OTHER, orgId: ORG, deviceId: DEVICE, title: 'Restart service' };
beforeEach(() => {
  vi.clearAllMocks();
  page = query([row]);
  vi.mocked(db.select).mockImplementation(() => page as never);
  vi.mocked(resolveSiteAllowedDeviceIds).mockResolvedValue(null);
});

describe('list_remediation_suggestions', () => {
  it('registers a Tier-1 monitoring read with deviceArgs', () => {
    expect(tools.get('list_remediation_suggestions')).toMatchObject({ tier: 1, domain: 'monitoring', deviceArgs: ['deviceId'] });
  });
  it.each(['partner', 'organization'])('denies inaccessible explicit organizations for %s', async (scope) => {
    expect((await run({ orgId: OTHER }, { scope, orgId: ORG })).error).toMatch(/organization/i);
    expect(db.select).not.toHaveBeenCalled();
  });
  it.each([null, undefined, []].map((accessibleOrgIds) => [accessibleOrgIds]))('fails closed for partner orgs %j', async (accessibleOrgIds) => {
    expect(await run({}, { accessibleOrgIds })).toEqual({ suggestions: [], showing: 0 });
    expect(db.select).not.toHaveBeenCalled();
  });
  it.each([{ scope: 'invalid' }, { scope: 'organization', orgId: null }])('rejects invalid scope %j', async (over) => {
    expect((await run({}, over)).error).toBeTruthy();
    expect(db.select).not.toHaveBeenCalled();
  });
  it.each([{}, { status: 'all' }])('adds no status predicate for %j', async (input) => {
    expect(await run(input)).toEqual({ suggestions: [row], showing: 1 });
    expect(orgCondition).toHaveBeenCalledWith(suggestions.orgId);
    expect(page.where).toHaveBeenCalledWith(and(eq(suggestions.orgId, ORG)));
    expect(page.limit).toHaveBeenCalledWith(25);
    expect(page.orderBy).toHaveBeenCalledWith(desc(suggestions.createdAt));
  });
  it('applies explicit org, source, device and status filters and clamps limit', async () => {
    await run({ orgId: ORG, sourceType: 'alert', sourceId: 'source', deviceId: DEVICE, status: 'suggested', limit: 999 });
    expect(page.where).toHaveBeenCalledWith(and(eq(suggestions.orgId, ORG), eq(suggestions.sourceType, 'alert'),
      eq(suggestions.sourceId, 'source'), eq(suggestions.deviceId, DEVICE), eq(suggestions.status, 'suggested')));
    expect(page.limit).toHaveBeenCalledWith(100);
  });
  it('supports unrestricted system access', async () => {
    expect((await run({}, { scope: 'system', orgCondition: () => undefined })).showing).toBe(1);
    expect(page.where).toHaveBeenCalledWith(undefined);
  });
  it('short-circuits empty site access', async () => {
    expect(await run({}, { allowedSiteIds: [] })).toEqual({ suggestions: [], showing: 0 });
    expect(db.select).not.toHaveBeenCalled();
  });
  it.each([{ allowedSiteIds: [ORG] }, { allowedDeviceIds: [DEVICE] }])('filters unreachable devices but keeps device-less rows: %j', async (over) => {
    const noDevice = { ...row, id: ORG, deviceId: null };
    page = query([row, { ...row, deviceId: OTHER }, noDevice]);
    vi.mocked(resolveSiteAllowedDeviceIds).mockResolvedValue([DEVICE]);
    expect(await run({}, over)).toEqual({ suggestions: [row, noDevice], showing: 2 });
    expect(resolveSiteAllowedDeviceIds).toHaveBeenCalledWith(ORG, expect.objectContaining(over));
  });
  it('resolves device access separately per organization', async () => {
    page = query([row, { ...row, orgId: OTHER }]);
    vi.mocked(resolveSiteAllowedDeviceIds).mockImplementation(async (orgId) => orgId === ORG ? [DEVICE] : []);
    expect(await run({}, { scope: 'system', allowedSiteIds: [ORG], orgCondition: () => undefined })).toEqual({ suggestions: [row], showing: 1 });
    expect(resolveSiteAllowedDeviceIds).toHaveBeenCalledTimes(2);
  });
  it('keeps only device-less rows for an empty reachable-device set', async () => {
    page = query([row, { ...row, deviceId: null }]);
    vi.mocked(resolveSiteAllowedDeviceIds).mockResolvedValue([]);
    expect(await run({}, { allowedDeviceIds: [] })).toEqual({ suggestions: [{ ...row, deviceId: null }], showing: 1 });
  });
  it('selects precisely the safe projection, excluding evidence, parameters and targetDeviceIds', async () => {
    await run();
    expect(Object.keys(vi.mocked(db.select).mock.calls[0]![0]!).sort()).toEqual([
      'id', 'orgId', 'sourceType', 'sourceId', 'deviceId', 'alertId', 'anomalyId', 'correlationGroupId', 'rcaId',
      'targetType', 'scriptId', 'playbookId', 'title', 'rationale', 'expectedAction', 'riskTier', 'status', 'confidence',
      'elevationRequestId', 'toolExecutionId', 'scriptExecutionId', 'playbookExecutionId', 'failureMessage',
      'createdAt', 'updatedAt', 'acceptedAt', 'rejectedAt', 'executedAt',
    ].sort());
  });
  it.each([{ orgId: 'bad' }, { deviceId: 'bad' }, { sourceType: 'bad' }, { sourceId: '' }, { status: 'bad' }, { limit: 1.5 }])('rejects invalid filters %j', async (input) => {
    expect((await run(input)).error).toBeTruthy();
    expect(db.select).not.toHaveBeenCalled();
  });
  it('returns an empty list when nothing matches', async () => {
    page = query([]);
    expect(await run()).toEqual({ suggestions: [], showing: 0 });
  });
  it('sanitizes database errors', async () => {
    page.limit.mockRejectedValueOnce(new Error('private database detail'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await run()).error).toBe('The tool could not complete this request. Details were recorded in the server logs.');
    } finally { log.mockRestore(); }
  });
});
