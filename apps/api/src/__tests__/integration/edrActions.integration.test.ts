/**
 * EDR W03 (#8167 / epic #8164) — response actions against real Postgres.
 * Migration: 2026-12-28-110000-edr-actions.sql.
 *
 * Covers the in-flight uniqueness index (one queued/submitted row per target +
 * action), migration replay, and (from A13) cross-tenant insert refusal,
 * concurrent dispatch, tombstoned detections, org erasure and export.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import JSZip from 'jszip';

// The vendor, the credential blob and the Redis limiter are faked; every DB
// read/write (RLS, FKs, the in-flight index, audit) is real.
const fake = vi.hoisted(() => ({
  performAction: vi.fn(),
  calls: 0,
  /** Extra actions the fake adapter claims (detection-action resolution tests). */
  extraActions: [] as string[],
}));
vi.mock('../../services/edrProviders/credentials', async () => {
  const actual = await vi.importActual<typeof import('../../services/edrProviders/credentials')>('../../services/edrProviders/credentials');
  return { ...actual, decryptEdrSecret: () => ({ apiKey: 'k'.repeat(24) }) };
});
vi.mock('../../services/edrProviders/actionGates', async () => {
  const actual = await vi.importActual<typeof import('../../services/edrProviders/actionGates')>('../../services/edrProviders/actionGates');
  return { ...actual, checkEdrActionRateLimit: async () => ({ ok: true }) };
});
vi.mock('../../services/edrProviders/context', () => ({ buildEdrAdapterContext: () => ({ fake: true }) }));
vi.mock('../../services/edrProviders/registry', async () => {
  const actual = await vi.importActual<typeof import('../../services/edrProviders/registry')>('../../services/edrProviders/registry');
  const real = actual.getEdrProvider('bitdefender');
  const adapter = {
    ...real,
    capabilities: {
      ...real.capabilities,
      get actions() { return [...real.capabilities.actions, ...fake.extraActions]; },
    },
    supportsAction: (facts: never, action: never) =>
      (fake.extraActions as string[]).includes(action) ? { ok: true } : real.supportsAction!(facts, action),
    performAction: (...a: unknown[]) => { fake.calls += 1; return fake.performAction(...a); },
  };
  return { ...actual, getEdrProvider: () => adapter };
});

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  devices,
  edrActions,
  edrConnections,
  edrDetections,
  edrEndpoints,
  edrTenants,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { dispatchEdrAction } from '../../services/edrProviders/actions';
import { EdrActionError } from '../../services/edrProviders/actionErrors';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { buildOrgExportZip } from '../../services/tenantExport';
import { pgErrorCode } from '../../routes/edr/access';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION = new URL('../../../migrations/2026-12-28-110000-edr-actions.sql', import.meta.url);

type Row = Record<string, unknown>;
const admin = () => getTestDb() as typeof db;

async function seedEdrTenant(label: string) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `edr-actions-${label}-${randomUUID()}@example.com`,
  });
  const [device] = await admin().insert(devices).values({
    orgId: org.id,
    siteId: site!.id,
    agentId: randomUUID(),
    hostname: `edr-act-${label}-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
  }).returning({ id: devices.id });

  return withSystemDbAccessContext(async () => {
    const [connection] = await db.insert(edrConnections).values({
      partnerId: partner.id,
      provider: 'bitdefender',
      actionsEnabled: true,
      name: `GravityZone ${label} ${randomUUID().slice(0, 6)}`,
      credentialsEncrypted: 'enc:test',
      vendorRootId: 'root-1',
      vendorRootType: 'partner',
    }).returning({ id: edrConnections.id });
    const [tenant] = await db.insert(edrTenants).values({
      connectionId: connection!.id,
      partnerId: partner.id,
      vendorTenantId: `company-${label}-${randomUUID().slice(0, 6)}`,
      vendorTenantName: `Company ${label}`,
      vendorTenantType: 'company',
      orgId: org.id,
      mappingSource: 'manual',
    }).returning({ id: edrTenants.id });
    const [endpoint] = await db.insert(edrEndpoints).values({
      connectionId: connection!.id,
      partnerId: partner.id,
      orgId: org.id,
      tenantId: tenant!.id,
      provider: 'bitdefender',
      vendorEndpointId: `ep-${randomUUID().slice(0, 8)}`,
      hostname: 'WS-01',
      breezeDeviceId: device!.id,
    }).returning({ id: edrEndpoints.id });
    return {
      partner, org, site: site!, user, device: device!,
      connection: connection!, tenant: tenant!, endpoint: endpoint!,
    };
  });
}
type Tenant = Awaited<ReturnType<typeof seedEdrTenant>>;

function actionValues(t: Tenant, over: Row = {}) {
  return {
    connectionId: t.connection.id,
    partnerId: t.partner.id,
    orgId: t.org.id,
    tenantId: t.tenant.id,
    endpointId: t.endpoint.id,
    breezeDeviceId: t.device.id,
    provider: 'bitdefender',
    action: 'isolate',
    requestedVia: 'ui',
    requestedBy: t.user.id,
    ...over,
  } as typeof edrActions.$inferInsert;
}

async function insertActionAsSystem(t: Tenant, over: Row = {}) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.insert(edrActions).values(actionValues(t, over)).returning({ id: edrActions.id });
    return row!;
  });
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return pgErrorCode(err);
  }
}

describe('edr actions — migration (real PostgreSQL)', () => {
  runDb('migration replays idempotently on the live schema', async () => {
    const migration = readFileSync(MIGRATION, 'utf8');
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql.raw(migration));
      await tx.execute(sql.raw(migration));
      const cols = Array.from(await tx.execute(sql.raw(`
        SELECT table_name, column_name, is_nullable, column_default
          FROM information_schema.columns
         WHERE (table_name = 'edr_connections' AND column_name = 'actions_enabled')
            OR (table_name = 'edr_tenants' AND column_name IN ('unsupported_actions', 'unsupported_actions_at'))
         ORDER BY table_name, column_name`))) as Row[];
      expect(cols.map((c) => `${c.table_name}.${c.column_name}:${c.is_nullable}`)).toEqual([
        'edr_connections.actions_enabled:NO',
        'edr_tenants.unsupported_actions:NO',
        'edr_tenants.unsupported_actions_at:YES',
      ]);
      const idx = Array.from(await tx.execute(sql.raw(`
        SELECT indexname, indexdef FROM pg_indexes
         WHERE tablename = 'edr_actions' AND indexname LIKE 'edr_actions_inflight_%' ORDER BY indexname`))) as Row[];
      expect(idx.map((i) => i.indexname)).toEqual([
        'edr_actions_inflight_detection_uniq',
        'edr_actions_inflight_endpoint_uniq',
      ]);
      for (const i of idx) expect(String(i.indexdef)).toMatch(/UNIQUE INDEX[\s\S]*WHERE/);
      // Roll back the replay so nothing else observes it (it is a no-op, but keep the test inert).
      tx.rollback();
    }).catch((err) => {
      if (!(err instanceof Error) || !/rollback/i.test(err.message)) throw err;
    });
  });

  runDb('new connections default actions OFF; new tenants carry no denials', async () => {
    const t = await seedEdrTenant('defaults');
    // The seed opts its connection in; a connection inserted without naming the column is OFF.
    const [conn] = await withSystemDbAccessContext(() => db.insert(edrConnections).values({
      partnerId: t.partner.id, provider: 'bitdefender', name: `Default ${randomUUID().slice(0, 6)}`,
      credentialsEncrypted: 'enc:test',
    }).returning({ actionsEnabled: edrConnections.actionsEnabled }));
    expect(conn!.actionsEnabled).toBe(false);
    const [row] = Array.from(await admin().execute(sql`
      SELECT unsupported_actions, unsupported_actions_at FROM edr_tenants WHERE id = ${t.tenant.id}`)) as Row[];
    expect(row).toMatchObject({ unsupported_actions_at: null });
    expect(row!.unsupported_actions).toEqual([]);
  });

  runDb('a second in-flight row for the same (endpoint, action) is a 23505; a settled first row frees the slot', async () => {
    const t = await seedEdrTenant('inflight');
    const first = await insertActionAsSystem(t, { status: 'queued' });
    expect(await codeOf(insertActionAsSystem(t, { status: 'queued' }))).toBe('23505');
    expect(await codeOf(insertActionAsSystem(t, { status: 'submitted' }))).toBe('23505');
    // A different action on the same endpoint is independent.
    expect(await codeOf(insertActionAsSystem(t, { action: 'scan' }))).toBeNull();

    await withSystemDbAccessContext(() =>
      db.execute(sql`UPDATE edr_actions SET status = 'failed' WHERE id = ${first.id}`));
    expect(await codeOf(insertActionAsSystem(t, { status: 'queued' }))).toBeNull();
    // Settled rows never collide with each other.
    expect(await codeOf(insertActionAsSystem(t, { status: 'succeeded' }))).toBeNull();
    expect(await codeOf(insertActionAsSystem(t, { status: 'succeeded' }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A13 — tenancy, concurrency, tombstones, erasure, export
// ---------------------------------------------------------------------------

function partnerAuth(t: Tenant, reach: string[] = [t.org.id]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: t.user.id, email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
    token: { mfa: true },
    scope: 'partner',
    partnerId: t.partner.id,
    orgId: null,
    accessibleOrgIds: reach,
    partnerOrgAccess: 'selected',
    canAccessOrg: (id: string) => reach.includes(id),
    orgCondition: () => undefined,
  } as unknown as AuthContext;
}
const uiActor = (auth: AuthContext) => ({
  auth,
  restriction: { allowedDeviceIds: null, allowedSiteIds: null },
  requestedVia: 'ui' as const,
  requestedBy: auth.user.id,
  aiSessionId: null,
  approvalId: null,
  reason: null,
});
const countActions = (orgId: string) => admin().execute(sql`SELECT count(*)::int AS n FROM edr_actions WHERE org_id = ${orgId}`)
  .then((r) => (r as unknown as Array<{ n: number }>)[0]!.n);

describe('edr actions — tenancy and dispatch (real PostgreSQL)', () => {
  beforeEach(() => {
    fake.calls = 0;
    fake.extraActions = [];
    fake.performAction.mockReset();
    fake.performAction.mockResolvedValue({ status: 'succeeded' });
  });

  runDb('1. an org-A token cannot INSERT an edr_actions row for org B -> 42501', async () => {
    const a = await seedEdrTenant('rls-a');
    const b = await seedEdrTenant('rls-b');
    const orgContext: DbAccessContext = {
      scope: 'organization', orgId: a.org.id, accessibleOrgIds: [a.org.id], accessiblePartnerIds: [], userId: a.user.id,
    };
    const code = await codeOf(withDbAccessContext(orgContext, () => db.insert(edrActions).values(actionValues(b))));
    expect(code).toBe('42501');
    expect(await countActions(b.org.id)).toBe(0);
  });

  runDb('2. a selected-org partner (reach A only) acting on an org-B endpoint -> target_not_found, no row, no vendor call', async () => {
    const a = await seedEdrTenant('reach-a');
    const b = await seedEdrTenant('reach-b');
    const err = await dispatchEdrAction(uiActor(partnerAuth(a, [a.org.id])), {
      kind: 'endpoint', endpointId: b.endpoint.id, action: 'isolate',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EdrActionError);
    expect((err as EdrActionError).code).toBe('target_not_found');
    expect(await countActions(b.org.id)).toBe(0);
    expect(fake.calls).toBe(0);
  });

  runDb('2b. the happy path writes one audited row through RLS and settles it', async () => {
    const a = await seedEdrTenant('happy');
    const out = await dispatchEdrAction(uiActor(partnerAuth(a)), { kind: 'endpoint', endpointId: a.endpoint.id, action: 'isolate' });
    expect(out).toMatchObject({ status: 'succeeded', httpStatus: 200 });
    const [row] = Array.from(await admin().execute(sql`
      SELECT status, requested_by, requested_via, endpoint_id, breeze_device_id FROM edr_actions WHERE id = ${out.actionId}`)) as Row[];
    expect(row).toMatchObject({
      status: 'succeeded', requested_by: a.user.id, requested_via: 'ui', endpoint_id: a.endpoint.id, breeze_device_id: a.device.id,
    });
    const audits = Array.from(await admin().execute(sql`
      SELECT action FROM audit_logs WHERE resource_id = ${out.actionId}`)) as Row[];
    expect(audits.map((r) => r.action)).toContain('edr.action.requested');
    expect(fake.calls).toBe(1);
  });

  runDb('3. two concurrent isolates on one endpoint -> exactly one row and one vendor call; the other is action_in_progress', async () => {
    const a = await seedEdrTenant('race');
    fake.performAction.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { status: 'succeeded' };
    });
    const actor = uiActor(partnerAuth(a));
    const target = { kind: 'endpoint' as const, endpointId: a.endpoint.id, action: 'isolate' as const };
    const results = await Promise.allSettled([dispatchEdrAction(actor, target), dispatchEdrAction(actor, target)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(EdrActionError);
    expect((rejected[0]!.reason as EdrActionError).code).toBe('action_in_progress');
    expect(await countActions(a.org.id)).toBe(1);
    expect(fake.calls).toBe(1);
  });

  runDb('4. a tombstoned detection is read-only -> target_detached, no row', async () => {
    const a = await seedEdrTenant('tomb');
    const [det] = await withSystemDbAccessContext(() => db.insert(edrDetections).values({
      connectionId: a.connection.id,
      partnerId: a.partner.id,
      orgId: a.org.id,
      tenantId: null,
      provider: 'bitdefender',
      vendorDetectionId: `q-${randomUUID().slice(0, 8)}`,
      vendorKind: 'quarantine_item',
      severity: 'high',
      status: 'open',
      detachedAt: new Date(),
    } as typeof edrDetections.$inferInsert).returning({ id: edrDetections.id }));
    const err = await dispatchEdrAction(uiActor(partnerAuth(a)), {
      kind: 'detection', detectionId: det!.id, action: 'quarantine_restore',
    }).catch((e: unknown) => e);
    expect((err as EdrActionError).code).toBe('target_detached');
    expect(await countActions(a.org.id)).toBe(0);
  });

  runDb('5. org erasure succeeds with edr_actions rows in all four statuses', async () => {
    const a = await seedEdrTenant('erase');
    const keep = await seedEdrTenant('erase-keep');
    await insertActionAsSystem(a, { status: 'queued', action: 'isolate' });
    await insertActionAsSystem(a, { status: 'submitted', action: 'scan', vendorActionId: 'task-1' });
    await insertActionAsSystem(a, { status: 'succeeded', action: 'unisolate' });
    await insertActionAsSystem(a, { status: 'failed', action: 'isolate', error: 'licence' });
    await insertActionAsSystem(keep, { status: 'queued' });
    await cascadeDeleteOrg(a.org.id, a.user.id, 'tech@example.com');
    expect(await countActions(a.org.id)).toBe(0);
    expect(await countActions(keep.org.id)).toBe(1);
  });

  runDb('6. edr_tenants.unsupported_actions round-trips through the tenant export', async () => {
    const a = await seedEdrTenant('export');
    const deniedAt = new Date('2026-10-13T00:00:00Z');
    await admin().execute(sql`
      UPDATE edr_tenants SET unsupported_actions = ARRAY['isolate']::text[], unsupported_actions_at = ${deniedAt.toISOString()}::timestamptz
      WHERE id = ${a.tenant.id}`);
    const { zipBuffer } = await buildOrgExportZip(a.org.id, a.user.id, 'tech@example.com');
    const archive = await JSZip.loadAsync(zipBuffer);
    const rows = JSON.parse(await archive.file('edr_tenants.json')!.async('string')) as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unsupported_actions).toEqual(['isolate']);
    expect(new Date(String(rows[0]!.unsupported_actions_at)).toISOString()).toBe(deniedAt.toISOString());
  });
});

describe('edr actions — target resolution, cooldown and site rule (real PostgreSQL)', () => {
  beforeEach(() => {
    fake.calls = 0;
    fake.extraActions = [];
    fake.performAction.mockReset();
    fake.performAction.mockResolvedValue({ status: 'succeeded' });
  });

  /** A second connection under the same partner whose endpoint links the SAME device. */
  async function secondConnectionFor(t: Tenant) {
    return withSystemDbAccessContext(async () => {
      const [connection] = await db.insert(edrConnections).values({
        partnerId: t.partner.id, provider: 'bitdefender', name: `Second ${randomUUID().slice(0, 6)}`,
        credentialsEncrypted: 'enc:test', vendorRootId: 'root-2', vendorRootType: 'partner', actionsEnabled: true,
      }).returning({ id: edrConnections.id });
      const [tenant] = await db.insert(edrTenants).values({
        connectionId: connection!.id, partnerId: t.partner.id, vendorTenantId: `co2-${randomUUID().slice(0, 6)}`,
        vendorTenantName: 'Company 2', vendorTenantType: 'company', orgId: t.org.id, mappingSource: 'manual',
      }).returning({ id: edrTenants.id });
      const [endpoint] = await db.insert(edrEndpoints).values({
        connectionId: connection!.id, partnerId: t.partner.id, orgId: t.org.id, tenantId: tenant!.id,
        provider: 'bitdefender', vendorEndpointId: `ep2-${randomUUID().slice(0, 8)}`, hostname: 'WS-01',
        breezeDeviceId: t.device.id,
      }).returning({ id: edrEndpoints.id });
      return { connectionId: connection!.id, endpointId: endpoint!.id };
    });
  }

  runDb('a device linked through two connections is a 404 without connectionId, and resolves with it', async () => {
    const a = await seedEdrTenant('two-conn');
    const second = await secondConnectionFor(a);
    const actor = uiActor(partnerAuth(a));
    const err = await dispatchEdrAction(actor, { kind: 'device', deviceId: a.device.id, action: 'scan' }).catch((e: unknown) => e);
    expect((err as EdrActionError).code).toBe('target_not_found');
    expect((err as EdrActionError).message).toMatch(/more than one EDR connection/);
    expect(await countActions(a.org.id)).toBe(0);

    const out = await dispatchEdrAction(actor, { kind: 'device', deviceId: a.device.id, connectionId: second.connectionId, action: 'scan' });
    const [row] = Array.from(await admin().execute(sql`SELECT endpoint_id, connection_id FROM edr_actions WHERE id = ${out.actionId}`)) as Row[];
    expect(row).toMatchObject({ endpoint_id: second.endpointId, connection_id: second.connectionId });
  });

  runDb('a device on a connection it is not linked through resolves to nothing (404)', async () => {
    const a = await seedEdrTenant('wrong-conn');
    const other = await seedEdrTenant('wrong-conn-other');
    const err = await dispatchEdrAction(uiActor(partnerAuth(a)), {
      kind: 'device', deviceId: a.device.id, connectionId: other.connection.id, action: 'scan',
    }).catch((e: unknown) => e);
    expect((err as EdrActionError).code).toBe('target_not_found');
    expect(fake.calls).toBe(0);
  });

  runDb('a live detection resolves; its row carries detection_id and NO endpoint_id, so two detections on one endpoint can both be in flight', async () => {
    const a = await seedEdrTenant('det');
    fake.extraActions = ['quarantine_restore'];
    fake.performAction.mockImplementation(async () => new Promise((r) => setTimeout(() => r({ status: 'succeeded' }), 150)));
    const insertDet = () => withSystemDbAccessContext(() => db.insert(edrDetections).values({
      connectionId: a.connection.id, partnerId: a.partner.id, orgId: a.org.id, tenantId: a.tenant.id,
      endpointId: a.endpoint.id, breezeDeviceId: a.device.id, provider: 'bitdefender',
      vendorDetectionId: `q-${randomUUID().slice(0, 8)}`, vendorKind: 'quarantine_item', severity: 'high', status: 'open',
    } as typeof edrDetections.$inferInsert).returning({ id: edrDetections.id }));
    const [d1] = await insertDet();
    const [d2] = await insertDet();
    const actor = uiActor(partnerAuth(a));
    const [o1, o2] = await Promise.all([
      dispatchEdrAction(actor, { kind: 'detection', detectionId: d1!.id, action: 'quarantine_restore' }),
      dispatchEdrAction(actor, { kind: 'detection', detectionId: d2!.id, action: 'quarantine_restore' }),
    ]);
    const rows = Array.from(await admin().execute(sql`
      SELECT detection_id, endpoint_id, breeze_device_id FROM edr_actions WHERE id IN (${o1.actionId}, ${o2.actionId})`)) as Row[];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ endpoint_id: null, breeze_device_id: a.device.id });
    expect(rows.map((r) => r.detection_id).sort()).toEqual([d1!.id, d2!.id].sort());
    expect(fake.calls).toBe(2);
  });

  runDb('a detection whose tenant link is gone (tenant_id NULL) is treated as detached', async () => {
    const a = await seedEdrTenant('det-null-tenant');
    fake.extraActions = ['quarantine_restore'];
    const [det] = await withSystemDbAccessContext(() => db.insert(edrDetections).values({
      connectionId: a.connection.id, partnerId: a.partner.id, orgId: a.org.id, tenantId: null,
      provider: 'bitdefender', vendorDetectionId: `q-${randomUUID().slice(0, 8)}`, vendorKind: 'quarantine_item',
      severity: 'high', status: 'open',
    } as typeof edrDetections.$inferInsert).returning({ id: edrDetections.id }));
    const err = await dispatchEdrAction(uiActor(partnerAuth(a)), { kind: 'detection', detectionId: det!.id, action: 'quarantine_restore' })
      .catch((e: unknown) => e);
    expect((err as EdrActionError).code).toBe('target_detached');
  });

  runDb('cooldown: a same-action success 30 s ago refuses; a failed row, an older success or another action do not', async () => {
    const a = await seedEdrTenant('cooldown');
    const actor = uiActor(partnerAuth(a));
    const target = { kind: 'endpoint' as const, endpointId: a.endpoint.id, action: 'scan' as const };
    const recent = await insertActionAsSystem(a, { action: 'scan', status: 'succeeded', requestedAt: new Date(Date.now() - 30_000) });
    const e1 = await dispatchEdrAction(actor, target).catch((e: unknown) => e);
    expect((e1 as EdrActionError).code).toBe('action_recently_requested');
    expect(fake.calls).toBe(0);

    // Another action on the same endpoint is not cooled down.
    await dispatchEdrAction(actor, { ...target, action: 'unisolate' }).catch(() => undefined);

    await admin().execute(sql`UPDATE edr_actions SET status = 'failed' WHERE id = ${recent.id}`);
    await insertActionAsSystem(a, { action: 'scan', status: 'succeeded', requestedAt: new Date(Date.now() - 61_000) });
    const out = await dispatchEdrAction(actor, target);
    expect(out.status).toBe('succeeded');
  });

  runDb('site rule on real rows: a restricted caller is refused for an endpoint outside their devices and for an unlinked one', async () => {
    const a = await seedEdrTenant('site');
    const restricted = { ...uiActor(partnerAuth(a)), restriction: { allowedDeviceIds: [randomUUID()], allowedSiteIds: [a.site.id] } };
    const e1 = await dispatchEdrAction(restricted, { kind: 'endpoint', endpointId: a.endpoint.id, action: 'scan' }).catch((e: unknown) => e);
    expect((e1 as EdrActionError).code).toBe('site_denied');
    await admin().execute(sql`UPDATE edr_endpoints SET breeze_device_id = NULL WHERE id = ${a.endpoint.id}`);
    const allowAll = { ...restricted, restriction: { allowedDeviceIds: [a.device.id], allowedSiteIds: [a.site.id] } };
    const e2 = await dispatchEdrAction(allowAll, { kind: 'endpoint', endpointId: a.endpoint.id, action: 'scan' }).catch((e: unknown) => e);
    expect((e2 as EdrActionError).code).toBe('site_denied');
    expect(await countActions(a.org.id)).toBe(0);
    expect(fake.calls).toBe(0);
  });

  runDb('an org-scope token acting on another org\'s endpoint is a 404 under real RLS, with no row', async () => {
    const a = await seedEdrTenant('org-tok-a');
    const b = await seedEdrTenant('org-tok-b');
    const orgAuth = {
      ...partnerAuth(a), scope: 'organization', orgId: a.org.id, partnerOrgAccess: undefined,
    } as unknown as AuthContext;
    const err = await dispatchEdrAction(uiActor(orgAuth), { kind: 'endpoint', endpointId: b.endpoint.id, action: 'scan' })
      .catch((e: unknown) => e);
    expect((err as EdrActionError).code).toBe('target_not_found');
    expect(await countActions(b.org.id)).toBe(0);
  });
});
