import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { alerts } from './alerts';

const migration = readFileSync(join(__dirname, '../../../migrations/2027-01-18-130000-alerts-owner-kind-device-topology-chk.sql'), 'utf8');
const check = getTableConfig(alerts).checks.find(check => check.name === 'alerts_owner_chk');
const schemaSql = check ? new PgDialect().sqlToQuery(check.value).sql.replace(/"alerts"\./g, '').replace(/"/g, '') : '';

describe('alerts owner CHECK', () => {
  it.each([['migration', migration], ['schema', schemaSql]])('%s refuses topology rows labeled as device owners', (_name, sql) => {
    expect(sql.replace(/\s+/g, ' ')).toContain("(owner_kind = 'device' AND device_id IS NOT NULL AND topology_site_id IS NULL)");
  });
});
