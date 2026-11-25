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
  it('elects system scope before its first UPDATE', () => {
    const scope = code.indexOf("SELECT set_config('breeze.scope', 'system', true);");
    const firstUpdate = code.search(/\bUPDATE\b/i);
    expect(scope).toBe(code.search(/\S/));
    expect(firstUpdate).toBeGreaterThan(scope);
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

  it('has no UPDATE outside the two guarded blocks', () => {
    expect(code.match(/\bUPDATE\b/g)).toHaveLength(2);
  });
});
