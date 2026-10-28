/**
 * Integration test — W09 (#6779) SNMP tools honour the org axis and the site axis
 * against real Postgres as the unprivileged `breeze_app` role.
 *
 * Tools: manage_snmp_templates (CRUD, OID browse / validate) and get_snmp_metrics
 * (history, dashboard).
 *
 * The brief's "poll / test on an out-of-site SNMP device" has no tool: the SNMP device,
 * per-device metric and threshold routes are 410 stubs (plan D0). The closest live
 * boundary is the per-asset metric history, which is proven here instead.
 *
 * Entry point: `executeTool`, so the same dispatch as production runs (permission
 * floor included). Proven against stored rows, not just the tool's reply:
 *   - a site- or device-restricted caller cannot create / change / delete an org-wide template;
 *   - another organization's caller sees "not found" for a template and nothing changes;
 *   - an org caller cannot create in another org; a built-in or org-less row is never written;
 *   - a template still used by a device cannot be deleted;
 *   - a restricted caller's history for an out-of-site asset is the same "not found" as a missing one.
 * Each refusal has a CONTROL: lifting the guard (the unrestricted caller, same input)
 * lands the change, so the refusal is the gate and not a broken fixture.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { withDbAccessContext } from '../../db';
import { snmpDevices, snmpMetrics, snmpTemplates } from '../../db/schema';
import { executeTool } from '../../services/aiTools';
import { clearPermissionCache } from '../../services/permissions';
import { getTestDb } from './setup';
import { contextFor, seedNetworkMonitoringFixture, type NetworkMonitoringFixture, type Who } from './network-monitoring-ai-fixtures';

let f: NetworkMonitoringFixture;
beforeEach(async () => {
  clearPermissionCache();
  f = await seedNetworkMonitoringFixture();
});

async function run(who: Who, tool: string, input: Record<string, unknown>) {
  const raw = await withDbAccessContext(contextFor(f, who), () => executeTool(tool, input, f.auth[who]));
  return JSON.parse(raw) as Record<string, any>;
}

const OID = { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime' };
const template = async (id: string) => (await getTestDb().select().from(snmpTemplates).where(eq(snmpTemplates.id, id)))[0];

async function seedTemplate(over: Partial<typeof snmpTemplates.$inferInsert> = {}) {
  const [row] = await getTestDb().insert(snmpTemplates).values({
    orgId: f.orgA, name: 'Edge', oids: [OID], isBuiltIn: false, ...over,
  }).returning();
  return row!;
}

describe('manage_snmp_templates — create', () => {
  it('binds the new row to the caller org', async () => {
    const out = await run('orgAll', 'manage_snmp_templates', { action: 'create', name: 'Mine', oids: [OID] });
    expect(out.created, JSON.stringify(out)).toBe(true);
    expect((await template(out.template.id))?.orgId).toBe(f.orgA);
  });

  it('an org caller cannot create in another org, and nothing is written', async () => {
    const out = await run('orgAll', 'manage_snmp_templates', { action: 'create', name: 'Theirs', oids: [OID], orgId: f.orgB });
    expect(out.code).toBe('ACCESS_DENIED');
    expect(await getTestDb().select().from(snmpTemplates).where(eq(snmpTemplates.orgId, f.orgB))).toHaveLength(0);
  });

  it('a partner caller must name the org (it has several), and can then create in it', async () => {
    const missing = await run('partnerAdmin', 'manage_snmp_templates', { action: 'create', name: 'P', oids: [OID] });
    expect(missing.code).toBe('ACCESS_DENIED');
    const named = await run('partnerAdmin', 'manage_snmp_templates', { action: 'create', name: 'P', oids: [OID], orgId: f.orgB });
    expect(named.created, JSON.stringify(named)).toBe(true);
    expect((await template(named.template.id))?.orgId).toBe(f.orgB);
  });

  it('a partner caller cannot create in an org outside its partner', async () => {
    const out = await run('otherPartner', 'manage_snmp_templates', { action: 'create', name: 'X', oids: [OID], orgId: f.orgA });
    expect(out.code).toBe('ACCESS_DENIED');
    expect(await getTestDb().select().from(snmpTemplates).where(eq(snmpTemplates.orgId, f.orgA))).toHaveLength(0);
  });

  it('a site-restricted caller cannot create an org-wide template; CONTROL: the unrestricted caller can', async () => {
    const refused = await run('restricted', 'manage_snmp_templates', { action: 'create', name: 'Site-scoped', oids: [OID] });
    expect(refused.code).toBe('ACCESS_DENIED');
    expect(await getTestDb().select().from(snmpTemplates).where(eq(snmpTemplates.orgId, f.orgA))).toHaveLength(0);
    const lifted = await run('orgAll', 'manage_snmp_templates', { action: 'create', name: 'Site-scoped', oids: [OID] });
    expect(lifted.created, JSON.stringify(lifted)).toBe(true);
  });
});

describe('manage_snmp_templates — update and delete', () => {
  it('a site-restricted caller cannot change or delete the row; CONTROL: the unrestricted caller can', async () => {
    const t = await seedTemplate();
    expect((await run('restricted', 'manage_snmp_templates', { action: 'update', templateId: t.id, name: 'Hacked' })).code).toBe('ACCESS_DENIED');
    expect((await run('restricted', 'manage_snmp_templates', { action: 'delete', templateId: t.id })).code).toBe('ACCESS_DENIED');
    expect((await template(t.id))?.name).toBe('Edge');

    const lifted = await run('orgAll', 'manage_snmp_templates', { action: 'update', templateId: t.id, name: 'Renamed' });
    expect(lifted.updated, JSON.stringify(lifted)).toBe(true);
    expect((await template(t.id))?.name).toBe('Renamed');
  });

  it("another organization's caller sees not-found for update and delete, and the row is untouched", async () => {
    const t = await seedTemplate();
    const upd = await run('otherOrg', 'manage_snmp_templates', { action: 'update', templateId: t.id, name: 'Hacked' });
    const del = await run('otherOrg', 'manage_snmp_templates', { action: 'delete', templateId: t.id });
    const missing = await run('otherOrg', 'manage_snmp_templates', { action: 'delete', templateId: '00000000-0000-4000-8000-00000000dead' });
    expect(upd.code).toBe('NOT_FOUND');
    expect(del).toEqual(missing);
    expect((await template(t.id))?.name).toBe('Edge');
    // CONTROL: the owning org's unrestricted caller can delete it.
    const lifted = await run('orgAll', 'manage_snmp_templates', { action: 'delete', templateId: t.id });
    expect(lifted.deleted, JSON.stringify(lifted)).toBe(true);
    expect(await template(t.id)).toBeUndefined();
  });

  it('a partner caller of another partner cannot touch the row either', async () => {
    const t = await seedTemplate();
    expect((await run('otherPartner', 'manage_snmp_templates', { action: 'delete', templateId: t.id })).code).toBe('NOT_FOUND');
    expect(await template(t.id)).toBeTruthy();
  });

  it('a built-in row is never written, whoever asks', async () => {
    const t = await seedTemplate({ orgId: null, isBuiltIn: true, name: 'Built-in' });
    for (const who of ['orgAll', 'partnerAdmin'] as const) {
      expect((await run(who, 'manage_snmp_templates', { action: 'update', templateId: t.id, name: 'X' })).code, who).toBe('BUILT_IN');
      expect((await run(who, 'manage_snmp_templates', { action: 'delete', templateId: t.id })).code, who).toBe('BUILT_IN');
    }
    expect((await template(t.id))?.name).toBe('Built-in');
  });

  it('a custom row with no org (system scope) is never written by a tenant caller (QW3)', async () => {
    const t = await seedTemplate({ orgId: null, name: 'System-owned' });
    for (const who of ['orgAll', 'partnerAdmin'] as const) {
      expect((await run(who, 'manage_snmp_templates', { action: 'update', templateId: t.id, name: 'X' })).code, who).toBe('NOT_FOUND');
      expect((await run(who, 'manage_snmp_templates', { action: 'delete', templateId: t.id })).code, who).toBe('NOT_FOUND');
    }
    expect((await template(t.id))?.name).toBe('System-owned');
  });

  it('a template still used by a device cannot be deleted; once the device is gone it can', async () => {
    const t = await seedTemplate();
    const [dev] = await getTestDb().insert(snmpDevices).values({
      orgId: f.orgA, assetId: f.assetA1, name: 'sw', ipAddress: '192.0.2.10', snmpVersion: 'v2c', templateId: t.id,
    }).returning({ id: snmpDevices.id });
    const refused = await run('orgAll', 'manage_snmp_templates', { action: 'delete', templateId: t.id });
    expect(refused.code).toBe('IN_USE');
    expect(await template(t.id)).toBeTruthy();
    await getTestDb().delete(snmpDevices).where(eq(snmpDevices.id, dev!.id));
    const lifted = await run('orgAll', 'manage_snmp_templates', { action: 'delete', templateId: t.id });
    expect(lifted.deleted, JSON.stringify(lifted)).toBe(true);
  });
});

describe('manage_snmp_templates — reads', () => {
  it("list shows the caller's custom rows and the built-ins, never another org's", async () => {
    const mine = await seedTemplate({ name: 'Mine' });
    const builtin = await seedTemplate({ orgId: null, isBuiltIn: true, name: 'Built-in' });
    const theirs = await seedTemplate({ orgId: f.orgB, name: 'Theirs' });
    const ids = (out: Record<string, any>) => (out.templates as Array<{ id: string }>).map((t) => t.id);
    expect(ids(await run('orgAll', 'manage_snmp_templates', { action: 'list' }))).toEqual(expect.arrayContaining([mine.id, builtin.id]));
    expect(ids(await run('orgAll', 'manage_snmp_templates', { action: 'list' }))).not.toContain(theirs.id);
    expect(ids(await run('otherOrg', 'manage_snmp_templates', { action: 'list' }))).not.toContain(mine.id);
    expect((await run('otherOrg', 'manage_snmp_templates', { action: 'get', templateId: mine.id })).code).toBe('NOT_FOUND');
    // A site-restricted caller can still read.
    expect(ids(await run('restricted', 'manage_snmp_templates', { action: 'list' }))).toContain(mine.id);
  });

  it('browse_oids includes the OIDs of visible templates only', async () => {
    await seedTemplate({ orgId: f.orgB, oids: [{ oid: '1.3.6.1.4.1.99999.1', name: 'secretOid' }] });
    const out = await run('orgAll', 'manage_snmp_templates', { action: 'browse_oids', query: 'secretOid' });
    expect(out.total).toBe(0);
    const control = await run('otherOrg', 'manage_snmp_templates', { action: 'browse_oids', query: 'secretOid' });
    expect(control.total).toBe(1);
  });
});

describe('get_snmp_metrics', () => {
  async function seedDevice(assetId: string, orgId: string) {
    const [dev] = await getTestDb().insert(snmpDevices).values({
      orgId, assetId, name: 'sw', ipAddress: '192.0.2.99', snmpVersion: 'v2c',
    }).returning({ id: snmpDevices.id });
    await getTestDb().insert(snmpMetrics).values({
      deviceId: dev!.id, orgId, oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', value: '42', timestamp: new Date(Date.now() - 60_000),
    });
    return dev!.id;
  }
  const HISTORY = (assetId: string) => ({ action: 'history', assetId, oid: '1.3.6.1.2.1.1.3.0', from: new Date(Date.now() - 3600_000).toISOString() });

  it("a restricted caller's history for an out-of-site asset is the same not-found as a missing one; CONTROL: in-site and unrestricted land", async () => {
    await seedDevice(f.assetA1, f.orgA);
    await seedDevice(f.assetA2, f.orgA);
    const hidden = await run('restricted', 'get_snmp_metrics', HISTORY(f.assetA2));
    const missing = await run('restricted', 'get_snmp_metrics', HISTORY('00000000-0000-4000-8000-00000000dead'));
    expect(hidden.code).toBe('NOT_FOUND');
    expect(hidden).toEqual(missing);

    const inSite = await run('restricted', 'get_snmp_metrics', HISTORY(f.assetA1));
    expect(inSite.series, JSON.stringify(inSite)).toHaveLength(1);
    const lifted = await run('orgAll', 'get_snmp_metrics', HISTORY(f.assetA2));
    expect(lifted.series, JSON.stringify(lifted)).toHaveLength(1);
  });

  it("another organization's caller cannot read the asset's history", async () => {
    await seedDevice(f.assetA1, f.orgA);
    expect((await run('otherOrg', 'get_snmp_metrics', HISTORY(f.assetA1))).code).toBe('NOT_FOUND');
  });

  it("a partner of another partner cannot read it either, even when it names the org", async () => {
    await seedDevice(f.assetA1, f.orgA);
    expect((await run('otherPartner', 'get_snmp_metrics', { ...HISTORY(f.assetA1), orgId: f.orgA })).code).toBe('NOT_FOUND');
  });

  it('the dashboard counts only the caller sites; CONTROL: the unrestricted caller counts both', async () => {
    await seedDevice(f.assetA1, f.orgA);
    await seedDevice(f.assetA2, f.orgA);
    const narrowed = await run('restricted', 'get_snmp_metrics', { action: 'dashboard' });
    expect(narrowed.data.totals.devices, JSON.stringify(narrowed)).toBe(1);
    const lifted = await run('orgAll', 'get_snmp_metrics', { action: 'dashboard' });
    expect(lifted.data.totals.devices).toBe(2);
  });

  it('the dashboard of another org is refused', async () => {
    expect((await run('otherOrg', 'get_snmp_metrics', { action: 'dashboard', orgId: f.orgA })).code).toBe('ACCESS_DENIED');
  });
});
