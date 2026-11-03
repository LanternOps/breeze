/** Real PostgreSQL ARE/numeric[] and dynamic software rule contract (#10539). */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { deviceGroups, devices, softwareInventory } from '../../db/schema';
import {
  evaluateFilter, extractFieldsFromFilter, softwareVersionKeySql,
  type FilterCondition, type FilterConditionGroup,
} from '../../services/filterEngine';
import { compareInventoryVersions } from '../../services/softwareVersionCompare';
import { setupTestEnvironment } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedDevice(orgId: string, siteId: string, name: string, installs: Array<{
  name?: string; version: string | null; vendor?: string | null;
}>): Promise<string> {
  const id = randomUUID();
  await withSystemDbAccessContext(async () => {
    await db.insert(devices).values({
      id, orgId, siteId, agentId: id, hostname: name, osType: 'windows',
      osVersion: 'test', architecture: 'x86_64', agentVersion: 'test', status: 'online',
    });
    if (installs.length) await db.insert(softwareInventory).values(installs.map((install) => ({
      deviceId: id, orgId, name: install.name ?? 'Example App',
      version: install.version, vendor: install.vendor === undefined ? 'Acme' : install.vendor,
    })));
  });
  return id;
}

describe('software version/vendor dynamic groups against Postgres', () => {
  runDb('evaluates saved rules with any-install semantics, exact names, and org isolation', async () => {
    const env = await setupTestEnvironment();
    const other = await setupTestEnvironment();
    const orgId = env.organization.id;
    const seed = (name: string, installs: Parameters<typeof seedDevice>[3]) => seedDevice(orgId, env.site.id, name, installs);
    const low = await seed('low', [{ version: '10.0.4' }]);
    const high = await seed('high', [{ version: '10.0.10', vendor: 'ACME Corporation' }]);
    const suffix = await seed('suffix', [{ name: 'eXaMpLe aPp', version: '10.0.5 (x64)', vendor: 'aCmE' }]);
    // 'unknown' and NULL versions must never satisfy a version predicate: the
    // exact member sets below exclude them.
    await seed('unknown', [{ version: 'unknown', vendor: null }]);
    await seed('null', [{ version: null, vendor: null }]);
    const multiple = await seed('multiple', [{ version: '10.0.1' }, { version: '10.0.9', vendor: 'Other' }]);
    const differentName = await seed('helper', [{ name: 'Example App Helper', version: '10.0.1', vendor: '100%_ Vendor' }]);
    await seed('absent', []);
    await seedDevice(other.organization.id, other.site.id, 'foreign', [{ version: '10.0.1' }]);

    // Store and read the same JSON and field metadata used by dynamic groups.
    const run = async (condition: FilterCondition) => {
      const filter: FilterConditionGroup = { operator: 'AND', conditions: [condition] };
      const groupId = randomUUID();
      await withSystemDbAccessContext(() => db.insert(deviceGroups).values({
        id: groupId, orgId, name: groupId, type: 'dynamic', filterConditions: filter,
        filterFieldsUsed: extractFieldsFromFilter(filter),
      }));
      return withDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId] }, async () => {
        const [saved] = await db.select().from(deviceGroups).where(eq(deviceGroups.id, groupId));
        expect(saved!.filterFieldsUsed).toEqual([condition.field]);
        const result = await evaluateFilter(saved!.filterConditions as FilterConditionGroup, { orgId });
        // A forged target org cannot override the caller's DB scope.
        expect((await evaluateFilter(filter, { orgId: other.organization.id })).deviceIds).toEqual([]);
        return result.deviceIds.sort();
      });
    };
    const version = (operator: 'below' | 'atLeast' | 'equals', value = '10.0.5') => run({
      field: 'software.version', operator, value: { name: 'EXAMPLE APP', version: value },
    });
    expect(await version('below')).toEqual([low, multiple].sort());
    expect(await version('atLeast')).toEqual([high, suffix, multiple].sort());
    expect(await version('equals', 'v10.0.5.0-beta')).toEqual([suffix]);
    // A target with no numeric prefix is refused rather than matching nothing.
    for (const op of ['below', 'equals', 'atLeast'] as const) {
      await expect(version(op, 'unknown')).rejects.toThrow(/must start with a number/);
    }
    expect(await run({ field: 'software.vendor', operator: 'equals', value: 'acme' })).toEqual([low, suffix, multiple].sort());
    expect(await run({ field: 'software.vendor', operator: 'contains', value: 'ACME' })).toEqual([low, high, suffix, multiple].sort());
    expect(await run({ field: 'software.vendor', operator: 'contains', value: '%_' })).toEqual([differentName]);
    expect(await run({ field: 'software.version', operator: 'below', value: { name: 'Missing', version: '99' } })).toEqual([]);
  });

  runDb('keeps SQL normalization/comparison equal to TypeScript for every pair', async () => {
    const versions: Array<string | null> = [
      '1.2.10', '1.2.9', '10.10', '10.2', '14.0.1.4', '14.0.1.10',
      '1.2', '1.2.0', '1.2.0.00', '1.2.3-beta', '1.2.3', 'v2.0', 'V2.0', '1.9',
      '10.0.5 (x64)', '7.0 build 1234', '1.02', '1.10', '1.0.05', '0', '0.0', '00.00',
      '20231015123456', '9007199254740992', '9007199254740993', '9'.repeat(100),
      '1.2+meta', '1.2.RC1', '  1.2  ', '\t\n1.2\r', '\u00a01.2\uFEFF', '', ' ', 'unknown', null,
    ];
    const values = sql.join(versions.map((v, i) => sql`(${i}::int, ${v}::text)`), sql`, `);
    const left = softwareVersionKeySql(sql`a.version`);
    const right = softwareVersionKeySql(sql`b.version`);
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      WITH versions(id, version) AS (VALUES ${values})
      SELECT a.id AS a, b.id AS b, CASE
        WHEN ${left} < ${right} THEN -1
        WHEN ${left} = ${right} THEN 0
        WHEN ${left} > ${right} THEN 1
        ELSE NULL END AS comparison
      FROM versions a CROSS JOIN versions b
    `));
    expect(rows).toHaveLength(versions.length ** 2);
    for (const row of rows) {
      const a = versions[Number(row.a)]!;
      const b = versions[Number(row.b)]!;
      expect(row.comparison, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(compareInventoryVersions(a, b));
    }
    const keys = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT ${softwareVersionKeySql(sql`'0.0'`)}::text AS zero,
        ${softwareVersionKeySql(sql`'1.10'`)}::text AS ten,
        ${softwareVersionKeySql(sql`'1.0.05'`)}::text AS five
    `));
    expect(keys[0]).toMatchObject({ zero: '{0}', ten: '{1,10}', five: '{1,0,5}' });
  });
});
