import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODEL_LIFECYCLES } from '@breeze/shared';
import { describe, expect, it } from 'vitest';
import { PARTNER_AI_CONNECTION_KINDS, PARTNER_AI_MODEL_SOURCES } from './aiModelRegistry';

export function readMigration(name: string): string {
  return readFileSync(join(__dirname, '../../../migrations', name), 'utf8');
}

/** The quoted literals inside the first `CHECK (<column> IN (...))` for `column`. */
export function checkLiterals(sqlText: string, column: string): string[] {
  const match = new RegExp(`CHECK \\(\\s*${column} IN \\(([^)]*)\\)`, 'i').exec(sqlText);
  if (!match) throw new Error(`no CHECK (${column} IN (...)) in migration`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('partner_ai_connections contract (#7600 W02)', () => {
  const sqlText = readMigration('2026-11-14-100000-ai-model-registry-connections.sql');

  it('the kind CHECK lists exactly the Drizzle kinds', () => {
    expect(checkLiterals(sqlText, 'kind')).toEqual([...PARTNER_AI_CONNECTION_KINDS]);
  });

  it('copies legacy rows with the same id and elects system scope first', () => {
    const doBlock = sqlText.slice(sqlText.indexOf('DO $copy$'));
    const firstStatement = doBlock.slice(doBlock.indexOf('BEGIN') + 'BEGIN'.length).trim().split(';')[0];
    expect(firstStatement).toBe("PERFORM set_config('breeze.scope', 'system', true)");
    expect(sqlText).toMatch(/INSERT INTO public\.partner_ai_connections \(\s*id,/);
    expect(sqlText).toMatch(/SELECT\s+c\.id,/);
    expect(sqlText).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });

  it('no policy is role-restricted, and the legacy source gains a system-only policy before the copy', () => {
    expect(sqlText).not.toMatch(/CREATE POLICY[^;]*\bTO breeze_app\b/);
    const systemOnly = sqlText.indexOf('CREATE POLICY partner_llm_configs_system_only');
    expect(systemOnly).toBeGreaterThan(-1);
    expect(systemOnly).toBeLessThan(sqlText.indexOf('DO $copy$'));
  });
});

describe('partner_ai_models contract (#7600 W02)', () => {
  const sqlText = readMigration('2026-11-14-100100-ai-model-registry-offerings.sql');

  it('source and lifecycle CHECKs list exactly the Drizzle literals', () => {
    expect(checkLiterals(sqlText, 'source')).toEqual([...PARTNER_AI_MODEL_SOURCES]);
    expect(checkLiterals(sqlText, 'lifecycle')).toEqual([...MODEL_LIFECYCLES]);
  });

  it('the org-token branch is a separate FOR SELECT policy on enabled rows of the caller partner', () => {
    expect(sqlText).toMatch(
      /CREATE POLICY partner_ai_models_org_read_enabled\s+ON public\.partner_ai_models\s+FOR SELECT\s+USING \(enabled AND partner_id = public\.breeze_current_partner_id\(\)\);/,
    );
    // Never appended to the FOR ALL policy.
    const forAll = sqlText.slice(sqlText.indexOf('CREATE POLICY partner_ai_models_partner_access'));
    expect(forAll.slice(0, forAll.indexOf(');') + 2)).not.toMatch(/breeze_current_partner_id/);
  });

  it('the connection FK is composite and cascades', () => {
    expect(sqlText).toMatch(/FOREIGN KEY \(connection_id, partner_id\)\s+REFERENCES public\.partner_ai_connections \(id, partner_id\) ON DELETE CASCADE/);
    expect(sqlText).toMatch(/FOREIGN KEY \(refusal_fallback_offering_id, partner_id\)\s+REFERENCES public\.partner_ai_models \(id, partner_id\)/);
  });
});
