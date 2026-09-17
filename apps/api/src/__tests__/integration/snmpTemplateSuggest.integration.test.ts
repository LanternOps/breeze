/**
 * SNMP template prefixes, suggestion, and identity at ingest (#5988 W03).
 *
 * Migration under test:
 * `2026-10-17-110300-snmp-templates-prefixes-modes-xerox.sql`.
 *
 * Needs REAL Postgres: the prefix seed is a text[] UPDATE behind a FORCE-RLS
 * policy that only admits system scope, the mode/cadence rewrites are jsonb
 * aggregations, the suggestion read is filtered by snmp_templates_select, and
 * the manual-precedence half of the ingest path is a SQL CASE evaluated
 * against the stored row. A compiled-SQL mock observes none of it.
 */
import './setup';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { discoveredAssets, discoveryJobs, discoveryProfiles, snmpTemplates } from '../../db/schema';
import { processResults } from '../../jobs/discoveryWorker';
import { suggestTemplate } from '../../services/snmpTemplateSuggest';
import { replayMigration } from './replayMigration';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION = '2026-10-17-110300-snmp-templates-prefixes-modes-xerox.sql';
const XEROX_OID = '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1';
const XEROX_DESCR = 'Xerox(R) C325 Color MFP; SS CXTGV.230.096, kernel 5.4.254-yocto-standard, All-N-1';

let orgId: string;
let otherOrgId: string;
let siteId: string;
let profileId: string;
let jobId: string;

beforeEach(async () => {
  // setup's TRUNCATE ... CASCADE also clears org-null built-ins through
  // snmp_templates.org_id. Restore the original seed before testing its rewrite.
  await replayMigration('2026-05-22-snmp-multi-vendor-templates.sql');
  await replayMigration('2026-05-22-unifi-snmp-templates.sql');
  await replayMigration(MIGRATION);
  const partner = await createPartner({});
  orgId = (await createOrganization({ partnerId: partner.id })).id;
  otherOrgId = (await createOrganization({ partnerId: partner.id })).id;
  siteId = (await createSite({ orgId })).id;
  const raw = getTestDb();
  profileId = (await raw.insert(discoveryProfiles)
    .values({ orgId, siteId, name: 'w03-suite', subnets: ['10.9.9.0/24'] }).returning())[0]!.id;
  jobId = (await raw.insert(discoveryJobs)
    .values({ profileId, orgId, siteId, status: 'running' }).returning())[0]!.id;
});

afterEach(async () => {
  const raw = getTestDb();
  await raw.delete(snmpTemplates).where(eq(snmpTemplates.orgId, orgId));
  await raw.delete(snmpTemplates).where(eq(snmpTemplates.orgId, otherOrgId));
  await raw.delete(discoveredAssets).where(eq(discoveredAssets.orgId, orgId));
  await raw.delete(discoveryJobs).where(eq(discoveryJobs.orgId, orgId));
  await raw.delete(discoveryProfiles).where(eq(discoveryProfiles.orgId, orgId));
});

describe('migration: prefixes, Xerox built-in, mode/cadence', () => {
  runDb('seeded the Xerox built-in with its enterprise prefix', async () => {
    const rows = await getTestDb().execute(sql`
      select vendor, device_type, sys_object_id_prefixes
        from snmp_templates where name = 'Xerox Printer' and is_built_in`);
    expect(rows).toHaveLength(1);
    const row = (rows as unknown as Array<Record<string, unknown>>)[0];
    expect(row).toMatchObject({ vendor: 'Xerox', device_type: 'printer' });
    expect(row!.sys_object_id_prefixes).toEqual(['1.3.6.1.4.1.253']);
  });

  runDb('seeded Lexmark 641 and Brother 2435 (spec §8)', async () => {
    const rows = await getTestDb().execute(sql`
      select name, sys_object_id_prefixes from snmp_templates
       where name in ('Lexmark Printer','Brother Printer') and is_built_in order by name`);
    expect(rows as unknown as Array<Record<string, unknown>>).toEqual([
      { name: 'Brother Printer', sys_object_id_prefixes: ['1.3.6.1.4.1.2435'] },
      { name: 'Lexmark Printer', sys_object_id_prefixes: ['1.3.6.1.4.1.641'] },
    ]);
  });

  runDb('left the by-device-type fallbacks without a prefix', async () => {
    const rows = await getTestDb().execute(sql`
      select name from snmp_templates
       where is_built_in and sys_object_id_prefixes = '{}' order by name`);
    expect((rows as unknown as Array<{ name: string }>).map((r) => r.name))
      .toEqual(['Generic Printer (RFC 3805)', 'Generic UPS (RFC 1628)']);
  });

  runDb('gave every built-in printer OID entry an explicit mode', async () => {
    const rows = await getTestDb().execute(sql`
      select count(*)::int as n from snmp_templates t, jsonb_array_elements(t.oids) e
       where t.is_built_in and t.device_type = 'printer' and not (e ? 'mode')`);
    expect((rows as unknown as Array<{ n: number }>)[0]!.n).toBe(0);
  });

  runDb('marked table columns walk and scalars get', async () => {
    const rows = await getTestDb().execute(sql`
      select e->>'name' as name, e->>'mode' as mode
        from snmp_templates t, jsonb_array_elements(t.oids) e
       where t.name = 'Generic Printer (RFC 3805)' and t.is_built_in
         and e->>'name' in ('sysDescr','prtMarkerSuppliesLevel') order by 1`);
    expect(rows as unknown as Array<Record<string, string>>).toEqual([
      { name: 'prtMarkerSuppliesLevel', mode: 'walk' },
      { name: 'sysDescr', mode: 'get' },
    ]);
  });

  runDb('marked the static descriptors slow (spec §7.1)', async () => {
    const rows = await getTestDb().execute(sql`
      select distinct e->>'cadence' as cadence
        from snmp_templates t, jsonb_array_elements(t.oids) e
       where t.is_built_in and e->>'name' in
         ('ifDescr','ifSpeed','prtInputName','prtMarkerSuppliesDescription',
          'prtMarkerSuppliesType','prtMarkerColorantValue')`);
    expect(rows as unknown as Array<{ cadence: string }>).toEqual([{ cadence: 'slow' }]);
  });

  runDb('re-applying the migration changes nothing', async () => {
    const before = await getTestDb().execute(sql`
      select md5(string_agg(name || coalesce(sys_object_id_prefixes::text,'') || oids::text, '|' order by name)) as h
        from snmp_templates where is_built_in`);
    await replayMigration(MIGRATION);
    const after = await getTestDb().execute(sql`
      select md5(string_agg(name || coalesce(sys_object_id_prefixes::text,'') || oids::text, '|' order by name)) as h
        from snmp_templates where is_built_in`);
    expect((after as unknown as Array<{ h: string }>)[0]!.h)
      .toBe((before as unknown as Array<{ h: string }>)[0]!.h);
  });
});

describe('suggestTemplate against real rows', () => {
  runDb('picks Xerox Printer for a 253 sysObjectID and never a 25 template', async () => {
    const raw = getTestDb();
    await raw.insert(snmpTemplates).values({
      orgId, name: 'Bogus 25', vendor: 'Bogus', deviceType: 'printer',
      oids: sql`'[]'::jsonb`, isBuiltIn: false,
      sysObjectIdPrefixes: ['1.3.6.1.4.1.25'],
    } as never);

    const result = await withSystemDbAccessContext(() =>
      suggestTemplate({ sysObjectId: XEROX_OID, assetType: 'printer', orgId }));
    expect(result?.templateName).toBe('Xerox Printer');
  });

  runDb('does not offer another org\'s template', async () => {
    const [sibling] = await getTestDb().insert(snmpTemplates).values({
      orgId: otherOrgId, name: 'Sibling Xerox', vendor: 'Xerox', deviceType: 'printer',
      oids: [], isBuiltIn: false,
      sysObjectIdPrefixes: ['1.3.6.1.4.1.253.8'],
    }).returning({ id: snmpTemplates.id });

    const inOrg = <T>(fn: () => Promise<T>) => withDbAccessContext({
      scope: 'organization', orgId, accessibleOrgIds: [orgId],
    }, fn);

    // Positive control: the row exists and its longer prefix wins in its own org.
    const siblingResult = await withDbAccessContext({
      scope: 'organization', orgId: otherOrgId, accessibleOrgIds: [otherOrgId],
    }, () => suggestTemplate({ sysObjectId: XEROX_OID, assetType: 'printer', orgId: otherOrgId }));
    expect(siblingResult?.templateId).toBe(sibling!.id);

    // No app-level org predicate: this read specifically exercises snmp_templates_select.
    const visible = await inOrg(() => db.select().from(snmpTemplates)
      .where(eq(snmpTemplates.id, sibling!.id)));
    expect(visible).toEqual([]);
    const result = await inOrg(() =>
      suggestTemplate({ sysObjectId: XEROX_OID, assetType: 'printer', orgId }));
    expect(result?.templateName).toBe('Xerox Printer');
  });

  runDb('returns null for a sysObjectID no template claims', async () => {
    const result = await withSystemDbAccessContext(() =>
      suggestTemplate({ sysObjectId: '1.3.6.1.4.1.20682.1', assetType: 'printer', orgId }));
    expect(result).toBeNull();
  });
});

describe('identity at ingest', () => {
  const xeroxHost = {
    ip: '10.9.9.5', mac: '00:20:00:aa:bb:cc', assetType: 'printer', methods: ['snmp'],
    model: XEROX_OID, snmpData: { sysObjectId: XEROX_OID, sysDescr: XEROX_DESCR },
  };

  runDb('writes Xerox / the model phrase, never the raw OID', async () => {
    const result = await withSystemDbAccessContext(() => processResults({
      type: 'process-results', jobId, profileId, orgId, siteId,
      hostsScanned: 1, hostsDiscovered: 1, hosts: [xeroxHost as never],
    }));

    expect(result.newAssets).toBe(1);
    const [row] = await getTestDb().select()
      .from(discoveredAssets).where(eq(discoveredAssets.ipAddress, '10.9.9.5'));
    expect(row!.manufacturer).toBe('Xerox');
    expect(row!.model).toBe('Xerox(R) C325 Color MFP');
  });

  runDb('leaves an operator\'s manual identity alone', async () => {
    const raw = getTestDb();
    const [manual] = await raw.insert(discoveredAssets).values({
      orgId, siteId, ipAddress: '10.9.9.5', source: 'manual', approvalStatus: 'approved',
      typeSource: 'manual', isOnline: false,
      manufacturer: 'Front desk printer co.', model: 'The one by the kitchen',
    } as never).returning({ id: discoveredAssets.id });

    const result = await withSystemDbAccessContext(() => processResults({
      type: 'process-results', jobId, profileId, orgId, siteId,
      hostsScanned: 1, hostsDiscovered: 1, hosts: [xeroxHost as never],
    }));

    expect(result.updatedAssets).toBe(1);
    const [row] = await raw.select().from(discoveredAssets).where(eq(discoveredAssets.id, manual!.id));
    expect(row!.isOnline).toBe(true);
    expect(row!.source).toBe('manual');
    expect(row!.manufacturer).toBe('Front desk printer co.');
    expect(row!.model).toBe('The one by the kitchen');
  });
});
