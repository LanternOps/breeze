/**
 * Static shape of the W02 migration (#12429): what the integration suite can
 * only show for the state it builds, stated for the file itself.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION = '2027-01-30-160000-mcp-tool-list-mode.sql';
const text = readFileSync(join(__dirname, '../../migrations', MIGRATION), 'utf8');
const code = text.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

describe(MIGRATION, () => {
  it('bounds every lock wait first, then elects system scope, before its first ALTER and UPDATE', () => {
    // Every authenticated API-key and OAuth request reads these two tables and
    // each ALTER takes ACCESS EXCLUSIVE. Transaction-local, so it cannot leak into
    // the migrations after it.
    const timeout = code.indexOf("SET LOCAL lock_timeout = '5s';");
    const scope = code.indexOf("SELECT set_config('breeze.scope', 'system', true);");
    expect(timeout).toBe(code.search(/\S/));
    expect(code.match(/lock_timeout/g)).toHaveLength(1);
    // Nothing but the election stands between the timeout and the first ALTER.
    expect(code.slice(timeout, scope).trim()).toBe("SET LOCAL lock_timeout = '5s';");
    expect(code.search(/\bALTER\b/i)).toBeGreaterThan(scope);
    expect(code.search(/\bUPDATE\b/i)).toBeGreaterThan(scope);
  });

  it('takes both table locks before it lifts FORCE, so a timed-out wait never leaves it lifted', () => {
    const force = code.indexOf('NO FORCE ROW LEVEL SECURITY');
    for (const table of ['api_keys', 'oauth_grants']) {
      const add = code.indexOf(`ALTER TABLE public.${table} ADD COLUMN`);
      expect(add).toBeGreaterThan(-1);
      expect(add).toBeLessThan(code.indexOf('DO $$'));
      expect(add).toBeLessThan(force);
    }
  });

  it('has no inner transaction and adds each column with IF NOT EXISTS', () => {
    // The plpgsql block keywords are `BEGIN`/`END` without a semicolon.
    expect(code).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\s*;/i);
    expect(code.match(/ADD COLUMN IF NOT EXISTS mcp_tool_list_mode text;/g)).toHaveLength(2);
    expect(code.match(/ADD COLUMN/g)).toHaveLength(2);
  });

  it.each(['api_keys', 'oauth_grants'])('%s: the backfill runs only while its own CHECK does not exist yet', (table) => {
    const blocks = code.match(/DO \$\$[\s\S]*?END \$\$;/g) ?? [];
    expect(blocks).toHaveLength(2);
    const block = blocks.find((b) => b.includes(`UPDATE public.${table} `));
    expect(block, `a DO block updating ${table}`).toBeDefined();
    const guard = block!.indexOf('IF NOT EXISTS');
    // Elected in the writing statement itself too, so a raw psql -f cannot skip the rows.
    expect(block!.slice(guard, block!.indexOf(`UPDATE public.${table} `))).toContain("PERFORM set_config('breeze.scope', 'system', true);");
    const update = block!.indexOf(`UPDATE public.${table} `);
    const add = block!.indexOf(`ADD CONSTRAINT ${table}_mcp_tool_list_mode_check`);
    const endIf = block!.indexOf('END IF;');
    expect(guard).toBeGreaterThan(-1);
    expect(block!.slice(guard, update)).toContain(`conname = '${table}_mcp_tool_list_mode_check'`);
    expect(block!.slice(guard, update)).toContain(`conrelid = 'public.${table}'::regclass`);
    expect(update).toBeGreaterThan(guard);
    expect(add).toBeGreaterThan(update);
    expect(endIf).toBeGreaterThan(add);
    expect(block).toContain('WHERE mcp_tool_list_mode IS NULL');
  });

  it('lifts FORCE on oauth_grants only around its one UPDATE, and restores it in the same block', () => {
    const block = (code.match(/DO \$\$[\s\S]*?END \$\$;/g) ?? []).find((b) => b.includes('UPDATE public.oauth_grants '))!;
    const off = block.indexOf('ALTER TABLE public.oauth_grants NO FORCE ROW LEVEL SECURITY;');
    const update = block.indexOf('UPDATE public.oauth_grants ');
    const on = block.indexOf('ALTER TABLE public.oauth_grants FORCE ROW LEVEL SECURITY;');
    expect(off).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(off);
    expect(on).toBeGreaterThan(update);
    expect(on).toBeLessThan(block.indexOf('ADD CONSTRAINT'));
    expect(code.match(/ROW LEVEL SECURITY/g)).toHaveLength(2);
  });

  it('has no UPDATE outside the two guarded blocks', () => {
    expect(code.match(/\bUPDATE\b/g)).toHaveLength(2);
  });
});
