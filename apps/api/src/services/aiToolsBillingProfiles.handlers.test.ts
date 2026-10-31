import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const PARTNER = '00000000-0000-4000-8000-0000000000e1';
const PROFILE = '00000000-0000-4000-8000-0000000000b1';
const WORK_TYPE = '00000000-0000-4000-8000-0000000000b2';

function chain(rows: unknown[]): unknown {
  const target: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(rows);
      return () => proxy;
    },
  });
  return proxy;
}

const h = vi.hoisted(() => ({
  select: vi.fn(),
  auditAsync: vi.fn(),
  listProfiles: vi.fn(),
  getProfile: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  replaceProfileRows: vi.fn(),
  cloneProfile: vi.fn(),
  getOrgAssignment: vi.fn(),
  assignProfileToOrg: vi.fn(),
  clearOrgAssignment: vi.fn(),
  listWorkTypes: vi.fn(),
  createWorkType: vi.fn(),
  updateWorkType: vi.fn(),
  resolveOrg: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: h.select },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./auditService', () => ({ createAuditLogAsync: h.auditAsync }));
vi.mock('./billingProfileService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./billingProfileService')>();
  return {
    BillingProfileServiceError: actual.BillingProfileServiceError,
    listProfiles: h.listProfiles, getProfile: h.getProfile, createProfile: h.createProfile,
    updateProfile: h.updateProfile, replaceProfileRows: h.replaceProfileRows, cloneProfile: h.cloneProfile,
    getOrgAssignment: h.getOrgAssignment, assignProfileToOrg: h.assignProfileToOrg, clearOrgAssignment: h.clearOrgAssignment,
  };
});
vi.mock('./workTypeService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workTypeService')>();
  return {
    WorkTypeServiceError: actual.WorkTypeServiceError,
    listWorkTypes: h.listWorkTypes, createWorkType: h.createWorkType, updateWorkType: h.updateWorkType,
  };
});
vi.mock('./billingOrgAccess', () => ({ resolveBillingConfigurableOrg: h.resolveOrg }));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerBillingProfileTools } from './aiToolsBillingProfiles';
import { BillingProfileServiceError } from './billingProfileService';

const tools = new Map<string, AiTool>();
registerBillingProfileTools(tools);

const makeAuth = (over: Record<string, unknown> = {}) => ({
  principal: { kind: 'user_session' },
  user: { id: 'user-1', email: 'tech@example.test' },
  scope: 'partner',
  orgId: null,
  partnerId: PARTNER,
  partnerOrgAccess: 'all',
  accessibleOrgIds: [ORG],
  canAccessOrg: (id: string) => id === ORG,
  orgCondition: () => undefined,
  allowedSiteIds: undefined,
  allowedDeviceIds: undefined,
  token: { mfa: true, amr: ['pwd', 'mfa'] },
  aiOrigin: { kind: 'chat', sessionId: 'session-1' },
  ...over,
}) as unknown as AuthContext;
const noMfa = () => makeAuth({ token: {} });

const run = async (name: string, input: Record<string, unknown>, auth: AuthContext = makeAuth()) =>
  JSON.parse(await tools.get(name)!.handler(input, auth)) as Record<string, any>;

const card = (over: Record<string, unknown> = {}) => ({
  id: PROFILE, partnerId: PARTNER, name: 'Standard', notes: null, currencyCode: 'USD', baseCoverage: 'billable',
  baseHourlyRate: '150.00', baseMinimumMinutes: 15, roundingIncrementMinutes: 15, isDefault: true, isActive: true,
  aiCoverage: 'non_billable', aiMarkupPercent: null, createdAt: new Date(), updatedAt: new Date(),
  rules: [{ id: 'r1', partnerId: PARTNER, billingProfileId: PROFILE, workTypeId: WORK_TYPE, coverage: 'billable', hourlyRate: '200.00', minimumMinutes: null, notes: null }],
  aiRates: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.select.mockImplementation(() => chain([{ id: 'user-1' }]));
  h.resolveOrg.mockResolvedValue({ id: ORG, partnerId: PARTNER });
  h.getProfile.mockResolvedValue(card());
  h.getOrgAssignment.mockResolvedValue(null);
});

describe('manage_billing_profiles', () => {
  it('refuses an organization-scoped caller before any read or write (REST parity)', async () => {
    for (const action of ['list', 'create', 'get_org_profile']) {
      const out = await run('manage_billing_profiles', { action, orgId: ORG, name: 'x' }, makeAuth({ scope: 'organization', orgId: ORG }));
      expect(out.code).toBe('PARTNER_SCOPE_REQUIRED');
    }
    expect(h.listProfiles).not.toHaveBeenCalled();
    expect(h.createProfile).not.toHaveBeenCalled();
    expect(h.resolveOrg).not.toHaveBeenCalled();
  });

  it('list returns an explicit projection (no partnerId, no row ids)', async () => {
    h.listProfiles.mockResolvedValue([card()]);
    const out = await run('manage_billing_profiles', { action: 'list' });
    expect(out.profiles[0]).toMatchObject({ id: PROFILE, name: 'Standard', baseHourlyRate: '150.00' });
    expect(out.profiles[0].partnerId).toBeUndefined();
    expect(out.profiles[0].rows[0]).toEqual({ workTypeId: WORK_TYPE, coverage: 'billable', hourlyRate: '200.00', minimumMinutes: null, notes: null });
  });

  it('every write needs an MFA session; nothing is written without one', async () => {
    for (const action of ['create', 'update', 'archive', 'set_rows', 'clone', 'create_work_type', 'update_work_type', 'set_org_profile', 'clear_org_profile']) {
      const out = await run('manage_billing_profiles', { action, profileId: PROFILE, workTypeId: WORK_TYPE, orgId: ORG, name: 'n', rows: [] }, noMfa());
      expect(out.code, action).toBe('MFA_REQUIRED');
    }
    for (const fn of [h.createProfile, h.updateProfile, h.replaceProfileRows, h.cloneProfile, h.createWorkType, h.updateWorkType, h.assignProfileToOrg, h.clearOrgAssignment]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('reads need no MFA', async () => {
    h.listProfiles.mockResolvedValue([]);
    expect((await run('manage_billing_profiles', { action: 'list' }, noMfa())).profiles).toEqual([]);
  });

  it('partner-wide rate writes need full partner org access (canManagePartnerWidePolicies)', async () => {
    const selected = makeAuth({ partnerOrgAccess: 'selected' });
    for (const action of ['create', 'update', 'archive', 'set_rows', 'clone', 'create_work_type', 'update_work_type']) {
      const out = await run('manage_billing_profiles', { action, profileId: PROFILE, workTypeId: WORK_TYPE, name: 'n', currencyCode: 'USD', baseCoverage: 'billable', rows: [] }, selected);
      expect(out.code, action).toBe('ACCESS_DENIED');
    }
    expect(h.createProfile).not.toHaveBeenCalled();
    expect(h.updateProfile).not.toHaveBeenCalled();
    expect(h.createWorkType).not.toHaveBeenCalled();
    expect(h.updateWorkType).not.toHaveBeenCalled();
    expect(h.cloneProfile).not.toHaveBeenCalled();
  });

  it('update writes only the supplied fields and audits before / after', async () => {
    h.updateProfile.mockResolvedValue(card({ baseHourlyRate: '175.00' }));
    const out = await run('manage_billing_profiles', { action: 'update', profileId: PROFILE, baseHourlyRate: '175.00' });
    expect(h.updateProfile).toHaveBeenCalledWith(expect.anything(), PROFILE, PARTNER, { baseHourlyRate: '175.00' });
    expect(out.profile.baseHourlyRate).toBe('175.00');
    expect(out.before.baseHourlyRate).toBe('150.00');
    expect(h.auditAsync).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing_profile.update', resourceId: PROFILE, orgId: null, partnerId: PARTNER }));
  });

  it('archive sends isActive:false and maps the default-profile refusal to its code', async () => {
    h.updateProfile.mockRejectedValue(new BillingProfileServiceError('Set another default profile first', 409, 'DEFAULT_PROFILE_REQUIRED'));
    const out = await run('manage_billing_profiles', { action: 'archive', profileId: PROFILE });
    expect(h.updateProfile).toHaveBeenCalledWith(expect.anything(), PROFILE, PARTNER, { isActive: false });
    expect(out.code).toBe('DEFAULT_PROFILE_REQUIRED');
  });

  it('update_work_type refuses isActive:false (archive clears category defaults; web app only)', async () => {
    const out = await run('manage_billing_profiles', { action: 'update_work_type', workTypeId: WORK_TYPE, isActive: false });
    expect(out.code).toBe('ACCESS_DENIED');
    expect(h.updateWorkType).not.toHaveBeenCalled();
  });

  it('update refuses an AI coverage change that would delete the AI price list (quorum QW3)', async () => {
    h.getProfile.mockResolvedValue(card({ aiCoverage: 'billable', aiRates: [{ modelId: 'm', inputPricePerM: '1', outputPricePerM: '1', cacheReadPricePerM: '1', cacheWritePricePerM: '1' }] }));
    const out = await run('manage_billing_profiles', { action: 'update', profileId: PROFILE, aiCoverage: 'included' });
    expect(out.code).toBe('ACCESS_DENIED');
    expect(h.updateProfile).not.toHaveBeenCalled();
    h.getProfile.mockResolvedValue(card());
    h.updateProfile.mockResolvedValue(card({ aiCoverage: 'included' }));
    expect((await run('manage_billing_profiles', { action: 'update', profileId: PROFILE, aiCoverage: 'included' })).profile.aiCoverage).toBe('included');
  });

  it('update_work_type: another partner\'s work type is not found; a found one returns its previous values', async () => {
    h.listWorkTypes.mockResolvedValue([]);
    expect((await run('manage_billing_profiles', { action: 'update_work_type', workTypeId: WORK_TYPE, name: 'x' })).code).toBe('NOT_FOUND');
    expect(h.updateWorkType).not.toHaveBeenCalled();
    h.listWorkTypes.mockResolvedValue([{ id: WORK_TYPE, name: 'Remote', isActive: true }]);
    h.updateWorkType.mockResolvedValue({ id: WORK_TYPE, name: 'Remote support', isActive: true });
    const out = await run('manage_billing_profiles', { action: 'update_work_type', workTypeId: WORK_TYPE, name: 'Remote support' });
    expect(out.before).toMatchObject({ name: 'Remote' });
  });

  it('set_rows and clear_org_profile return the previous values', async () => {
    h.replaceProfileRows.mockResolvedValue(card({ rules: [] }));
    const rows = await run('manage_billing_profiles', { action: 'set_rows', profileId: PROFILE, rows: [] });
    expect(rows.before.rows).toHaveLength(1);
    h.getOrgAssignment.mockResolvedValue({ orgId: ORG, partnerId: PARTNER, billingProfileId: PROFILE });
    const cleared = await run('manage_billing_profiles', { action: 'clear_org_profile', orgId: ORG });
    expect(cleared.before).toMatchObject({ billingProfileId: PROFILE });
    expect(h.clearOrgAssignment).toHaveBeenCalledWith(ORG, PARTNER);
  });

  it('set_rows validates the full row list before replacing', async () => {
    const bad = await run('manage_billing_profiles', { action: 'set_rows', profileId: PROFILE, rows: [{ workTypeId: WORK_TYPE, coverage: 'included', hourlyRate: '10.00', minimumMinutes: null }] });
    expect(bad.code).toBe('VALIDATION_ERROR');
    expect(h.replaceProfileRows).not.toHaveBeenCalled();
  });

  it('org profile: an unreachable org is NOT_FOUND; a device-bound session cannot assign', async () => {
    h.resolveOrg.mockResolvedValueOnce(null);
    expect((await run('manage_billing_profiles', { action: 'get_org_profile', orgId: ORG })).code).toBe('NOT_FOUND');
    const out = await run('manage_billing_profiles', { action: 'set_org_profile', orgId: ORG, profileId: PROFILE }, makeAuth({ allowedDeviceIds: ['dev-1'] }));
    expect(out.code).toBe('ACCESS_DENIED');
    expect(h.assignProfileToOrg).not.toHaveBeenCalled();
  });

  it('set_org_profile records a verified user (or NULL) as assigned_by and audits on the org', async () => {
    h.assignProfileToOrg.mockResolvedValue({ orgId: ORG, partnerId: PARTNER, billingProfileId: PROFILE, assignedBy: 'user-1' });
    await run('manage_billing_profiles', { action: 'set_org_profile', orgId: ORG, profileId: PROFILE });
    expect(h.assignProfileToOrg).toHaveBeenCalledWith(ORG, PARTNER, PROFILE, 'user-1');
    expect(h.auditAsync).toHaveBeenCalledWith(expect.objectContaining({ action: 'organization.billing_profile.assign', orgId: ORG }));
    h.select.mockImplementation(() => chain([]));
    await run('manage_billing_profiles', { action: 'set_org_profile', orgId: ORG, profileId: PROFILE });
    expect(h.assignProfileToOrg).toHaveBeenLastCalledWith(ORG, PARTNER, PROFILE, null);
  });
});
