import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000c2';
const SITE = '00000000-0000-4000-8000-0000000000a1';
const DEV = '00000000-0000-4000-8000-0000000000f2';
const DEV2 = '00000000-0000-4000-8000-0000000000f3';
const POLICY = '00000000-0000-4000-8000-0000000000d1';
const PARTNER = '00000000-0000-4000-8000-0000000000e1';

/** A chainable, awaitable Drizzle stand-in: every builder method returns the chain; awaiting it yields `rows`. */
function chain(rows: unknown[], capture?: (method: string, args: unknown[]) => void): unknown {
  const target: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(rows);
      return (...args: unknown[]) => { capture?.(String(prop), args); return proxy; };
    },
  });
  return proxy;
}

const h = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  verify: vi.fn(),
  listStatusRows: vi.fn(),
  buildRecs: vi.fn(),
  statusMap: vi.fn(),
  getPolicy: vi.fn(),
  queue: vi.fn(),
  audit: vi.fn(),
  transaction: vi.fn(),
  enqueueDrift: vi.fn(),
  trend: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: h.select, selectDistinct: h.select, selectDistinctOn: h.select, insert: h.insert, update: h.update, transaction: h.transaction },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: (_c: unknown, fn: () => unknown) => fn(),
}));
vi.mock('./aiTools', () => ({ verifyDeviceAccess: h.verify }));
vi.mock('./auditService', () => ({ createAuditLogAsync: h.audit }));
vi.mock('../jobs/auditBaselineJobs', () => ({ enqueueAuditDriftEvaluation: h.enqueueDrift }));
vi.mock('./securityPosture', async (importOriginal) => ({ ...(await importOriginal<object>()), getSecurityPostureTrend: h.trend }));
vi.mock('./aiDispatch', () => ({ aiQueueCommand: h.queue }));
vi.mock('../routes/policyManagement/helpers', () => ({ getPolicyWithOrgCheck: h.getPolicy }));
vi.mock('../routes/security/helpers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listStatusRows: h.listStatusRows,
  buildBe9Recommendations: h.buildRecs,
  getRecommendationStatusMap: h.statusMap,
}));

import type { AuthContext } from '../middleware/auth';
import { RemoteToolsDisabledByPolicyError } from './aiRemoteToolsPolicy';
import type { AiTool } from './aiTools';
import { registerSecurityComplianceTools } from './aiToolsSecurityCompliance';
import { registerSecurityRecommendationTools } from './aiToolsSecurityRecommendations';
import { registerSecurityPolicyTools } from './aiToolsSecurityPolicies';
import { registerRecoveryKeyTools } from './aiToolsRecoveryKeys';
import { registerAccessReviewTools } from './aiToolsAccessReviews';
import { registerAuditBaselineTools } from './aiToolsAuditBaselines';
import { registerPamRuleTools, pamRuleChangeAllowed } from './aiToolsPamRules';

const tools = new Map<string, AiTool>();
for (const register of [
  registerSecurityComplianceTools, registerSecurityRecommendationTools, registerSecurityPolicyTools,
  registerRecoveryKeyTools, registerAccessReviewTools, registerAuditBaselineTools, registerPamRuleTools,
]) register(tools);

const makeAuth = (over: Record<string, unknown> = {}) => ({
  principal: { kind: 'user_session' },
  user: { id: 'user-1', email: 'tech@example.test' },
  scope: 'organization',
  orgId: ORG,
  partnerId: null,
  partnerOrgAccess: undefined,
  accessibleOrgIds: [ORG],
  canAccessOrg: (id: string) => id === ORG,
  orgCondition: () => undefined,
  allowedSiteIds: undefined,
  allowedDeviceIds: undefined,
  canAccessSite: undefined,
  token: { mfa: true, amr: ['pwd', 'mfa'] },
  aiOrigin: { kind: 'chat', sessionId: 'session-1' },
  ...over,
}) as unknown as AuthContext;
const siteRestricted = () => makeAuth({ allowedSiteIds: [SITE], canAccessSite: (s: string) => s === SITE });
const deviceBound = () => makeAuth({ allowedDeviceIds: [DEV] });
const agent = () => makeAuth({ principal: { kind: 'ai_agent', agentId: 'agent-1' }, aiOrigin: { kind: 'ai_agent', agentRunId: 'run-1' } });

const run = async (name: string, input: Record<string, unknown>, auth: AuthContext = makeAuth()) =>
  JSON.parse(await tools.get(name)!.handler(input, auth)) as Record<string, unknown>;

const statusRow = (deviceId: string, over: Record<string, unknown> = {}) => ({
  deviceId, orgId: ORG, deviceName: `host-${deviceId.slice(-2)}`, os: 'windows', deviceState: 'online',
  provider: 'windows_defender', providerVersion: '1', definitionsVersion: '1', definitionsDate: null,
  realTimeProtection: true, threatCount: 0, firewallEnabled: true, encryptionStatus: 'encrypted',
  encryptionDetails: null, localAdminSummary: { accounts: [{ username: 'Administrator', isBuiltIn: true, enabled: true }] },
  passwordPolicySummary: null, gatekeeperEnabled: null, lastScan: null, lastScanType: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('W11-D3: PAM rule changes never widen auto-approval (decision table)', () => {
  const plain = { verdict: 'require_approval', suspendedVerdict: null };
  const auto = { verdict: 'auto_approve', suspendedVerdict: null };
  const quarantined = { verdict: 'require_approval', suspendedVerdict: 'auto_approve' };
  it.each([
    // [label, action, existing, otherAutoApprove, changed, enabledValue, allowed]
    ['plain rule, no auto-approve in org: any update', 'update_rule', plain, false, ['priority', 'matchPathGlob'], undefined, true],
    ['plain rule, auto-approve elsewhere: re-priority refused', 'update_rule', plain, true, ['priority'], undefined, false],
    ['plain rule, auto-approve elsewhere: narrowing criteria refused', 'update_rule', plain, true, ['matchPathGlob'], undefined, false],
    ['plain rule, auto-approve elsewhere: disable refused', 'update_rule', plain, true, ['enabled'], false, false],
    ['plain rule, auto-approve elsewhere: rename allowed', 'update_rule', plain, true, ['name', 'description'], undefined, true],
    ['plain rule, auto-approve elsewhere: delete refused', 'delete_rule', plain, true, [], undefined, false],
    ['plain rule, nothing auto-approves: delete allowed', 'delete_rule', plain, false, [], undefined, true],
    ['auto rule: disable allowed', 'update_rule', auto, true, ['enabled'], false, true],
    ['auto rule: enable refused', 'update_rule', auto, false, ['enabled'], true, false],
    ['auto rule: widening criteria refused even alone in the org', 'update_rule', auto, false, ['matchPathGlob'], undefined, false],
    ['auto rule: disable + rename together refused (not a pure disable)', 'update_rule', auto, false, ['enabled', 'priority'], false, false],
    ['auto rule: delete allowed', 'delete_rule', auto, true, [], undefined, true],
    ['quarantined rule: criteria refused', 'update_rule', quarantined, false, ['matchSigner'], undefined, false],
    ['quarantined rule: disable allowed when nothing else auto-approves', 'update_rule', quarantined, false, ['enabled'], false, true],
    ['quarantined rule: disable refused when another rule auto-approves', 'update_rule', quarantined, true, ['enabled'], false, false],
    ['quarantined rule: delete allowed when nothing else auto-approves', 'delete_rule', quarantined, false, [], undefined, true],
    ['quarantined rule: delete refused when another rule auto-approves', 'delete_rule', quarantined, true, [], undefined, false],
    ['no change is never cosmetic', 'update_rule', auto, false, [], undefined, false],
  ] as const)('%s', (_label, action, existing, otherAutoApprove, changed, enabledValue, allowed) => {
    expect(pamRuleChangeAllowed({ action, existing, otherAutoApprove, changed: [...changed], enabledValue })).toBe(allowed);
  });

  it('PAM is refused to a device-bound session and to an automation principal, and writes need MFA', async () => {
    expect((await run('manage_pam_rules', { action: 'list_rules' }, deviceBound())).code).toBe('ACCESS_DENIED');
    expect((await run('manage_pam_rules', { action: 'create_rule', name: 'x', verdict: 'auto_deny', matchHash: 'a'.repeat(64) }, agent())).code).toBe('AGENT_REFUSED');
    const noMfa = makeAuth({ token: {} });
    expect((await run('manage_pam_rules', { action: 'set_config', defaultUnmatchedVerdict: 'auto_deny' }, noMfa)).code).toBe('MFA_REQUIRED');
  });

  it('create_rule refuses an auto_approve verdict in the handler too', async () => {
    const out = await run('manage_pam_rules', { action: 'create_rule', name: 'x', verdict: 'auto_approve', matchHash: 'a'.repeat(64) });
    expect(out.code).toBe('VALIDATION_ERROR');
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('org config and signer groups are refused to a site-restricted caller (route ceiling)', async () => {
    expect((await run('manage_pam_rules', { action: 'set_config', defaultUnmatchedVerdict: 'auto_deny' }, siteRestricted())).code).toBe('ACCESS_DENIED');
    expect((await run('manage_pam_rules', { action: 'create_signer_group', name: 'Vendors' }, siteRestricted())).code).toBe('ACCESS_DENIED');
  });
});

describe('get_security_compliance', () => {
  it('firewall rows carry only what the agent reported (no synthesised profiles or rule counts)', async () => {
    h.listStatusRows.mockResolvedValue([statusRow(DEV), statusRow(DEV2, { firewallEnabled: null })]);
    const out = await run('get_security_compliance', { view: 'firewall' });
    expect(JSON.stringify(out)).not.toMatch(/rulesCount|profiles|inboundPolicy/);
    expect(out.summary).toMatchObject({ total: 2, enabled: 1, unknown: 1 });
  });

  it('applies the exact-device axis before paging and counting', async () => {
    h.listStatusRows.mockResolvedValue([statusRow(DEV), statusRow(DEV2)]);
    const out = await run('get_security_compliance', { view: 'status' }, deviceBound());
    expect((out.devices as Array<{ deviceId: string }>).map((d) => d.deviceId)).toEqual([DEV]);
    expect(out.total).toBe(1);
  });

  it('refuses the org-wide aggregates to a device-bound session', async () => {
    for (const view of ['dashboard', 'score_breakdown', 'trends']) {
      expect((await run('get_security_compliance', { view }, deviceBound())).code, view).toBe('ACCESS_DENIED');
    }
  });

  it('validates view-specific filters and deviceId', async () => {
    expect((await run('get_security_compliance', { view: 'firewall', filter: 'encrypted' })).code).toBe('VALIDATION_ERROR');
    expect((await run('get_security_compliance', { view: 'firewall', deviceId: DEV })).code).toBe('VALIDATION_ERROR');
    expect((await run('get_security_compliance', { view: 'status', orgId: OTHER_ORG })).code).toBe('NOT_FOUND');
  });

  it('a hidden device on the status view is one opaque not-found', async () => {
    h.verify.mockResolvedValue({ error: 'Device not found or access denied' });
    expect((await run('get_security_compliance', { view: 'status', deviceId: DEV })).code).toBe('NOT_FOUND');
  });
});

describe('manage_security_recommendations', () => {
  it('the org-wide list is refused to a device-bound session; marking one is refused to a restricted session', async () => {
    expect((await run('manage_security_recommendations', { action: 'list' }, deviceBound())).code).toBe('ACCESS_DENIED');
    expect((await run('manage_security_recommendations', { action: 'dismiss', recommendationId: 'rec-enable-av' }, siteRestricted())).code).toBe('ACCESS_DENIED');
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('an unknown recommendation is not found and writes nothing', async () => {
    h.buildRecs.mockResolvedValue({ recommendations: [{ id: 'rec-enable-av' }] });
    expect((await run('manage_security_recommendations', { action: 'complete', recommendationId: 'rec-nope' })).code).toBe('NOT_FOUND');
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('records the status row the route records, attributed by AI origin', async () => {
    h.buildRecs.mockResolvedValue({ recommendations: [{ id: 'rec-enable-av' }] });
    const values: unknown[] = [];
    h.insert.mockImplementation(() => chain([], (m, args) => { if (m === 'values') values.push(args[0]); }));
    const out = await run('manage_security_recommendations', { action: 'dismiss', recommendationId: 'rec-enable-av' });
    expect(out).toMatchObject({ id: 'rec-enable-av', orgId: ORG, status: 'dismissed' });
    expect(values[0]).toMatchObject({
      orgId: ORG, action: 'security.recommendation.dismiss', resourceType: 'security_recommendation', resourceName: 'rec-enable-av',
      actorType: 'user', actorId: 'user-1', initiatedBy: 'ai',
    });
  });

  it('marks the request as audited, so the generic fallback adds no second row', async () => {
    h.buildRecs.mockResolvedValue({ recommendations: [{ id: 'rec-enable-av' }] });
    h.insert.mockImplementation(() => chain([]));
    const { runWithAuditRequestTracking } = await import('./auditRequestTracking');
    const written = await runWithAuditRequestTracking(async () => {
      await run('manage_security_recommendations', { action: 'complete', recommendationId: 'rec-enable-av' });
    });
    expect(h.insert).toHaveBeenCalledOnce();
    expect(written).toBe(true);
  });
});

describe('manage_compliance_policies (W11-D4)', () => {
  it('needs MFA and the org-wide ceiling', async () => {
    expect((await run('manage_compliance_policies', { action: 'deactivate', policyId: POLICY, ownerScope: 'organization' }, makeAuth({ token: {} }))).code).toBe('MFA_REQUIRED');
    expect((await run('manage_compliance_policies', { action: 'deactivate', policyId: POLICY, ownerScope: 'organization' }, siteRestricted())).code).toBe('ACCESS_DENIED');
  });

  it('refuses an ownerScope that does not match the row, both ways, before any write', async () => {
    h.getPolicy.mockResolvedValue({ id: POLICY, orgId: null, partnerId: PARTNER, enabled: true, name: 'p' });
    expect((await run('manage_compliance_policies', { action: 'deactivate', policyId: POLICY, ownerScope: 'organization' })).code).toBe('OWNER_SCOPE_MISMATCH');
    h.getPolicy.mockResolvedValue({ id: POLICY, orgId: ORG, partnerId: null, enabled: true, name: 'p' });
    expect((await run('manage_compliance_policies', { action: 'deactivate', policyId: POLICY, ownerScope: 'partner' })).code).toBe('OWNER_SCOPE_MISMATCH');
    expect(h.update).not.toHaveBeenCalled();
  });

  it('a partner-wide row needs full partner scope', async () => {
    h.getPolicy.mockResolvedValue({ id: POLICY, orgId: null, partnerId: PARTNER, enabled: true, name: 'p' });
    const partnerTech = makeAuth({ scope: 'partner', partnerId: PARTNER, partnerOrgAccess: 'selected', orgId: null });
    expect((await run('manage_compliance_policies', { action: 'deactivate', policyId: POLICY, ownerScope: 'partner' }, partnerTech)).code).toBe('ACCESS_DENIED');
    expect(h.update).not.toHaveBeenCalled();
  });

  it('missing or malformed ownerScope is a validation error', async () => {
    expect((await run('manage_compliance_policies', { action: 'deactivate', policyId: POLICY })).code).toBe('VALIDATION_ERROR');
    expect((await run('manage_compliance_policies', { action: 'deactivate', policyId: POLICY, ownerScope: 'everyone' })).code).toBe('VALIDATION_ERROR');
  });
});

describe('manage_security_policies', () => {
  it('writes are refused to a restricted caller; update cannot move ownership', async () => {
    expect((await run('manage_security_policies', { action: 'create', name: 'x' }, siteRestricted())).code).toBe('ACCESS_DENIED');
    expect((await run('manage_security_policies', { action: 'update', policyId: POLICY, ownerScope: 'partner', name: 'y' })).code).toBe('VALIDATION_ERROR');
  });

  it('a partner-wide create needs partner scope with full access', async () => {
    expect((await run('manage_security_policies', { action: 'create', name: 'x', ownerScope: 'partner' })).code).toBe('ACCESS_DENIED');
  });
});

describe('manage_recovery_keys', () => {
  it('never rotates a macOS key from chat (credentials would have to travel through the model)', async () => {
    h.verify.mockResolvedValue({ device: { id: DEV, orgId: ORG, hostname: 'mac-1', osType: 'macos' } });
    expect((await run('manage_recovery_keys', { action: 'rotate', deviceId: DEV })).code).toBe('NOT_SUPPORTED');
    expect(h.queue).not.toHaveBeenCalled();
  });

  it('list returns key metadata and a ledger without staff identities', async () => {
    h.verify.mockResolvedValue({ device: { id: DEV, orgId: ORG, hostname: 'win-1', osType: 'windows' } });
    const projections: unknown[] = [];
    h.select
      .mockImplementationOnce((p: unknown) => { projections.push(p); return chain([{ id: 'k1', keyType: 'recovery_password', status: 'active' }]); })
      .mockImplementationOnce((p: unknown) => { projections.push(p); return chain([{ keyId: 'k1', action: 'revealed', createdAt: new Date(0) }]); });
    const out = await run('manage_recovery_keys', { action: 'list', deviceId: DEV });
    expect(out.keys).toHaveLength(1);
    for (const p of projections) expect(Object.keys(p as object)).not.toEqual(expect.arrayContaining(['encryptedKey']));
    expect(Object.keys(projections[1] as object).sort()).toEqual(['action', 'createdAt', 'keyId']);
    expect(JSON.stringify(out)).not.toMatch(/userEmail|userName|encryptedKey|recoveryKey"/);
  });

  it('rotate queues one Windows command for the resolved volume', async () => {
    h.verify.mockResolvedValue({ device: { id: DEV, orgId: ORG, hostname: 'win-1', osType: 'windows' } });
    h.queue.mockResolvedValue({ id: 'cmd-1' });
    const out = await run('manage_recovery_keys', { action: 'rotate', deviceId: DEV, volumeMount: 'D:' });
    expect(out).toMatchObject({ queued: true, commandId: 'cmd-1', volumeMount: 'D:' });
    expect(h.queue).toHaveBeenCalledWith(expect.anything(), 'manage_recovery_keys', DEV, 'encryption_rotate_key', { volumeMount: 'D:' }, 'user-1');
  });
});

describe('manage_access_reviews', () => {
  it('is refused to a restricted session, a system caller and a partner without full access', async () => {
    expect((await run('manage_access_reviews', { action: 'list' }, siteRestricted())).code).toBe('ACCESS_DENIED');
    expect((await run('manage_access_reviews', { action: 'list' }, deviceBound())).code).toBe('ACCESS_DENIED');
    expect((await run('manage_access_reviews', { action: 'list' }, makeAuth({ scope: 'system', orgId: null }))).code).toBe('ACCESS_DENIED');
    const partnerTech = makeAuth({ scope: 'partner', partnerId: PARTNER, partnerOrgAccess: 'selected', orgId: null });
    expect((await run('manage_access_reviews', { action: 'list' }, partnerTech)).code).toBe('ACCESS_DENIED');
  });

  it('writes need MFA', async () => {
    expect((await run('manage_access_reviews', { action: 'create', name: 'Q4' }, makeAuth({ token: {} }))).code).toBe('MFA_REQUIRED');
  });
});

describe('manage_audit_baselines', () => {
  it('both writes refuse an automation principal before touching the database', async () => {
    expect((await run('manage_audit_baselines', { action: 'create', name: 'x', osType: 'windows', profile: 'cis_l1' }, agent())).code).toBe('AGENT_REFUSED');
    expect((await run('manage_audit_baselines', { action: 'request_apply', baselineId: POLICY, deviceIds: [DEV] }, agent())).code).toBe('AGENT_REFUSED');
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('create is refused to a site-restricted caller (org-wide config)', async () => {
    expect((await run('manage_audit_baselines', { action: 'create', name: 'x', osType: 'windows', profile: 'cis_l1' }, siteRestricted())).code).toBe('ACCESS_DENIED');
  });
});

describe('W11 review follow-ups', () => {
  const winDevice = { device: { id: DEV, orgId: ORG, hostname: 'win-1', osType: 'windows' } };
  const partnerAuth = (over: Record<string, unknown> = {}) => makeAuth({
    scope: 'partner', partnerId: PARTNER, partnerOrgAccess: 'all', orgId: null,
    accessibleOrgIds: [ORG, OTHER_ORG], canAccessOrg: (id: string) => id === ORG || id === OTHER_ORG, ...over,
  });

  describe('manage_recovery_keys', () => {
    it('rotate and collect surface a remote-tools policy denial as POLICY_DENIED and record no audit', async () => {
      h.verify.mockResolvedValue(winDevice);
      h.queue.mockRejectedValue(new RemoteToolsDisabledByPolicyError(DEV, 'encryption_rotate_key', 'AI remote tools are disabled'));
      expect((await run('manage_recovery_keys', { action: 'rotate', deviceId: DEV, volumeMount: 'C:' })).code).toBe('POLICY_DENIED');
      expect((await run('manage_recovery_keys', { action: 'collect', deviceId: DEV })).code).toBe('POLICY_DENIED');
      expect(h.audit).not.toHaveBeenCalled();
    });

    it.each(['C:\\; evil', 'CC:', 'C', '1:'])('rotate refuses volumeMount %j in the handler and queues nothing', async (volumeMount) => {
      h.verify.mockResolvedValue(winDevice);
      const out = await run('manage_recovery_keys', { action: 'rotate', deviceId: DEV, volumeMount });
      expect(out.code).toBe('VALIDATION_ERROR');
      expect(h.queue).not.toHaveBeenCalled();
    });

    it('rotate without volumeMount needs exactly one escrowed active volume', async () => {
      h.verify.mockResolvedValue(winDevice);
      h.select.mockImplementationOnce(() => chain([]));
      const none = await run('manage_recovery_keys', { action: 'rotate', deviceId: DEV });
      expect(none.code).toBe('VALIDATION_ERROR');
      expect(String(none.error)).toMatch(/no escrowed volume/);
      h.select.mockImplementationOnce(() => chain([{ volumeMount: 'C:' }, { volumeMount: 'D:' }]));
      const several = await run('manage_recovery_keys', { action: 'rotate', deviceId: DEV });
      expect(several.code).toBe('VALIDATION_ERROR');
      expect(String(several.error)).toMatch(/several escrowed volumes/);
      expect(h.queue).not.toHaveBeenCalled();
    });

    it('rotate defaults the volume when exactly one is escrowed (duplicate rows collapse)', async () => {
      h.verify.mockResolvedValue(winDevice);
      h.select.mockImplementationOnce(() => chain([{ volumeMount: 'C:' }, { volumeMount: 'C:' }]));
      h.queue.mockResolvedValue({ id: 'cmd-2' });
      const out = await run('manage_recovery_keys', { action: 'rotate', deviceId: DEV });
      expect(out).toMatchObject({ queued: true, volumeMount: 'C:' });
    });

    it('rotate on linux is NOT_SUPPORTED', async () => {
      h.verify.mockResolvedValue({ device: { id: DEV, orgId: ORG, hostname: 'lx-1', osType: 'linux' } });
      expect((await run('manage_recovery_keys', { action: 'rotate', deviceId: DEV, volumeMount: 'C:' })).code).toBe('NOT_SUPPORTED');
      expect(h.queue).not.toHaveBeenCalled();
    });
  });

  describe('manage_security_recommendations write org', () => {
    it('with no orgId the accessible write default owns the status row and the build', async () => {
      h.buildRecs.mockResolvedValue({ recommendations: [{ id: 'rec-enable-av' }] });
      const values: unknown[] = [];
      h.insert.mockImplementation(() => chain([], (m, args) => { if (m === 'values') values.push(args[0]); }));
      const out = await run('manage_security_recommendations', { action: 'dismiss', recommendationId: 'rec-enable-av' }, partnerAuth({ aiWriteDefaultOrgId: OTHER_ORG }));
      expect(out).toMatchObject({ orgId: OTHER_ORG, status: 'dismissed' });
      expect(values[0]).toMatchObject({ orgId: OTHER_ORG });
      expect(h.buildRecs).toHaveBeenCalledWith(expect.anything(), OTHER_ORG);
    });

    it('a partner with two orgs, no orgId and no write default gets VALIDATION_ERROR and no insert', async () => {
      const out = await run('manage_security_recommendations', { action: 'dismiss', recommendationId: 'rec-enable-av' }, partnerAuth());
      expect(out.code).toBe('VALIDATION_ERROR');
      expect(String(out.error)).toMatch(/orgId is required/);
      expect(h.insert).not.toHaveBeenCalled();
      expect(h.buildRecs).not.toHaveBeenCalled();
    });
  });

  describe('manage_audit_baselines create drift evaluation', () => {
    const created = (isActive: boolean) => ({ id: POLICY, orgId: ORG, name: 'B', osType: 'windows', profile: 'custom', isActive });
    const create = (isActive?: boolean) => {
      h.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
        fn({ update: () => chain([]), insert: () => chain([created(isActive !== false)]) }));
      return run('manage_audit_baselines', {
        action: 'create', name: 'B', osType: 'windows', profile: 'custom', settings: { a: 1 }, ...(isActive === undefined ? {} : { isActive }),
      });
    };

    it('an inactive baseline enqueues nothing', async () => {
      const out = await create(false);
      expect(out).toMatchObject({ created: true, driftEvaluation: 'inactive' });
      expect(h.enqueueDrift).not.toHaveBeenCalled();
    });

    it('a failed enqueue still reports created, with not_queued and a note', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      h.enqueueDrift.mockRejectedValue(new Error('redis down'));
      const out = await create();
      expect(out).toMatchObject({ created: true, driftEvaluation: 'not_queued' });
      expect(String(out.note)).toMatch(/saved/);
    });

    it('an active baseline with a healthy queue reports queued and no note', async () => {
      h.enqueueDrift.mockResolvedValue('job-1');
      const out = await create();
      expect(out).toMatchObject({ created: true, driftEvaluation: 'queued' });
      expect(h.enqueueDrift).toHaveBeenCalledWith(ORG);
      expect(out.note).toBeUndefined();
    });
  });

  describe('get_security_compliance trends', () => {
    it('zero data points is no_data', async () => {
      h.trend.mockResolvedValue([]);
      const out = await run('get_security_compliance', { view: 'trends' });
      expect((out.summary as { trend: string }).trend).toBe('no_data');
    });

    it('rising, falling and flat points are improving, declining and stable', async () => {
      const trendFor = async (a: number, b: number) => {
        h.trend.mockResolvedValue([{ overall: a }, { overall: b }]);
        return (await run('get_security_compliance', { view: 'trends' })).summary as { trend: string; change: number };
      };
      expect(await trendFor(60, 70)).toMatchObject({ trend: 'improving', change: 10 });
      expect(await trendFor(70, 60)).toMatchObject({ trend: 'declining', change: -10 });
      expect(await trendFor(65, 65)).toMatchObject({ trend: 'stable', change: 0 });
    });
  });

  describe('manage_pam_rules update with an empty returning()', () => {
    let consoleError: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined); });
    // The specific throw, not any exception inside the transaction.
    const loggedNoRow = (what: string) => JSON.stringify(consoleError.mock.calls).includes(`${what} matched no row after the locked read`);

    it('update_rule answers with the generic thrown error, never updated:true / rule:null', async () => {
      const existing = { id: POLICY, orgId: ORG, siteId: null, name: 'r', enabled: true, verdict: 'require_approval', suspendedVerdict: null, matchHash: 'a'.repeat(64) };
      const selects = [[existing], []];
      h.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
        fn({ select: () => chain(selects.shift() ?? []), update: () => chain([]) }));
      const out = await run('manage_pam_rules', { action: 'update_rule', ruleId: POLICY, name: 'renamed' });
      expect(out.error).toBe('Operation failed. Check server logs for details.');
      expect(out.updated).toBeUndefined();
      expect(out.rule).toBeUndefined();
      expect(loggedNoRow('PAM rule update')).toBe(true);
    });

    it('update_signer_group answers with the generic thrown error, never updated:true', async () => {
      const existing = { id: POLICY, orgId: ORG, name: 'g' };
      h.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
        fn({ select: () => chain([existing]), update: () => chain([]) }));
      const out = await run('manage_pam_rules', { action: 'update_signer_group', signerGroupId: POLICY, name: 'renamed' });
      expect(out.error).toBe('Operation failed. Check server logs for details.');
      expect(out.updated).toBeUndefined();
      expect(loggedNoRow('signer group update')).toBe(true);
    });
  });

  describe('bounded results', () => {
    it('a list over 96 KB is refused with result_too_large and a hint to pass orgId', async () => {
      const big = 'x'.repeat(2000);
      const rows = Array.from({ length: 80 }, (_, i) => ({
        id: `g${i}`, orgId: ORG, name: `group-${i}`, description: big, signers: [], updatedAt: new Date(0),
      }));
      h.select.mockImplementationOnce(() => chain(rows));
      const out = await run('manage_pam_rules', { action: 'list_signer_groups' });
      expect(out.code).toBe('result_too_large');
      expect(String(out.error)).toMatch(/orgId/);
    });
  });
});
