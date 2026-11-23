import { beforeEach, describe, expect, it, vi } from 'vitest';

// Copy a configuration policy (#12309, #11776; plan W05b K1). The writes and
// the RLS reads are proven on real Postgres in
// __tests__/integration/configPolicyCopy.integration.test.ts; this file pins
// the planner's decisions and the gates with the services around it mocked.

const m = vi.hoisted(() => ({
  getConfigPolicy: vi.fn(),
  links: [] as unknown[],
  assignPolicy: vi.fn(),
  createConfigPolicy: vi.fn(),
  addFeatureLink: vi.fn(),
  validateFeaturePolicyExists: vi.fn(),
  parentPolicyEnablesHpCmslCollection: vi.fn(),
  parentPolicyArmsOemUpdates: vi.fn(),
  resolvePartnerIdForOrg: vi.fn(),
  getMonitorDefinition: vi.fn(),
  isMonitorAttachableToOwner: vi.fn(),
  checkSecurityRuleSetsWrite: vi.fn(),
  resolveAutomationReferencesForOwner: vi.fn(),
  readOwnerCatalog: vi.fn(),
  checkOemUpdatesLinkWrite: vi.fn(),
  dbRows: [] as unknown[][],
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db', () => {
  const chain = () => {
    const rows = m.dbRows.shift() ?? [];
    const q: Record<string, unknown> = {};
    for (const k of ['from', 'where', 'innerJoin', 'leftJoin']) q[k] = () => q;
    q.limit = () => Promise.resolve(rows);
    return q;
  };
  return {
    db: { select: vi.fn(() => chain()), transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})) },
    withDbTransaction: m.withDbTransaction,
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContextIsolated: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    hasDbAccessContext: vi.fn(() => true),
  };
});

vi.mock('./configurationPolicy', async (importOriginal) => {
  const original = await importOriginal<typeof import('./configurationPolicy')>();
  return {
    ...original,
    getConfigPolicy: m.getConfigPolicy,
    assignPolicy: m.assignPolicy,
    createConfigPolicy: m.createConfigPolicy,
    addFeatureLink: m.addFeatureLink,
    validateFeaturePolicyExists: m.validateFeaturePolicyExists,
    parentPolicyEnablesHpCmslCollection: m.parentPolicyEnablesHpCmslCollection,
    parentPolicyArmsOemUpdates: m.parentPolicyArmsOemUpdates,
  };
});
vi.mock('../routes/patches/helpers', () => ({ resolvePartnerIdForOrg: m.resolvePartnerIdForOrg }));
vi.mock('./monitors/monitorService', () => ({ getMonitorDefinition: m.getMonitorDefinition }));
vi.mock('./monitors/monitorAttachability', () => ({ isMonitorAttachableToOwner: m.isMonitorAttachableToOwner }));
vi.mock('../routes/configurationPolicies/securityRuleSetGate', () => ({
  checkSecurityRuleSetsWrite: m.checkSecurityRuleSetsWrite,
}));
vi.mock('./automationRuntime', async (importOriginal) => {
  const original = await importOriginal<typeof import('./automationRuntime')>();
  return { ...original, resolveAutomationReferencesForOwner: m.resolveAutomationReferencesForOwner };
});
vi.mock('./oemUpdates/oemUpdatesLinkWrite', async (importOriginal) => {
  const original = await importOriginal<typeof import('./oemUpdates/oemUpdatesLinkWrite')>();
  m.checkOemUpdatesLinkWrite.mockImplementation(original.checkOemUpdatesLinkWrite);
  return { ...original, checkOemUpdatesLinkWrite: m.checkOemUpdatesLinkWrite };
});
vi.mock('./securityAgents/managedPolicyOwnerCatalog', async (importOriginal) => {
  const original = await importOriginal<typeof import('./securityAgents/managedPolicyOwnerCatalog')>();
  return { ...original, readOwnerCatalog: m.readOwnerCatalog };
});

import { copyConfigPolicy, ConfigPolicyCopyRefusedError } from './configPolicyCopy';
import { AutomationReferenceAuthorizationError } from './automationReferenceAuthorization';
import { SecurityAgentsLinkWriteError } from './securityAgents/securityAgentsLinkWrite';
import { BackupDestinationNotInOrgError, InvalidParentPolicyError, WarrantyConsentError } from './configurationPolicy';
import type { AuthContext } from '../middleware/auth';

const PARTNER = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_PARTNER = 'aaaaaaaa-0000-4000-8000-000000000002';
const ORG_A = 'bbbbbbbb-0000-4000-8000-00000000000a';
const ORG_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const SOURCE = 'cccccccc-0000-4000-8000-000000000001';
const PARENT = 'cccccccc-0000-4000-8000-000000000002';
const NEW_ID = 'cccccccc-0000-4000-8000-000000000003';
const RING = 'dddddddd-0000-4000-8000-000000000001';
const SW = 'dddddddd-0000-4000-8000-000000000002';
const MONITOR = 'dddddddd-0000-4000-8000-000000000003';

const ALL = { permissions: [{ resource: '*', action: '*' }] } as never;
const WRITE_ONLY = { permissions: [{ resource: 'devices', action: 'write' }] } as never;

function partnerAuth(over: Partial<Record<string, unknown>> = {}): AuthContext {
  return {
    scope: 'partner',
    partnerId: PARTNER,
    orgId: null,
    user: { id: 'user-1' },
    token: { scope: 'partner', mfa: true },
    partnerOrgAccess: 'all',
    accessibleOrgIds: [ORG_A, ORG_B],
    canAccessOrg: (o: string) => o === ORG_A || o === ORG_B,
    orgCondition: () => undefined,
    ...over,
  } as unknown as AuthContext;
}

function orgAuth(orgId = ORG_A): AuthContext {
  return {
    scope: 'organization',
    partnerId: PARTNER,
    orgId,
    user: { id: 'user-2' },
    token: { scope: 'organization', mfa: true },
    accessibleOrgIds: [orgId],
    canAccessOrg: (o: string) => o === orgId,
    orgCondition: () => undefined,
  } as unknown as AuthContext;
}

function link(featureType: string, featurePolicyId: string | null, inlineSettings: unknown = null) {
  return { id: `link-${featureType}`, configPolicyId: SOURCE, featureType, featurePolicyId, inlineSettings };
}

function source(over: Record<string, unknown> = {}) {
  return {
    id: SOURCE,
    name: 'Workstations',
    description: 'Physical desks',
    status: 'active',
    orgId: ORG_A,
    partnerId: null,
    parentPolicyId: null,
    parentPolicy: null,
    featureLinks: m.links,
    ...over,
  };
}

function setLinks(links: unknown[]) {
  m.links = links;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.dbRows = [];
  m.links = [];
  m.getConfigPolicy.mockImplementation(async (id: string) => (id === SOURCE ? source() : null));
  m.createConfigPolicy.mockImplementation(async (owner: Record<string, unknown>, data: Record<string, unknown>) => ({
    id: NEW_ID, orgId: owner.orgId ?? null, partnerId: owner.partnerId ?? null, ...data,
  }));
  m.addFeatureLink.mockImplementation(async (_id: string, featureType: string) => ({ id: `new-${featureType}`, featureType }));
  m.validateFeaturePolicyExists.mockResolvedValue({ valid: true });
  m.parentPolicyEnablesHpCmslCollection.mockResolvedValue(false);
  m.parentPolicyArmsOemUpdates.mockResolvedValue(false);
  m.resolvePartnerIdForOrg.mockResolvedValue(PARTNER);
  m.getMonitorDefinition.mockResolvedValue({ id: MONITOR });
  m.isMonitorAttachableToOwner.mockResolvedValue(true);
  m.checkSecurityRuleSetsWrite.mockResolvedValue({ ok: true });
  m.resolveAutomationReferencesForOwner.mockResolvedValue({});
  m.readOwnerCatalog.mockResolvedValue({ catalogByVendor: new Map(), uploadedBinaryVendors: new Set() });
});

async function refusal(p: Promise<unknown>): Promise<ConfigPolicyCopyRefusedError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ConfigPolicyCopyRefusedError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('copyConfigPolicy', () => {
  it('copy is inactive with no assignments', async () => {
    m.getConfigPolicy.mockImplementation(async (id: string) => (id === SOURCE ? source({ status: 'active' }) : null));
    setLinks([link('patch', RING, { scheduleFrequency: 'daily' })]);

    const result = await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'Workstations (copy)', ownerScope: 'organization', orgId: ORG_A }, { permissions: ALL });

    expect(result).toEqual({ dryRun: false, policyId: NEW_ID, orgId: ORG_A, dropped: [] });
    expect(m.createConfigPolicy).toHaveBeenCalledWith(
      { orgId: ORG_A, partnerId: null },
      expect.objectContaining({ name: 'Workstations (copy)', description: 'Physical desks', status: 'inactive' }),
      'user-1',
    );
    expect(m.addFeatureLink).toHaveBeenCalledWith(NEW_ID, 'patch', RING, { scheduleFrequency: 'daily' }, { userId: 'user-1' }, undefined, {});
    // The whole write is one transaction (the catch sits outside it).
    expect(m.withDbTransaction).toHaveBeenCalledTimes(1);
    expect(m.assignPolicy).not.toHaveBeenCalled();
  });

  it('copy to MSP-managed drops org-owned links and says why', async () => {
    setLinks([
      link('patch', RING),
      link('software_policy', SW),
      link('event_log', null, { retentionDays: 7 }),
    ]);
    // The org's own software policy cannot be linked to a partner-owned policy.
    m.validateFeaturePolicyExists.mockImplementation(async (ft: string) =>
      ft === 'software_policy' ? { valid: false, error: `Software policy "${SW}" not found for this organization or partner` } : { valid: true });

    const result = await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'MSP baseline', ownerScope: 'partner' }, { permissions: ALL });

    expect(result).toEqual({ dryRun: false, policyId: NEW_ID, orgId: null, dropped: [{ featureType: 'software_policy', reason: 'linked_item_unavailable' }] });
    expect(m.createConfigPolicy).toHaveBeenCalledWith({ orgId: null, partnerId: PARTNER }, expect.objectContaining({ status: 'inactive' }), 'user-1');
    expect(m.addFeatureLink.mock.calls.map((c) => c[1])).toEqual(['event_log', 'patch']);
    // The reason is a code: the validator's text (which names the id) never leaves.
    expect(JSON.stringify(result)).not.toContain(SW);
  });

  it('a link to a type that cannot be partner-linked is dropped before any lookup', async () => {
    setLinks([link('automation', 'eeeeeeee-0000-4000-8000-000000000001')]);

    const result = await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'partner' }, { permissions: ALL });

    expect(result).toMatchObject({ dropped: [{ featureType: 'automation', reason: 'linked_item_unavailable' }] });
    expect(m.validateFeaturePolicyExists).not.toHaveBeenCalled();
  });

  it('OneDrive Helper is dropped when copying to MSP-managed', async () => {
    setLinks([link('onedrive_helper', null, { libraries: [] })]);

    const result = await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'partner' }, { permissions: ALL });

    expect(result).toEqual({ dryRun: false, policyId: NEW_ID, orgId: null, dropped: [{ featureType: 'onedrive_helper', reason: 'org_only_feature' }] });
    expect(m.addFeatureLink).not.toHaveBeenCalled();
  });

  it('OneDrive Helper is carried from an MSP-managed policy to one organization', async () => {
    m.getConfigPolicy.mockImplementation(async (id: string) => (id === SOURCE ? source({ orgId: null, partnerId: PARTNER }) : null));
    setLinks([link('onedrive_helper', null, { libraries: [] })]);

    const result = await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_B }, { permissions: ALL });

    expect(result).toEqual({ dryRun: false, policyId: NEW_ID, orgId: ORG_B, dropped: [] });
    expect(m.addFeatureLink.mock.calls.map((c) => c[1])).toEqual(['onedrive_helper']);
  });

  it('OneDrive Helper naming a Microsoft 365 tenant stays with its organization', async () => {
    setLinks([link('onedrive_helper', null, { tenantAssociationId: 'contoso-tenant', libraries: [] })]);

    const other = await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_B, dryRun: true }, { permissions: ALL });
    expect(other).toEqual({ dryRun: true, carried: [], dropped: [{ featureType: 'onedrive_helper', reason: 'linked_item_unavailable' }] });

    const same = await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A, dryRun: true }, { permissions: ALL });
    expect(same).toEqual({ dryRun: true, carried: ['onedrive_helper'], dropped: [] });

    setLinks([link('onedrive_helper', null, { libraries: [{ libraryId: 'lib-1', displayName: 'Docs' }] })]);
    const libraries = await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_B, dryRun: true }, { permissions: ALL });
    expect(libraries).toMatchObject({ dropped: [{ featureType: 'onedrive_helper', reason: 'linked_item_unavailable' }] });
  });

  it('a feature type the copy does not know is left behind, not carried', async () => {
    setLinks([link('alert_rule', null, { items: [] })]);
    const result = await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A, dryRun: true }, { permissions: ALL });
    expect(result).toEqual({ dryRun: true, carried: [], dropped: [{ featureType: 'alert_rule', reason: 'settings_not_valid' }] });
  });

  it('a dry run writes nothing', async () => {
    setLinks([link('patch', RING), link('onedrive_helper', null, { libraries: [] })]);

    const result = await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'partner', dryRun: true }, { permissions: ALL });

    expect(result).toEqual({ dryRun: true, carried: ['patch'], dropped: [{ featureType: 'onedrive_helper', reason: 'org_only_feature' }] });
    expect(m.createConfigPolicy).not.toHaveBeenCalled();
    expect(m.addFeatureLink).not.toHaveBeenCalled();
    expect(m.withDbTransaction).not.toHaveBeenCalled();
  });

  it('the dry run and the real run produce the same dropped list', async () => {
    const backupDest = 'ffffffff-0000-4000-8000-000000000001';
    setLinks([
      link('patch', RING),
      link('onedrive_helper', null, { libraries: [] }),
      link('software_policy', SW),
      link('monitors', null, { items: [{ monitorId: MONITOR }] }),
      link('backup', null, { destinationConfigId: backupDest }),
      link('helper', null, { branding: { primaryColor: 'not-a-colour' } }),
    ]);
    m.validateFeaturePolicyExists.mockImplementation(async (ft: string) => ({ valid: ft !== 'software_policy' }));
    m.isMonitorAttachableToOwner.mockResolvedValue(false);
    const input = { name: 'X', ownerScope: 'partner' as const };

    const dry = await copyConfigPolicy(partnerAuth(), SOURCE, { ...input, dryRun: true }, { permissions: ALL });
    const real = await copyConfigPolicy(partnerAuth(), SOURCE, input, { permissions: ALL });

    // In feature-type order, whatever order the source's links are read in.
    const expected = [
      { featureType: 'backup', reason: 'linked_item_unavailable' },
      { featureType: 'helper', reason: 'settings_not_valid' },
      { featureType: 'monitors', reason: 'linked_item_unavailable' },
      { featureType: 'onedrive_helper', reason: 'org_only_feature' },
      { featureType: 'software_policy', reason: 'linked_item_unavailable' },
    ];
    expect(dry).toMatchObject({ dryRun: true, carried: ['patch'], dropped: expected });
    expect(real).toMatchObject({ dryRun: false, dropped: expected });
    expect(m.addFeatureLink.mock.calls.map((c) => c[1])).toEqual(['patch']);
  });

  it('copy cannot read a source the caller cannot read', async () => {
    m.getConfigPolicy.mockResolvedValue(null);

    const err = await refusal(copyConfigPolicy(orgAuth(), SOURCE, { name: 'X', ownerScope: 'organization' }, { permissions: ALL }));

    expect(err.status).toBe(404);
    expect(m.getConfigPolicy).toHaveBeenCalledWith(SOURCE, expect.anything(), { access: 'read' });
    expect(m.createConfigPolicy).not.toHaveBeenCalled();
  });

  it('an organization caller copies an MSP-managed policy into its own organization', async () => {
    m.getConfigPolicy.mockImplementation(async (id: string) => (id === SOURCE ? source({ orgId: null, partnerId: PARTNER }) : null));

    const result = await copyConfigPolicy(orgAuth(), SOURCE, { name: 'Ours', ownerScope: 'organization' }, { permissions: ALL });

    expect(result).toMatchObject({ dryRun: false, policyId: NEW_ID });
    expect(m.createConfigPolicy).toHaveBeenCalledWith({ orgId: ORG_A, partnerId: null }, expect.anything(), 'user-2');
  });

  it('an organization caller cannot name another organization', async () => {
    const err = await refusal(copyConfigPolicy(orgAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_B }, { permissions: ALL }));
    expect(err.status).toBe(403);
    expect(m.createConfigPolicy).not.toHaveBeenCalled();
  });

  it('a partner caller cannot copy to an organization it cannot access', async () => {
    const auth = partnerAuth({ partnerOrgAccess: 'selected', accessibleOrgIds: [ORG_A], canAccessOrg: (o: string) => o === ORG_A });
    const err = await refusal(copyConfigPolicy(auth, SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_B }, { permissions: ALL }));
    expect(err.status).toBe(403);
  });

  it('a limited partner cannot copy to MSP-managed', async () => {
    const auth = partnerAuth({ partnerOrgAccess: 'selected', accessibleOrgIds: [ORG_A], canAccessOrg: (o: string) => o === ORG_A });
    const err = await refusal(copyConfigPolicy(auth, SOURCE, { name: 'X', ownerScope: 'partner', dryRun: true }, { permissions: ALL }));
    expect(err.status).toBe(403);
  });

  it('an organization caller cannot copy to MSP-managed', async () => {
    const err = await refusal(copyConfigPolicy(orgAuth(), SOURCE, { name: 'X', ownerScope: 'partner' }, { permissions: ALL }));
    expect(err.status).toBe(403);
  });

  it('a site-restricted caller cannot copy', async () => {
    const auth = { ...orgAuth(), allowedSiteIds: ['eeeeeeee-0000-4000-8000-0000000000aa'] } as unknown as AuthContext;
    const err = await refusal(copyConfigPolicy(auth, SOURCE, { name: 'X', ownerScope: 'organization', dryRun: true }, { permissions: ALL }));
    expect(err.status).toBe(403);
    expect(m.getConfigPolicy).not.toHaveBeenCalled();
  });

  it('a copy stays under the source policy\'s MSP', async () => {
    m.resolvePartnerIdForOrg.mockImplementation(async (orgId: string) => (orgId === ORG_B ? OTHER_PARTNER : PARTNER));
    const system = { scope: 'system', partnerId: null, orgId: null, user: { id: 'sys' }, canAccessOrg: () => true } as unknown as AuthContext;
    const err = await refusal(copyConfigPolicy(system, SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_B }, { permissions: ALL }));
    expect(err.status).toBe(400);
    expect(m.createConfigPolicy).not.toHaveBeenCalled();
  });

  describe('the parent', () => {
    it('omitted keeps the source\'s parent; null copies with none', async () => {
      m.getConfigPolicy.mockImplementation(async (id: string) => {
        if (id === SOURCE) return source({ parentPolicyId: PARENT });
        if (id === PARENT) return { id: PARENT, orgId: ORG_A, partnerId: null, parentPolicyId: null, featureLinks: [] };
        return null;
      });

      await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A }, { permissions: ALL });
      expect(m.createConfigPolicy).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ parentPolicyId: PARENT }), 'user-1');

      await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A, parentPolicyId: null }, { permissions: ALL });
      expect(m.createConfigPolicy.mock.calls.at(-1)?.[1]).not.toHaveProperty('parentPolicyId');
    });

    it('a parent the caller cannot read, or that the new owner may not inherit, is one 400', async () => {
      m.getConfigPolicy.mockImplementation(async (id: string) => {
        if (id === SOURCE) return source({ parentPolicyId: PARENT });
        // An org-owned parent of org A cannot parent a copy owned by org B.
        if (id === PARENT) return { id: PARENT, orgId: ORG_A, partnerId: null, parentPolicyId: null, featureLinks: [] };
        return null;
      });
      const incompatible = await refusal(copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_B, dryRun: true }, { permissions: ALL }));
      expect(incompatible.status).toBe(400);
      expect(incompatible.body).toMatchObject({ error: 'INVALID_PARENT_POLICY' });

      const hidden = await refusal(copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A, parentPolicyId: 'cccccccc-0000-4000-8000-0000000000ff' }, { permissions: ALL }));
      expect(hidden.status).toBe(400);
      expect(hidden.body).toEqual(incompatible.body);
      expect(m.getConfigPolicy).toHaveBeenCalledWith('cccccccc-0000-4000-8000-0000000000ff', expect.anything(), { access: 'read' });
    });
  });

  describe('copy re-runs the arming gates', () => {
    it('HP warranty collection needs devices.execute, and the copier records a fresh consent', async () => {
      const consent = { acceptedByUserId: 'someone-else', acceptedAt: '2026-01-01T00:00:00.000Z', eulaId: 'hp-cmsl-eula-v1' };
      setLinks([link('warranty', null, { enabled: true, hpCmsl: { enabled: true, consent } })]);

      const denied = await refusal(copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A, dryRun: true }, { permissions: WRITE_ONLY }));
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ code: 'HP_CMSL_EXECUTE_REQUIRED' });

      await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A }, { permissions: ALL });
      const [, , , settings, actor] = m.addFeatureLink.mock.calls[0]!;
      // The source's recorded acceptance is never carried: addFeatureLink stamps the copier.
      expect((settings as { hpCmsl: Record<string, unknown> }).hpCmsl).toEqual({ enabled: true });
      expect(actor).toEqual({ userId: 'user-1' });
    });

    it('auto-quarantine needs devices.execute, and the authority is the copier\'s', async () => {
      setLinks([link('security', null, { autoQuarantine: true })]);

      const denied = await refusal(copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A }, { permissions: WRITE_ONLY }));
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ code: 'AUTO_QUARANTINE_EXECUTE_REQUIRED' });
      expect(m.createConfigPolicy).not.toHaveBeenCalled();

      await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A }, { permissions: ALL });
      const options = m.addFeatureLink.mock.calls[0]![6] as { executionAuthority?: { executionAuthorityUserId?: string | null } };
      // Captured from this session, for the copier: never the source author's.
      expect(options.executionAuthority?.executionAuthorityUserId).toBe('user-1');
    });

    it('vendor updates and security agents arm only for devices.execute', async () => {
      setLinks([
        link('security_agents', null, { version: 1, agents: [{ vendor: 'sentinelone', enabled: true, platforms: ['windows'] }] }),
      ]);
      const denied = await refusal(copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A, dryRun: true }, { permissions: WRITE_ONLY }));
      expect(denied.status).toBe(403);
    });

    it('a parent that collects HP warranty data, or arms vendor updates, is gated like a create', async () => {
      m.getConfigPolicy.mockImplementation(async (id: string) => {
        if (id === SOURCE) return source({ parentPolicyId: PARENT });
        if (id === PARENT) return { id: PARENT, orgId: ORG_A, partnerId: null, parentPolicyId: null, featureLinks: [] };
        return null;
      });
      m.parentPolicyEnablesHpCmslCollection.mockResolvedValue(true);
      const hp = await refusal(copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A }, { permissions: WRITE_ONLY }));
      expect(hp.body).toMatchObject({ code: 'HP_CMSL_EXECUTE_REQUIRED' });

      m.parentPolicyEnablesHpCmslCollection.mockResolvedValue(false);
      m.parentPolicyArmsOemUpdates.mockResolvedValue(true);
      const oem = await refusal(copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A }, { permissions: WRITE_ONLY }));
      expect(oem.status).toBe(403);
      expect(m.createConfigPolicy).not.toHaveBeenCalled();
    });

    it('fails closed when permissions were not resolved', async () => {
      setLinks([link('warranty', null, { enabled: true, hpCmsl: { enabled: true } })]);
      const err = await refusal(copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A }, {}));
      expect(err.status).toBe(403);
    });
  });

  describe('references inside settings are checked for the new owner', () => {
    it('an automation whose script the new owner cannot use is dropped', async () => {
      setLinks([
        link('automation', null, { items: [{ name: 'a', actions: [{ type: 'run_script', scriptId: 'eeeeeeee-0000-4000-8000-000000000009' }] }] }),
      ]);
      m.resolveAutomationReferencesForOwner.mockRejectedValue(new AutomationReferenceAuthorizationError());

      const result = await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_B, dryRun: true }, { permissions: ALL });

      expect(result).toEqual({ dryRun: true, carried: [], dropped: [{ featureType: 'automation', reason: 'linked_item_unavailable' }] });
      expect(m.resolveAutomationReferencesForOwner).toHaveBeenCalledWith(expect.anything(), { orgId: ORG_B, partnerId: null }, expect.any(Array));
    });

    it('a compliance remediation script the new owner cannot use is dropped', async () => {
      const scriptId = 'eeeeeeee-0000-4000-8000-00000000000a';
      setLinks([
        link('compliance', null, { items: [{ name: 'c', rules: [{ type: 'required_software', softwareName: 'x', remediation: { type: 'script', scriptId } }] }] }),
      ]);
      m.resolveAutomationReferencesForOwner.mockRejectedValue(new AutomationReferenceAuthorizationError());

      const result = await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_B, dryRun: true }, { permissions: ALL });

      expect(result).toMatchObject({ dropped: [{ featureType: 'compliance', reason: 'linked_item_unavailable' }] });
      const actions = m.resolveAutomationReferencesForOwner.mock.calls[0]![2] as Array<Record<string, unknown>>;
      expect(actions).toEqual([expect.objectContaining({ type: 'run_script', scriptId })]);
    });

    it('a rule set the new owner cannot fetch is dropped; a malformed list is not valid', async () => {
      setLinks([link('security', null, { autoQuarantine: false, ruleSetIds: ['x'] })]);
      m.checkSecurityRuleSetsWrite.mockResolvedValueOnce({ ok: false, status: 400, body: { error: 'e', code: 'YARA_RULE_SET_NOT_ATTACHABLE' } });
      const missing = await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'partner', dryRun: true }, { permissions: ALL });
      expect(missing).toMatchObject({ dropped: [{ featureType: 'security', reason: 'linked_item_unavailable' }] });

      m.checkSecurityRuleSetsWrite.mockResolvedValueOnce({ ok: false, status: 400, body: { error: 'e', code: 'INVALID_RULE_SET_IDS' } });
      const malformed = await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'partner', dryRun: true }, { permissions: ALL });
      expect(malformed).toMatchObject({ dropped: [{ featureType: 'security', reason: 'settings_not_valid' }] });
    });

    it('a monitor the caller cannot see is dropped with the same reason as one the owner cannot attach', async () => {
      setLinks([link('monitors', null, { items: [{ monitorId: MONITOR }] })]);
      m.getMonitorDefinition.mockResolvedValue(null);
      const result = await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A, dryRun: true }, { permissions: ALL });
      expect(result).toMatchObject({ dropped: [{ featureType: 'monitors', reason: 'linked_item_unavailable' }] });
      expect(m.isMonitorAttachableToOwner).not.toHaveBeenCalled();
    });

    it('a backup destination must be the new organization\'s', async () => {
      const dest = 'ffffffff-0000-4000-8000-000000000002';
      setLinks([link('backup', null, { destinationConfigId: dest })]);

      m.dbRows = [[]];
      const other = await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_B, dryRun: true }, { permissions: ALL });
      expect(other).toMatchObject({ dropped: [{ featureType: 'backup', reason: 'linked_item_unavailable' }] });

      m.dbRows = [[{ id: dest }]];
      const same = await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A, dryRun: true }, { permissions: ALL });
      expect(same).toEqual({ dryRun: true, carried: ['backup'], dropped: [] });
    });
  });

  describe('review round (#12572)', () => {
    it('stored settings the write would refuse are left behind in both modes', async () => {
      // Two rule sets with one name: saved before that rule, refused by the write today.
      setLinks([
        link('compliance', null, { items: [{ name: 'Same', rules: [] }, { name: 'Same', rules: [] }] }),
        link('maintenance', null, { recurrence: 'never-ever' }),
        link('event_log', null, { retentionDays: 30 }),
      ]);
      const input = { name: 'X', ownerScope: 'organization' as const, orgId: ORG_A };

      const dry = await copyConfigPolicy(partnerAuth(), SOURCE, { ...input, dryRun: true }, { permissions: ALL });
      const real = await copyConfigPolicy(partnerAuth(), SOURCE, input, { permissions: ALL });

      const expected = [
        { featureType: 'compliance', reason: 'settings_not_valid' },
        { featureType: 'maintenance', reason: 'settings_not_valid' },
      ];
      expect(dry).toEqual({ dryRun: true, carried: ['event_log'], dropped: expected });
      expect(real).toMatchObject({ dryRun: false, dropped: expected });
      expect(m.addFeatureLink.mock.calls.map((c) => c[1])).toEqual(['event_log']);
    });

    it('a helper link with no enabled key is copied off, as it resolves today', async () => {
      setLinks([link('helper', null, { showOpenPortal: true })]);
      await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A }, { permissions: ALL });
      expect(m.addFeatureLink.mock.calls[0]![3]).toEqual({ showOpenPortal: true, enabled: false });

      m.addFeatureLink.mockClear();
      setLinks([link('helper', null, { enabled: true })]);
      await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A }, { permissions: ALL });
      expect(m.addFeatureLink.mock.calls[0]![3]).toEqual({ enabled: true });
    });

    it('vendor updates: armed only for devices.execute, compared with the NEW parent\'s link', async () => {
      const parentSettings = { version: 1, enabled: true };
      m.getConfigPolicy.mockImplementation(async (id: string) => {
        if (id === SOURCE) return source();
        if (id === PARENT) {
          return { id: PARENT, orgId: ORG_A, partnerId: null, parentPolicyId: null, featureLinks: [link('oem_updates', null, parentSettings)] };
        }
        return null;
      });
      setLinks([link('oem_updates', null, { version: 1, enabled: true })]);
      const input = { name: 'X', ownerScope: 'organization' as const, orgId: ORG_A, parentPolicyId: PARENT };

      m.checkOemUpdatesLinkWrite.mockReturnValueOnce({ ok: false, refusal: { status: 403, body: { code: 'oem_updates_execute_required' } } });
      const denied = await refusal(copyConfigPolicy(partnerAuth(), SOURCE, input, { permissions: WRITE_ONLY }));
      expect(denied.status).toBe(403);
      expect(m.checkOemUpdatesLinkWrite).toHaveBeenLastCalledWith(expect.objectContaining({ armAuthorized: false, previous: parentSettings }));
      expect(m.createConfigPolicy).not.toHaveBeenCalled();

      m.checkOemUpdatesLinkWrite.mockReturnValueOnce({ ok: true, inlineSettings: { version: 1, enabled: true, checked: true } });
      await copyConfigPolicy(partnerAuth(), SOURCE, input, { permissions: ALL });
      expect(m.checkOemUpdatesLinkWrite).toHaveBeenLastCalledWith(expect.objectContaining({ armAuthorized: true }));
      expect(m.addFeatureLink.mock.calls[0]![3]).toEqual({ version: 1, enabled: true, checked: true });
      expect(m.addFeatureLink.mock.calls[0]![6]).toEqual({ oemUpdatesArmAuthorized: true });

      m.checkOemUpdatesLinkWrite.mockReturnValueOnce({ ok: false, refusal: { status: 400, body: { code: 'closed' } } });
      const closed = await copyConfigPolicy(partnerAuth(), SOURCE, { ...input, dryRun: true }, { permissions: ALL });
      expect(closed).toEqual({ dryRun: true, carried: [], dropped: [{ featureType: 'oem_updates', reason: 'settings_not_valid' }] });
    });

    it('security agents: a package missing from the catalog is left behind; an armed carry says so', async () => {
      const agents = { version: 1, agents: [{ vendor: 'huntress', enabled: true, platforms: ['windows'] }] };
      setLinks([link('security_agents', null, agents)]);
      const result = await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A, dryRun: true }, { permissions: ALL });
      expect(result).toEqual({ dryRun: true, carried: [], dropped: [{ featureType: 'security_agents', reason: 'linked_item_unavailable' }] });

      setLinks([link('security_agents', null, { version: 1, agents: [] })]);
      await copyConfigPolicy(partnerAuth(), SOURCE, { name: 'X', ownerScope: 'organization', orgId: ORG_A }, { permissions: ALL });
      expect(m.addFeatureLink.mock.calls[0]![6]).toEqual({ securityAgentsArmAuthorized: true });
    });

    it('a write-time refusal is mapped and rolled back; anything else propagates', async () => {
      setLinks([link('event_log', null, { retentionDays: 30 })]);
      const input = { name: 'X', ownerScope: 'organization' as const, orgId: ORG_A };
      const cases: Array<[Error, number]> = [
        [new InvalidParentPolicyError(), 400],
        [new SecurityAgentsLinkWriteError({ status: 403, body: { code: 'x' } } as never), 403],
        [new AutomationReferenceAuthorizationError(), 400],
        [new BackupDestinationNotInOrgError(), 400],
        [new WarrantyConsentError('x'), 400],
      ];
      for (const [error, status] of cases) {
        m.addFeatureLink.mockRejectedValueOnce(error);
        const err = await refusal(copyConfigPolicy(partnerAuth(), SOURCE, input, { permissions: ALL }));
        expect(err.status, error.name).toBe(status);
      }
      m.addFeatureLink.mockRejectedValueOnce(new Error('database went away'));
      await expect(copyConfigPolicy(partnerAuth(), SOURCE, input, { permissions: ALL })).rejects.toThrow('database went away');
      // A duplicate link means the plan is wrong: an error, never a refusal.
      m.addFeatureLink.mockResolvedValueOnce(null);
      await expect(copyConfigPolicy(partnerAuth(), SOURCE, input, { permissions: ALL })).rejects.toThrow(/planned the event_log feature twice/);
      // Every attempt ran inside the one transaction.
      expect(m.withDbTransaction).toHaveBeenCalledTimes(cases.length + 2);
    });
  });
});
