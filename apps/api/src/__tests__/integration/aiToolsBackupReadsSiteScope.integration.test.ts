/**
 * Integration test — site/org scope for the backup, DR, Hyper-V, MSSQL,
 * vault and SLA AI read tools.
 *
 * Mirrors the pattern in `aiToolsAuditDetailsSiteScope.integration.test.ts`:
 * real Postgres via `withDbAccessContext`, as the unprivileged `breeze_app`
 * role, so org-axis RLS is genuinely enforced while the site axis (which RLS
 * does NOT defend) is exercised app-layer. Each tool family is registered
 * into a local `Map` via its own `registerXTools`, not the full aiTools
 * registry.
 *
 * Per tool, the standard four cases:
 *   (i)   a site-restricted caller gets no row / not-found for an
 *         out-of-site object;
 *   (ii)  the same caller sees the in-site object (non-vacuous control);
 *   (iii) a cross-org id is not found;
 *   (iv)  an unrestricted caller sees both.
 *
 * Every table seeded here (backup_configs, backup_jobs, backup_snapshots,
 * sql_instances, backup_chains, hyperv_vms, local_vaults,
 * backup_sla_configs, backup_sla_events, dr_plans, dr_plan_groups,
 * dr_executions, devices) sits in the FK closure under `organizations`,
 * which `cleanupDatabase()` TRUNCATEs CASCADE before every test (see
 * `setup.ts`) — unlike `audit_logs` (append-only, survives TRUNCATE), so no
 * per-test marker is needed here to avoid cross-test bleed.
 *
 * `query_backups` (list_jobs) and `query_vaults` also cover the null-org
 * fail-closed path: a site-restricted caller whose org can never be
 * resolved (`auth.orgId` null, `accessibleOrgIds` empty) gets an empty
 * result rather than an unfiltered query. With the `!orgId` early return in
 * `aiToolsBackup.ts` or `aiToolsVault.ts` commented out, the matching case
 * fails.
 *
 * DR route-level site scope (list narrowing, plan/execution 404s, current
 * device-site-move tracking) is already proven end-to-end against the REST
 * routes in `drReadSiteScope.integration.test.ts`. The DR block here adds
 * only tool-path cases, proving the AI tool handlers apply the same
 * guarantee — kept light, not a full re-derivation.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { withDbAccessContext } from '../../db';
import {
  devices,
  backupConfigs,
  backupJobs,
  backupSnapshots,
  sqlInstances,
  backupChains,
  hypervVms,
  localVaults,
  backupSlaConfigs,
  backupSlaEvents,
  drPlans,
  drPlanGroups,
  drExecutions,
} from '../../db/schema';
import { createPartner, createOrganization, createSite } from './db-utils';
import { getTestDb } from './setup';
import { registerBackupTools } from '../../services/aiToolsBackup';
import { registerBackupVmTools } from '../../services/aiToolsBackupVm';
import { registerMssqlTools } from '../../services/aiToolsMssql';
import { registerHypervTools } from '../../services/aiToolsHyperv';
import { registerVaultTools } from '../../services/aiToolsVault';
import { registerSLABackupTools } from '../../services/aiToolsSLABackup';
import { registerDRTools } from '../../services/aiToolsDR';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';

// ============================================
// Tool registration helpers
// ============================================

function toolHandlers(register: (m: Map<string, AiTool>) => void): Map<string, AiTool['handler']> {
  const reg = new Map<string, AiTool>();
  register(reg);
  const handlers = new Map<string, AiTool['handler']>();
  for (const [name, tool] of reg) handlers.set(name, tool.handler);
  return handlers;
}

const backupHandlers = () => toolHandlers(registerBackupTools);
const backupVmHandlers = () => toolHandlers(registerBackupVmTools);
const mssqlHandlers = () => toolHandlers(registerMssqlTools);
const hypervHandlers = () => toolHandlers(registerHypervTools);
const vaultHandlers = () => toolHandlers(registerVaultTools);
const slaHandlers = () => toolHandlers(registerSLABackupTools);
const drHandlers = () => toolHandlers(registerDRTools);

// ============================================
// AuthContext builders
// ============================================

// Build an org-scope AuthContext. `allowedSiteIds` (+ canAccessSite) makes
// the caller site-restricted; omit them for an unrestricted caller.
function makeAuth(orgId: string, allowedSiteIds?: string[]): AuthContext {
  return {
    // DR's drReadSiteCeiling keys the restricted-vs-unrestricted branch off
    // principal.kind (isSiteRestrictedPrincipalKind) — without it, an
    // unrecognised kind reads as denied-outright ([]), not "unrestricted".
    principal: { kind: 'user_session' },
    user: { id: randomUUID(), email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    // Handlers filter on the org axis via orgCondition; under breeze_app RLS
    // the row is also gated by org access, so a no-op condition is the
    // realistic shape (mirrors aiToolsAuditDetailsSiteScope's makeAuth).
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds,
    allowedDeviceIds: undefined,
    canAccessSite: (s: string | null | undefined) =>
      !allowedSiteIds ? true : !!s && allowedSiteIds.includes(s),
  } as unknown as AuthContext;
}

// A site-restricted caller whose org can never be resolved: `orgId` null,
// `accessibleOrgIds` empty. Exercises the null-org fail-closed branches.
function makeNullOrgAuth(allowedSiteIds: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: randomUUID(), email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: null,
    scope: 'organization',
    accessibleOrgIds: [],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds,
    allowedDeviceIds: undefined,
    canAccessSite: (s: string | null | undefined) => !!s && allowedSiteIds.includes(s),
  } as unknown as AuthContext;
}

// ============================================
// Seeding helpers
// ============================================

async function seedDevice(orgId: string, siteId: string) {
  const [d] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-${randomUUID()}`,
      hostname: `host-${randomUUID().slice(0, 8)}`,
      osType: 'linux',
      osVersion: '1.0',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
    })
    .returning();
  return d!;
}

async function seedBackupConfig(orgId: string) {
  const [c] = await getTestDb()
    .insert(backupConfigs)
    .values({
      orgId,
      name: `cfg-${randomUUID().slice(0, 8)}`,
      type: 'file',
      provider: 'local',
      providerConfig: {},
    })
    .returning();
  return c!;
}

async function seedBackupJob(orgId: string, configId: string, deviceId: string) {
  const [j] = await getTestDb()
    .insert(backupJobs)
    .values({
      orgId,
      configId,
      deviceId,
      status: 'completed',
      type: 'manual',
    })
    .returning();
  return j!;
}

async function seedSnapshot(orgId: string, jobId: string, deviceId: string) {
  const [s] = await getTestDb()
    .insert(backupSnapshots)
    .values({
      orgId,
      jobId,
      deviceId,
      snapshotId: `snap-${randomUUID()}`,
      label: 'test snapshot',
      size: 1024 * 1024,
    })
    .returning();
  return s!;
}

async function seedSqlInstance(orgId: string, deviceId: string) {
  const [row] = await getTestDb()
    .insert(sqlInstances)
    .values({
      orgId,
      deviceId,
      instanceName: `INST-${randomUUID().slice(0, 8)}`,
    })
    .returning();
  return row!;
}

async function seedBackupChain(orgId: string, configId: string, deviceId: string) {
  const [row] = await getTestDb()
    .insert(backupChains)
    .values({
      orgId,
      deviceId,
      configId,
      chainType: 'mssql',
      targetName: `db-${randomUUID().slice(0, 8)}`,
    })
    .returning();
  return row!;
}

async function seedHypervVm(orgId: string, deviceId: string) {
  const [row] = await getTestDb()
    .insert(hypervVms)
    .values({
      orgId,
      deviceId,
      vmId: `vm-${randomUUID().slice(0, 8)}`,
      vmName: `VM-${randomUUID().slice(0, 8)}`,
    })
    .returning();
  return row!;
}

async function seedVault(orgId: string, deviceId: string) {
  const [row] = await getTestDb()
    .insert(localVaults)
    .values({
      orgId,
      deviceId,
      vaultPath: `/vault/${randomUUID().slice(0, 8)}`,
    })
    .returning();
  return row!;
}

async function seedSlaConfig(orgId: string) {
  const [row] = await getTestDb()
    .insert(backupSlaConfigs)
    .values({
      orgId,
      name: `sla-${randomUUID().slice(0, 8)}`,
      rpoTargetMinutes: 60,
      rtoTargetMinutes: 120,
    })
    .returning();
  return row!;
}

async function seedSlaEvent(orgId: string, slaConfigId: string, deviceId: string) {
  const [row] = await getTestDb()
    .insert(backupSlaEvents)
    .values({
      orgId,
      slaConfigId,
      deviceId,
      eventType: 'missed_backup',
    })
    .returning();
  return row!;
}

async function seedDrPlan(orgId: string, name: string) {
  const [p] = await getTestDb().insert(drPlans).values({ orgId, name }).returning();
  return p!;
}

async function seedDrPlanGroup(orgId: string, planId: string, deviceIds: string[]) {
  const [g] = await getTestDb()
    .insert(drPlanGroups)
    .values({ orgId, planId, name: 'group', devices: deviceIds })
    .returning();
  return g!;
}

async function seedDrExecution(orgId: string, planId: string) {
  const [e] = await getTestDb()
    .insert(drExecutions)
    .values({ orgId, planId, executionType: 'rehearsal' })
    .returning();
  return e!;
}

// Runs `handler(input, auth)` inside an org-scope DB context and returns the
// named array field of the parsed JSON response (defaulting to `[]`).
async function listRows(
  handler: AiTool['handler'],
  auth: AuthContext,
  orgId: string | null,
  input: Record<string, unknown>,
  rowsKey: string,
): Promise<any[]> {
  const raw = await withDbAccessContext(
    { scope: 'organization', orgId, accessibleOrgIds: orgId ? [orgId] : [] },
    () => handler(input, auth),
  );
  const parsed = JSON.parse(raw);
  return parsed[rowsKey] ?? [];
}

async function callTool(
  handler: AiTool['handler'],
  auth: AuthContext,
  orgId: string | null,
  input: Record<string, unknown>,
): Promise<any> {
  const raw = await withDbAccessContext(
    { scope: 'organization', orgId, accessibleOrgIds: orgId ? [orgId] : [] },
    () => handler(input, auth),
  );
  return JSON.parse(raw);
}

// ============================================
// query_backups (list_jobs) — device/site scope + null-org fail-closed
// ============================================

describe('query_backups action=list_jobs — device/site scope', () => {
  it('site-restricted caller sees only in-site jobs; unrestricted sees all in-org jobs; a cross-org device filter returns nothing', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const otherSite = await createSite({ orgId: otherOrg.id });

    const devIn = await seedDevice(org.id, siteAllowed.id);
    const devOut = await seedDevice(org.id, siteForbidden.id);
    const devOther = await seedDevice(otherOrg.id, otherSite.id);

    const cfg = await seedBackupConfig(org.id);
    const jobIn = await seedBackupJob(org.id, cfg.id, devIn.id);
    const jobOut = await seedBackupJob(org.id, cfg.id, devOut.id);
    const cfgOther = await seedBackupConfig(otherOrg.id);
    await seedBackupJob(otherOrg.id, cfgOther.id, devOther.id);

    const handler = backupHandlers().get('query_backups')!;

    // (i) + (ii)
    const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);
    const restricted = await listRows(handler, restrictedAuth, org.id, { action: 'list_jobs', limit: 100 }, 'jobs');
    const restrictedIds = restricted.map((j: any) => j.id);
    expect(restrictedIds).toContain(jobIn.id);
    expect(restrictedIds).not.toContain(jobOut.id);

    // (iii) cross-org device filter
    const crossOrg = await listRows(
      handler,
      restrictedAuth,
      org.id,
      { action: 'list_jobs', deviceId: devOther.id, limit: 100 },
      'jobs',
    );
    expect(crossOrg).toEqual([]);

    // (iv) unrestricted caller sees both in-org jobs
    const unrestrictedAuth = makeAuth(org.id);
    const unrestricted = await listRows(handler, unrestrictedAuth, org.id, { action: 'list_jobs', limit: 100 }, 'jobs');
    const unrestrictedIds = unrestricted.map((j: any) => j.id);
    expect(unrestrictedIds).toEqual(expect.arrayContaining([jobIn.id, jobOut.id]));
  });

  it('fails closed when a site-restricted caller has no resolvable org: empty result, not an unfiltered query', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const dev = await seedDevice(org.id, site.id);
    const cfg = await seedBackupConfig(org.id);
    await seedBackupJob(org.id, cfg.id, dev.id);

    const handler = backupHandlers().get('query_backups')!;
    const nullOrgAuth = makeNullOrgAuth([site.id]);

    const result = await callTool(handler, nullOrgAuth, null, { action: 'list_jobs', limit: 100 });
    expect(result).toEqual({ jobs: [], showing: 0 });
  });
});

// ============================================
// get_backup_status — device/site scope
// ============================================

describe('get_backup_status — device site scope', () => {
  it('denies an out-of-site device, allows the in-site device, an unrestricted caller sees both, a cross-org device is not found', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const otherSite = await createSite({ orgId: otherOrg.id });

    const devIn = await seedDevice(org.id, siteAllowed.id);
    const devOut = await seedDevice(org.id, siteForbidden.id);
    const devOther = await seedDevice(otherOrg.id, otherSite.id);

    const handler = backupHandlers().get('get_backup_status')!;
    const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);

    const denied = await callTool(handler, restrictedAuth, org.id, { deviceId: devOut.id });
    expect(denied.error).toBeDefined();

    const allowed = await callTool(handler, restrictedAuth, org.id, { deviceId: devIn.id });
    expect(allowed.error).toBeUndefined();
    expect(allowed.deviceId).toBe(devIn.id);

    const crossOrg = await callTool(handler, restrictedAuth, org.id, { deviceId: devOther.id });
    expect(crossOrg.error).toBeDefined();

    const unrestrictedAuth = makeAuth(org.id);
    const bothForUnrestricted = await Promise.all([
      callTool(handler, unrestrictedAuth, org.id, { deviceId: devIn.id }),
      callTool(handler, unrestrictedAuth, org.id, { deviceId: devOut.id }),
    ]);
    expect(bothForUnrestricted[0].error).toBeUndefined();
    expect(bothForUnrestricted[1].error).toBeUndefined();
  });
});

// ============================================
// browse_snapshots — device/site scope
// ============================================

describe('browse_snapshots — device site scope', () => {
  it('denies an out-of-site device, allows the in-site device, an unrestricted caller sees both, a cross-org device is not found', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const otherSite = await createSite({ orgId: otherOrg.id });

    const devIn = await seedDevice(org.id, siteAllowed.id);
    const devOut = await seedDevice(org.id, siteForbidden.id);
    const devOther = await seedDevice(otherOrg.id, otherSite.id);
    const cfg = await seedBackupConfig(org.id);
    const jobIn = await seedBackupJob(org.id, cfg.id, devIn.id);
    await seedSnapshot(org.id, jobIn.id, devIn.id);

    const handler = backupHandlers().get('browse_snapshots')!;
    const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);

    const denied = await callTool(handler, restrictedAuth, org.id, { deviceId: devOut.id });
    expect(denied.error).toBeDefined();

    const allowed = await callTool(handler, restrictedAuth, org.id, { deviceId: devIn.id });
    expect(allowed.error).toBeUndefined();
    expect(allowed.snapshots.length).toBe(1);

    const crossOrg = await callTool(handler, restrictedAuth, org.id, { deviceId: devOther.id });
    expect(crossOrg.error).toBeDefined();

    const unrestrictedAuth = makeAuth(org.id);
    const unrestrictedOut = await callTool(handler, unrestrictedAuth, org.id, { deviceId: devOut.id });
    expect(unrestrictedOut.error).toBeUndefined();
  });
});

// ============================================
// get_vm_restore_estimate — snapshot resolves to a site-scoped device
// ============================================

describe('get_vm_restore_estimate — snapshot device site scope', () => {
  it('denies an out-of-site snapshot, allows the in-site one, an unrestricted caller sees both, a cross-org snapshot is not found', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const otherSite = await createSite({ orgId: otherOrg.id });

    const devIn = await seedDevice(org.id, siteAllowed.id);
    const devOut = await seedDevice(org.id, siteForbidden.id);
    const devOther = await seedDevice(otherOrg.id, otherSite.id);

    const cfg = await seedBackupConfig(org.id);
    const jobIn = await seedBackupJob(org.id, cfg.id, devIn.id);
    const jobOut = await seedBackupJob(org.id, cfg.id, devOut.id);
    const snapIn = await seedSnapshot(org.id, jobIn.id, devIn.id);
    const snapOut = await seedSnapshot(org.id, jobOut.id, devOut.id);
    const cfgOther = await seedBackupConfig(otherOrg.id);
    const jobOther = await seedBackupJob(otherOrg.id, cfgOther.id, devOther.id);
    const snapOther = await seedSnapshot(otherOrg.id, jobOther.id, devOther.id);

    const handler = backupVmHandlers().get('get_vm_restore_estimate')!;
    const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);

    const denied = await callTool(handler, restrictedAuth, org.id, { snapshotId: snapOut.id });
    expect(denied.error).toBeDefined();

    const allowed = await callTool(handler, restrictedAuth, org.id, { snapshotId: snapIn.id });
    expect(allowed.error).toBeUndefined();

    const crossOrg = await callTool(handler, restrictedAuth, org.id, { snapshotId: snapOther.id });
    expect(crossOrg.error).toBeDefined();

    const unrestrictedAuth = makeAuth(org.id);
    const unrestrictedOut = await callTool(handler, unrestrictedAuth, org.id, { snapshotId: snapOut.id });
    expect(unrestrictedOut.error).toBeUndefined();
  });
});

// ============================================
// query_mssql_instances — device/site scope
// ============================================

describe('query_mssql_instances — device site scope', () => {
  it('narrows to in-site devices; unrestricted sees all; a cross-org device filter returns nothing', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const otherSite = await createSite({ orgId: otherOrg.id });

    const devIn = await seedDevice(org.id, siteAllowed.id);
    const devOut = await seedDevice(org.id, siteForbidden.id);
    const devOther = await seedDevice(otherOrg.id, otherSite.id);

    const instIn = await seedSqlInstance(org.id, devIn.id);
    const instOut = await seedSqlInstance(org.id, devOut.id);
    await seedSqlInstance(otherOrg.id, devOther.id);

    const handler = mssqlHandlers().get('query_mssql_instances')!;
    const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);

    const restricted = await listRows(handler, restrictedAuth, org.id, { limit: 100 }, 'instances');
    const restrictedIds = restricted.map((i: any) => i.id);
    expect(restrictedIds).toContain(instIn.id);
    expect(restrictedIds).not.toContain(instOut.id);

    const crossOrg = await listRows(handler, restrictedAuth, org.id, { deviceId: devOther.id, limit: 100 }, 'instances');
    expect(crossOrg).toEqual([]);

    const unrestrictedAuth = makeAuth(org.id);
    const unrestricted = await listRows(handler, unrestrictedAuth, org.id, { limit: 100 }, 'instances');
    const unrestrictedIds = unrestricted.map((i: any) => i.id);
    expect(unrestrictedIds).toEqual(expect.arrayContaining([instIn.id, instOut.id]));
  });
});

// ============================================
// get_mssql_backup_status — device/site scope
// ============================================

describe('get_mssql_backup_status — device site scope', () => {
  it('narrows to in-site devices; unrestricted sees all; a cross-org device filter returns nothing', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const otherSite = await createSite({ orgId: otherOrg.id });

    const devIn = await seedDevice(org.id, siteAllowed.id);
    const devOut = await seedDevice(org.id, siteForbidden.id);
    const devOther = await seedDevice(otherOrg.id, otherSite.id);

    const cfg = await seedBackupConfig(org.id);
    const chainIn = await seedBackupChain(org.id, cfg.id, devIn.id);
    const chainOut = await seedBackupChain(org.id, cfg.id, devOut.id);
    const cfgOther = await seedBackupConfig(otherOrg.id);
    await seedBackupChain(otherOrg.id, cfgOther.id, devOther.id);

    const handler = mssqlHandlers().get('get_mssql_backup_status')!;
    const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);

    const restricted = await listRows(handler, restrictedAuth, org.id, { limit: 100 }, 'chains');
    const restrictedIds = restricted.map((c: any) => c.id);
    expect(restrictedIds).toContain(chainIn.id);
    expect(restrictedIds).not.toContain(chainOut.id);

    const crossOrg = await listRows(handler, restrictedAuth, org.id, { deviceId: devOther.id, limit: 100 }, 'chains');
    expect(crossOrg).toEqual([]);

    const unrestrictedAuth = makeAuth(org.id);
    const unrestricted = await listRows(handler, unrestrictedAuth, org.id, { limit: 100 }, 'chains');
    const unrestrictedIds = unrestricted.map((c: any) => c.id);
    expect(unrestrictedIds).toEqual(expect.arrayContaining([chainIn.id, chainOut.id]));
  });
});

// ============================================
// query_hyperv_vms — device/site scope
// ============================================

describe('query_hyperv_vms — device site scope', () => {
  it('narrows to in-site host devices; unrestricted sees all; a cross-org device filter returns nothing', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const otherSite = await createSite({ orgId: otherOrg.id });

    const devIn = await seedDevice(org.id, siteAllowed.id);
    const devOut = await seedDevice(org.id, siteForbidden.id);
    const devOther = await seedDevice(otherOrg.id, otherSite.id);

    const vmIn = await seedHypervVm(org.id, devIn.id);
    const vmOut = await seedHypervVm(org.id, devOut.id);
    await seedHypervVm(otherOrg.id, devOther.id);

    const handler = hypervHandlers().get('query_hyperv_vms')!;
    const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);

    const restricted = await listRows(handler, restrictedAuth, org.id, { limit: 100 }, 'vms');
    const restrictedIds = restricted.map((v: any) => v.id);
    expect(restrictedIds).toContain(vmIn.id);
    expect(restrictedIds).not.toContain(vmOut.id);

    const crossOrg = await listRows(handler, restrictedAuth, org.id, { deviceId: devOther.id, limit: 100 }, 'vms');
    expect(crossOrg).toEqual([]);

    const unrestrictedAuth = makeAuth(org.id);
    const unrestricted = await listRows(handler, unrestrictedAuth, org.id, { limit: 100 }, 'vms');
    const unrestrictedIds = unrestricted.map((v: any) => v.id);
    expect(unrestrictedIds).toEqual(expect.arrayContaining([vmIn.id, vmOut.id]));
  });
});

// ============================================
// get_hyperv_vm_details — device/site scope (test axis: vmId)
// ============================================

describe('get_hyperv_vm_details — host device site scope', () => {
  it('denies a VM on an out-of-site host, allows the in-site one, an unrestricted caller sees both, a cross-org vmId is not found', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const otherSite = await createSite({ orgId: otherOrg.id });

    const devIn = await seedDevice(org.id, siteAllowed.id);
    const devOut = await seedDevice(org.id, siteForbidden.id);
    const devOther = await seedDevice(otherOrg.id, otherSite.id);

    const vmIn = await seedHypervVm(org.id, devIn.id);
    const vmOut = await seedHypervVm(org.id, devOut.id);
    const vmOther = await seedHypervVm(otherOrg.id, devOther.id);

    const handler = hypervHandlers().get('get_hyperv_vm_details')!;
    const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);

    const denied = await callTool(handler, restrictedAuth, org.id, { vmId: vmOut.id });
    expect(denied.error).toBeDefined();

    const allowed = await callTool(handler, restrictedAuth, org.id, { vmId: vmIn.id });
    expect(allowed.error).toBeUndefined();
    expect(allowed.id).toBe(vmIn.id);

    const crossOrg = await callTool(handler, restrictedAuth, org.id, { vmId: vmOther.id });
    expect(crossOrg.error).toBeDefined();

    const unrestrictedAuth = makeAuth(org.id);
    const unrestrictedOut = await callTool(handler, unrestrictedAuth, org.id, { vmId: vmOut.id });
    expect(unrestrictedOut.error).toBeUndefined();
  });
});

// ============================================
// query_vaults — device/site scope + null-org fail-closed
// ============================================

describe('query_vaults — device site scope', () => {
  it('narrows to in-site devices; unrestricted sees all; a cross-org device filter returns nothing', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const otherSite = await createSite({ orgId: otherOrg.id });

    const devIn = await seedDevice(org.id, siteAllowed.id);
    const devOut = await seedDevice(org.id, siteForbidden.id);
    const devOther = await seedDevice(otherOrg.id, otherSite.id);

    const vaultIn = await seedVault(org.id, devIn.id);
    const vaultOut = await seedVault(org.id, devOut.id);
    await seedVault(otherOrg.id, devOther.id);

    const handler = vaultHandlers().get('query_vaults')!;
    const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);

    const restricted = await listRows(handler, restrictedAuth, org.id, { limit: 100 }, 'vaults');
    const restrictedIds = restricted.map((v: any) => v.id);
    expect(restrictedIds).toContain(vaultIn.id);
    expect(restrictedIds).not.toContain(vaultOut.id);

    const crossOrg = await listRows(handler, restrictedAuth, org.id, { deviceId: devOther.id, limit: 100 }, 'vaults');
    expect(crossOrg).toEqual([]);

    const unrestrictedAuth = makeAuth(org.id);
    const unrestricted = await listRows(handler, unrestrictedAuth, org.id, { limit: 100 }, 'vaults');
    const unrestrictedIds = unrestricted.map((v: any) => v.id);
    expect(unrestrictedIds).toEqual(expect.arrayContaining([vaultIn.id, vaultOut.id]));
  });

  it('fails closed when a site-restricted caller has no resolvable org: empty result, not an unfiltered query', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const dev = await seedDevice(org.id, site.id);
    await seedVault(org.id, dev.id);

    const handler = vaultHandlers().get('query_vaults')!;
    const nullOrgAuth = makeNullOrgAuth([site.id]);

    const result = await callTool(handler, nullOrgAuth, null, { limit: 100 });
    expect(result).toEqual({ vaults: [], showing: 0 });
  });
});

// ============================================
// get_vault_status — device/site scope
// ============================================

describe('get_vault_status — device site scope', () => {
  it('denies an out-of-site device, allows the in-site device, an unrestricted caller sees both, a cross-org device is not found', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const otherSite = await createSite({ orgId: otherOrg.id });

    const devIn = await seedDevice(org.id, siteAllowed.id);
    const devOut = await seedDevice(org.id, siteForbidden.id);
    const devOther = await seedDevice(otherOrg.id, otherSite.id);
    await seedVault(org.id, devIn.id);

    const handler = vaultHandlers().get('get_vault_status')!;
    const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);

    const denied = await callTool(handler, restrictedAuth, org.id, { deviceId: devOut.id });
    expect(denied.error).toBeDefined();

    const allowed = await callTool(handler, restrictedAuth, org.id, { deviceId: devIn.id });
    expect(allowed.error).toBeUndefined();
    expect(allowed.deviceId).toBe(devIn.id);

    const crossOrg = await callTool(handler, restrictedAuth, org.id, { deviceId: devOther.id });
    expect(crossOrg.error).toBeDefined();

    const unrestrictedAuth = makeAuth(org.id);
    const unrestrictedOut = await callTool(handler, unrestrictedAuth, org.id, { deviceId: devOut.id });
    expect(unrestrictedOut.error).toBeUndefined();
  });
});

// ============================================
// query_backup_sla — org-level aggregate stricter-narrowed to in-scope devices
// ============================================

describe('query_backup_sla — breach counts narrowed to in-scope devices (stricter than the route)', () => {
  it('narrows active breach counts to the site-restricted caller devices; unrestricted sees the full count', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const devIn = await seedDevice(org.id, siteAllowed.id);
    const devOut = await seedDevice(org.id, siteForbidden.id);

    const slaConfig = await seedSlaConfig(org.id);
    await seedSlaEvent(org.id, slaConfig.id, devIn.id);
    await seedSlaEvent(org.id, slaConfig.id, devOut.id);

    const handler = slaHandlers().get('query_backup_sla')!;

    const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);
    const restrictedConfigs = await listRows(handler, restrictedAuth, org.id, { limit: 100 }, 'configs');
    const restrictedRow = restrictedConfigs.find((c: any) => c.id === slaConfig.id);
    expect(restrictedRow).toBeDefined();
    expect(restrictedRow.activeBreaches).toBe(1);

    const unrestrictedAuth = makeAuth(org.id);
    const unrestrictedConfigs = await listRows(handler, unrestrictedAuth, org.id, { limit: 100 }, 'configs');
    const unrestrictedRow = unrestrictedConfigs.find((c: any) => c.id === slaConfig.id);
    expect(unrestrictedRow.activeBreaches).toBe(2);
  });

  it('a cross-org SLA config is not visible', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const otherConfig = await seedSlaConfig(otherOrg.id);

    const handler = slaHandlers().get('query_backup_sla')!;
    const auth = makeAuth(org.id);
    const configs = await listRows(handler, auth, org.id, { limit: 100 }, 'configs');
    expect(configs.find((c: any) => c.id === otherConfig.id)).toBeUndefined();
  });
});

// ============================================
// get_sla_breaches — device/site scope
// ============================================

describe('get_sla_breaches — device site scope', () => {
  it('excludes out-of-site breach events; unrestricted sees all; cross-org events never appear', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const otherSite = await createSite({ orgId: otherOrg.id });

    const devIn = await seedDevice(org.id, siteAllowed.id);
    const devOut = await seedDevice(org.id, siteForbidden.id);
    const devOther = await seedDevice(otherOrg.id, otherSite.id);

    const slaConfig = await seedSlaConfig(org.id);
    const evtIn = await seedSlaEvent(org.id, slaConfig.id, devIn.id);
    const evtOut = await seedSlaEvent(org.id, slaConfig.id, devOut.id);
    const otherConfig = await seedSlaConfig(otherOrg.id);
    const evtOther = await seedSlaEvent(otherOrg.id, otherConfig.id, devOther.id);

    const handler = slaHandlers().get('get_sla_breaches')!;
    const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);

    const restricted = await listRows(handler, restrictedAuth, org.id, { limit: 100 }, 'breaches');
    const restrictedIds = restricted.map((b: any) => b.id);
    expect(restrictedIds).toContain(evtIn.id);
    expect(restrictedIds).not.toContain(evtOut.id);
    expect(restrictedIds).not.toContain(evtOther.id);

    const unrestrictedAuth = makeAuth(org.id);
    const unrestricted = await listRows(handler, unrestrictedAuth, org.id, { limit: 100 }, 'breaches');
    const unrestrictedIds = unrestricted.map((b: any) => b.id);
    expect(unrestrictedIds).toEqual(expect.arrayContaining([evtIn.id, evtOut.id]));
    expect(unrestrictedIds).not.toContain(evtOther.id);
  });
});

// ============================================
// get_sla_compliance_report — device-linked aggregate, site scope
// ============================================

describe('get_sla_compliance_report — device-linked aggregates narrowed by site scope', () => {
  it('a site-restricted caller with zero in-scope devices gets an indeterminate report, never a fabricated 100%', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    await seedDevice(org.id, siteForbidden.id); // only a device outside the caller's site
    await seedSlaConfig(org.id);

    const handler = slaHandlers().get('get_sla_compliance_report')!;
    const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);

    const parsed = await callTool(handler, restrictedAuth, org.id, {});
    expect(parsed.compliancePercent).toBeNull();
    expect(parsed.activeConfigs).toBe(1);
  });

  it('an unrestricted caller sees the full report; a cross-org config never inflates the count', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    await seedSlaConfig(org.id);
    await seedSlaConfig(otherOrg.id);

    const handler = slaHandlers().get('get_sla_compliance_report')!;
    const auth = makeAuth(org.id);
    const parsed = await callTool(handler, auth, org.id, {});
    expect(parsed.activeConfigs).toBe(1);
    expect(parsed.compliancePercent).not.toBeNull();
  });
});

// ============================================
// DR tools — tool-path cases only (route behavior proven in
// drReadSiteScope.integration.test.ts)
// ============================================

describe('DR AI tools — site scope through the tool layer (route behavior already proven in drReadSiteScope.integration.test.ts)', () => {
  it('query_dr_plans hides a plan whose only group references an out-of-site device, and shows the in-site one', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const devIn = await seedDevice(org.id, siteAllowed.id);
    const devOut = await seedDevice(org.id, siteForbidden.id);

    const visiblePlan = await seedDrPlan(org.id, `visible-${randomUUID().slice(0, 8)}`);
    await seedDrPlanGroup(org.id, visiblePlan.id, [devIn.id]);
    const hiddenPlan = await seedDrPlan(org.id, `hidden-${randomUUID().slice(0, 8)}`);
    await seedDrPlanGroup(org.id, hiddenPlan.id, [devOut.id]);

    const handler = drHandlers().get('query_dr_plans')!;
    const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);

    const plans = await listRows(handler, restrictedAuth, org.id, { limit: 100 }, 'plans');
    const planIds = plans.map((p: any) => p.id);
    expect(planIds).toContain(visiblePlan.id);
    expect(planIds).not.toContain(hiddenPlan.id);
  });

  it('get_dr_plan_details 404s a plan whose only group is out-of-site, and a cross-org planId', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const devOut = await seedDevice(org.id, siteForbidden.id);

    const hiddenPlan = await seedDrPlan(org.id, `hidden-${randomUUID().slice(0, 8)}`);
    await seedDrPlanGroup(org.id, hiddenPlan.id, [devOut.id]);
    const otherOrgPlan = await seedDrPlan(otherOrg.id, `other-${randomUUID().slice(0, 8)}`);

    const handler = drHandlers().get('get_dr_plan_details')!;
    const restrictedAuth = makeAuth(org.id, [(await createSite({ orgId: org.id })).id]);

    const hidden = await callTool(handler, restrictedAuth, org.id, { planId: hiddenPlan.id });
    expect(hidden.error).toBeDefined();

    const crossOrg = await callTool(handler, restrictedAuth, org.id, { planId: otherOrgPlan.id });
    expect(crossOrg.error).toBeDefined();
  });

  it('get_dr_execution_status 404s an execution whose plan group devices are all out of the caller site scope', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });
    const devOut = await seedDevice(org.id, siteForbidden.id);

    const plan = await seedDrPlan(org.id, `exec-plan-${randomUUID().slice(0, 8)}`);
    await seedDrPlanGroup(org.id, plan.id, [devOut.id]);
    const execution = await seedDrExecution(org.id, plan.id);

    const handler = drHandlers().get('get_dr_execution_status')!;
    const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);

    const denied = await callTool(handler, restrictedAuth, org.id, { executionId: execution.id });
    expect(denied.error).toBeDefined();
  });
});
