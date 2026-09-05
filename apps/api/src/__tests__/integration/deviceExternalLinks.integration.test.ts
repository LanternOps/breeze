/**
 * Functional forge proof for device_external_links (#3257 W06).
 *
 * Shape 1 (direct org_id): breeze_has_org_access(org_id) policies, enabled and
 * forced in 2026-10-10-100000-device-external-links.sql. These tests run
 * through the real driver as the unprivileged app role under the integration
 * config; do not run them with the plain unit-test Vitest config.
 *
 * Also proves:
 *  - the unique key is PARTNER-scoped and uses COALESCE(source_instance, '')
 *    as the reserved discriminator, so adopting an account/instance axis later
 *    (Open Decision 2) is a backfill rather than a migration of a unique key;
 *  - the composite FK (device_id, org_id) → devices (id, org_id) makes a
 *    drifted org_id unrepresentable even under system scope;
 *  - deleting the device removes the link;
 *  - the two resolution indexes the importer's serial/hostname passes depend on
 *    actually exist, expression-indexed on the NORMALISED form.
 *
 * Fixtures are re-seeded per test — the integration setup truncates tenant
 * data between tests, so memoized fixtures would be stale and vacuous.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { deviceExternalLinks, devices } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function partnerCtx(partnerId: string, accessibleOrgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

let deviceSeq = 0;

/**
 * Seeds through the TEST client (`getTestDb`), like every other db-utils
 * factory, and deliberately NOT inside a system DB context. The partner-export
 * statement triggers enforce a lock hierarchy — partners shared before orgs
 * exclusive — so seeding a second partner after the first partner's orgs inside
 * ONE transaction raises "new partner lock requested after organization lock".
 * Autocommitted statements sidestep it entirely. The link inserts under test
 * still go through the app pool, which is the whole point of the forge.
 */
async function createDevice(orgId: string, siteId: string, hostname: string): Promise<string> {
  deviceSeq += 1;
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `agent-del-${Date.now()}-${deviceSeq}`,
    hostname,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x64',
    agentVersion: '1.0.0',
  }).returning({ id: devices.id });
  return device!.id;
}

async function seedPartnerSubtree(hostnamesByOrg: string[][]) {
  const partner = await createPartner();
  const orgs: Array<{ orgId: string; deviceIds: string[] }> = [];
  for (const hostnames of hostnamesByOrg) {
    const org = await createOrganization({ partnerId: partner!.id });
    const site = await createSite({ orgId: org!.id });
    const deviceIds: string[] = [];
    for (const hostname of hostnames) {
      deviceIds.push(await createDevice(org!.id, site!.id, hostname));
    }
    orgs.push({ orgId: org!.id, deviceIds });
  }
  return { partnerId: partner!.id, orgs };
}

async function seedFixture() {
  const a = await seedPartnerSubtree([['wkstn-d1', 'wkstn-d2'], ['wkstn-d3']]);
  const b = await seedPartnerSubtree([['wkstn-d4']]);

  return {
    partnerA: a.partnerId,
    orgA: a.orgs[0]!.orgId,
    orgA2: a.orgs[1]!.orgId,
    partnerB: b.partnerId,
    orgB: b.orgs[0]!.orgId,
    d1: a.orgs[0]!.deviceIds[0]!,
    d2: a.orgs[0]!.deviceIds[1]!,
    dOtherOrg: a.orgs[1]!.deviceIds[0]!,
    dOtherPartner: b.orgs[0]!.deviceIds[0]!,
  };
}

interface LinkInput {
  deviceId: string;
  orgId: string;
  partnerId: string;
  system: string;
  externalId: string;
  sourceInstance?: string | null;
}

function insertLink(input: LinkInput) {
  return db.insert(deviceExternalLinks).values({
    deviceId: input.deviceId,
    orgId: input.orgId,
    partnerId: input.partnerId,
    system: input.system,
    externalId: input.externalId,
    sourceInstance: input.sourceInstance ?? null,
  }).returning({ id: deviceExternalLinks.id });
}

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

async function captureCause(fn: () => Promise<unknown>): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return cause;
    const direct = err as { code?: string; message?: string };
    return direct.code ? { code: direct.code, message: direct.message } : { message: direct.message };
  }
}

describe('device_external_links — durable device identity for re-import', () => {
  // Non-vacuity guard: if the code-under-test pool is ever a BYPASSRLS role
  // (e.g. a worktree missing its .env.test symlink), every forge assertion
  // below passes even with broken policies. Fail loudly here first.
  runDb('code-under-test runs as a non-BYPASSRLS role (guards against vacuous RLS)', async () => {
    const { partnerA, orgA } = await seedFixture();
    const rows = await withDbAccessContext(partnerCtx(partnerA, [orgA]), () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls
                     FROM pg_roles WHERE rolname = current_user`)
    );
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row?.who).toBe('breeze_app');
    expect(row?.rolbypassrls).toBe(false);
  });

  runDb('has RLS enabled AND forced', async () => {
    const rows = await sys(() => db.execute(sql`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE oid = 'public.device_external_links'::regclass
    `)) as unknown as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  runDb('refuses two links with the same (partner, system, external_id)', async () => {
    const f = await seedFixture();
    await sys(() => insertLink({
      deviceId: f.d1, orgId: f.orgA, partnerId: f.partnerA, system: 'datto_rmm', externalId: 'uid-1',
    }));
    const cause = await captureCause(() => sys(() => insertLink({
      deviceId: f.d2, orgId: f.orgA, partnerId: f.partnerA, system: 'datto_rmm', externalId: 'uid-1',
    })));
    expect(cause?.code).toBe('23505');
  });

  runDb('scopes the unique key across ORGS of the same partner, not per org', async () => {
    // A Datto UID is unique across the Datto tenant, which is partner-shaped.
    // Two orgs under one partner must not both claim the same source UID.
    const f = await seedFixture();
    await sys(() => insertLink({
      deviceId: f.d1, orgId: f.orgA, partnerId: f.partnerA, system: 'datto_rmm', externalId: 'uid-x',
    }));
    const cause = await captureCause(() => sys(() => insertLink({
      deviceId: f.dOtherOrg, orgId: f.orgA2, partnerId: f.partnerA, system: 'datto_rmm', externalId: 'uid-x',
    })));
    expect(cause?.code).toBe('23505');
  });

  runDb('treats a NULL source_instance as the empty discriminator in the unique index', async () => {
    const f = await seedFixture();
    await sys(() => insertLink({
      deviceId: f.d1, orgId: f.orgA, partnerId: f.partnerA, system: 'csv', externalId: '1',
    }));
    // A discriminator makes it a different key.
    const inserted = await sys(() => insertLink({
      deviceId: f.d2, orgId: f.orgA, partnerId: f.partnerA, system: 'csv', externalId: '1', sourceInstance: 'tenant-b',
    }));
    expect(inserted[0]?.id).toBeDefined();
  });

  runDb('still collides when two rows share the same non-null source_instance', async () => {
    const f = await seedFixture();
    await sys(() => insertLink({
      deviceId: f.d1, orgId: f.orgA, partnerId: f.partnerA, system: 'csv', externalId: '1', sourceInstance: 'tenant-b',
    }));
    const cause = await captureCause(() => sys(() => insertLink({
      deviceId: f.d2, orgId: f.orgA, partnerId: f.partnerA, system: 'csv', externalId: '1', sourceInstance: 'tenant-b',
    })));
    expect(cause?.code).toBe('23505');
  });

  runDb('allows the same external_id under a different partner', async () => {
    const f = await seedFixture();
    await sys(() => insertLink({
      deviceId: f.d1, orgId: f.orgA, partnerId: f.partnerA, system: 'datto_rmm', externalId: 'uid-1',
    }));
    const inserted = await sys(() => insertLink({
      deviceId: f.dOtherPartner, orgId: f.orgB, partnerId: f.partnerB, system: 'datto_rmm', externalId: 'uid-1',
    }));
    expect(inserted[0]?.id).toBeDefined();
  });

  runDb('refuses a link whose device belongs to another org, even under system scope', async () => {
    const f = await seedFixture();
    const cause = await captureCause(() => sys(() => insertLink({
      deviceId: f.d1, orgId: f.orgA2, partnerId: f.partnerA, system: 'datto_rmm', externalId: 'uid-9',
    })));
    expect(cause?.code).toBe('23503');
  });

  runDb('refuses a link whose partner_id does not own its org, even under system scope', async () => {
    const f = await seedFixture();
    const cause = await captureCause(() => sys(() => insertLink({
      deviceId: f.d1, orgId: f.orgA, partnerId: f.partnerB, system: 'datto_rmm', externalId: 'uid-8',
    })));
    expect(cause?.code).toBe('23503');
  });

  runDb('deletes the link when the device is deleted', async () => {
    const f = await seedFixture();
    await sys(() => insertLink({
      deviceId: f.d1, orgId: f.orgA, partnerId: f.partnerA, system: 'datto_rmm', externalId: 'uid-del',
    }));
    await sys(() => db.execute(sql`DELETE FROM devices WHERE id = ${f.d1}::uuid`));
    const rows = await sys(() => db.execute(
      sql`SELECT 1 FROM device_external_links WHERE device_id = ${f.d1}::uuid`
    )) as unknown as unknown[];
    expect(rows).toHaveLength(0);
  });

  runDb('rejects a cross-partner forge INSERT with an RLS violation (42501)', async () => {
    const f = await seedFixture();
    const cause = await captureCause(() =>
      withDbAccessContext(partnerCtx(f.partnerA, [f.orgA]), () => insertLink({
        deviceId: f.dOtherPartner, orgId: f.orgB, partnerId: f.partnerB, system: 'datto_rmm', externalId: 'forged',
      }))
    );
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(/row-level security/);
  });

  runDb('hides another partner\'s links from a SELECT', async () => {
    const f = await seedFixture();
    await sys(() => insertLink({
      deviceId: f.dOtherPartner, orgId: f.orgB, partnerId: f.partnerB, system: 'datto_rmm', externalId: 'uid-b',
    }));
    const visible = await withDbAccessContext(partnerCtx(f.partnerA, [f.orgA]), () =>
      db.select({ id: deviceExternalLinks.id }).from(deviceExternalLinks)
    );
    expect(visible).toHaveLength(0);
  });

  runDb('carries the resolution indexes the serial and hostname passes depend on', async () => {
    const rows = await sys(() => db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('device_hardware_org_serial_idx', 'devices_org_hostname_lower_idx',
                          'device_external_links_uniq', 'device_external_links_device_idx',
                          'device_external_links_org_idx')
    `)) as unknown as Array<{ indexname: string; indexdef: string }>;
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    expect([...byName.keys()].sort()).toEqual([
      'device_external_links_device_idx',
      'device_external_links_org_idx',
      'device_external_links_uniq',
      'device_hardware_org_serial_idx',
      'devices_org_hostname_lower_idx',
    ]);
    // Expression-indexed on the NORMALISED form — the resolver compares
    // upper(btrim(serial_number)) and lower(hostname) on both sides of the join,
    // so a plain column index would not be usable.
    expect(byName.get('device_hardware_org_serial_idx')).toMatch(/upper\(btrim\(/);
    expect(byName.get('devices_org_hostname_lower_idx')).toMatch(/lower\(/);
    expect(byName.get('device_external_links_uniq')).toMatch(/COALESCE\(source_instance/i);
  });

  runDb('declares the device composite FK deferrable so an org merge can re-point both sides', async () => {
    const rows = await sys(() => db.execute(sql`
      SELECT conname, condeferrable, condeferred
      FROM pg_constraint
      WHERE conrelid = 'public.device_external_links'::regclass AND contype = 'f'
    `)) as unknown as Array<{ conname: string; condeferrable: boolean; condeferred: boolean }>;
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.condeferrable).toBe(true);
  });
});
