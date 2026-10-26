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
}));

vi.mock('../db', () => ({
  db: { select: h.select, selectDistinct: h.select, selectDistinctOn: h.select, insert: h.insert, update: h.update, transaction: vi.fn() },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: (_c: unknown, fn: () => unknown) => fn(),
}));
vi.mock('./aiTools', () => ({ verifyDeviceAccess: h.verify }));
vi.mock('./auditService', () => ({ createAuditLogAsync: h.audit }));
vi.mock('./aiDispatch', () => ({ aiQueueCommand: h.queue }));
vi.mock('../routes/policyManagement/helpers', () => ({ getPolicyWithOrgCheck: h.getPolicy }));
vi.mock('../routes/security/helpers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listStatusRows: h.listStatusRows,
  buildBe9Recommendations: h.buildRecs,
  getRecommendationStatusMap: h.statusMap,
}));

import type { AuthContext } from '../middleware/auth';
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
