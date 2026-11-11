// #8170 W06.2b: the newest migration redefining
// security_agent_device_status_vendor_chk, so the live CHECK ==
// SECURITY_AGENT_STATUS_VENDORS contract lives here until a newer one takes it
// over (a shipped migration is immutable). A vendor added to the constant without
// a newer migration, or to the CHECK without the constant, fails here, not as a
// runtime 23514 that empties coverage for every vendor sharing the insert.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { SECURITY_AGENT_STATUS_VENDORS, securityAgentDeviceStatus } from './schema/securityAgents';

const FILE = '2027-01-22-130000-security-agent-device-status-vendor-bitdefender.sql';
const NAME = 'security_agent_device_status_vendor_chk';
const DIR = new URL('../../migrations/', import.meta.url);
const SQL = readFileSync(new URL(FILE, DIR), 'utf8');
const listed = (text: string) => (/vendor"? IN \(([^)]*)\)/.exec(text)?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);

describe(FILE, () => {
  it(`${NAME} lists exactly SECURITY_AGENT_STATUS_VENDORS, in order (incl. bitdefender)`, () => {
    expect(listed(SQL)).toEqual([...SECURITY_AGENT_STATUS_VENDORS]);
    expect(SECURITY_AGENT_STATUS_VENDORS).toContain('bitdefender');
  });

  it('the Drizzle check() mirrors the same list', () => {
    const check = getTableConfig(securityAgentDeviceStatus).checks.find((c) => c.name === NAME);
    expect(listed(new PgDialect().sqlToQuery(check!.value).sql)).toEqual([...SECURITY_AGENT_STATUS_VENDORS]);
  });

  it('drops the constraint before re-adding it (idempotent)', () => {
    expect(SQL).toContain(`ALTER TABLE security_agent_device_status DROP CONSTRAINT IF EXISTS ${NAME};`);
    expect(SQL.indexOf(`DROP CONSTRAINT IF EXISTS ${NAME}`)).toBeLessThan(SQL.indexOf(`ADD CONSTRAINT ${NAME}`));
  });

  it('is DDL only: no DML, no inner transaction, so it needs no breeze.scope election', () => {
    const code = SQL.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });

  it(`is the newest migration that redefines ${NAME}`, () => {
    const redefining = readdirSync(DIR)
      .filter((f) => /^\d{4}-.*\.sql$/.test(f))
      .filter((f) => new RegExp(`CONSTRAINT ${NAME}`).test(readFileSync(new URL(f, DIR), 'utf8')))
      .sort((a, b) => a.localeCompare(b));
    expect(redefining.at(-1)).toBe(FILE);
  });
});
