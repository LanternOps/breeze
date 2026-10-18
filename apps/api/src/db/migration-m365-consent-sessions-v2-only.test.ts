import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION = '2026-12-31-170000-m365-consent-sessions-v2-only.sql';

/** Statement text with `--` comments stripped, so assertions only see SQL. */
function statements(raw: string): string {
  return raw.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
}

describe('M365 consent sessions v2-only migration (#7910 W04)', () => {
  const sql = statements(readFileSync(join(__dirname, '../../migrations', MIGRATION), 'utf8'));

  it('elects system scope before deleting the legacy rows, and reports the count', () => {
    const scope = sql.indexOf("PERFORM set_config('breeze.scope', 'system', true)");
    const del = sql.search(/DELETE FROM m365_consent_sessions\s+WHERE flow_version = 1/);
    expect(scope).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThan(scope);
    expect(sql).toMatch(
      /GET DIAGNOSTICS n = ROW_COUNT;\s*IF n > 0 THEN\s*RAISE WARNING 'cleaned % legacy m365_consent_sessions rows', n;/,
    );
  });

  it('deletes before it tightens any constraint', () => {
    const del = sql.search(/DELETE FROM m365_consent_sessions/);
    const firstAdd = sql.search(/ADD CONSTRAINT/);
    expect(del).toBeGreaterThanOrEqual(0);
    expect(firstAdd).toBeGreaterThan(del);
  });

  it('admits only flow_version 2 and defaults to it', () => {
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS m365_consent_sessions_flow_version_check/);
    expect(sql).toMatch(/ADD CONSTRAINT m365_consent_sessions_flow_version_check\s+CHECK \(flow_version = 2\)/);
    expect(sql).toMatch(/ALTER COLUMN flow_version SET DEFAULT 2/);
  });

  it('re-creates phase_fields_check with only the two flow_version 2 branches', () => {
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS m365_consent_sessions_phase_fields_check/);
    const check = sql.slice(sql.search(/ADD CONSTRAINT m365_consent_sessions_phase_fields_check/));
    expect(check).not.toMatch(/flow_version = 1/);
    expect(check.match(/flow_version = 2/g)).toHaveLength(2);
    expect(check).toMatch(/phase = 'identity_verification'/);
    expect(check).toMatch(/phase IN \('tenant_confirmation', 'admin_consent'\)/);
  });

  it('leaves the phase CHECK alone and drops no column (tenant_hint_hash is live v2 state)', () => {
    expect(sql).not.toMatch(/m365_consent_sessions_phase_check/);
    expect(sql).not.toMatch(/DROP COLUMN/i);
  });

  it('carries no inner transaction control', () => {
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });
});
