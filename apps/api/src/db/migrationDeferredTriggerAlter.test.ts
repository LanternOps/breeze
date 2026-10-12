import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A row write on a table that has a DEFERRABLE INITIALLY DEFERRED constraint
 * trigger queues a trigger event until commit. Any later ALTER TABLE on that
 * table in the same transaction then fails with
 *   cannot ALTER TABLE "<table>" because it has pending trigger events
 * Every migration file runs in one transaction (autoMigrate), so a file that
 * writes to such a table and then alters it must fire the queued events first
 * (`SET CONSTRAINTS ALL IMMEDIATE`). The failure only shows when the write
 * matched rows, so CI's empty databases never catch it; v0.122.0 crash-looped
 * the hosted EU API on 2026-12-12-120100.
 *
 * A table counts from the migration that creates its deferred trigger onward:
 * writes in older files ran before the trigger existed.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

const CONSTRAINT_TRIGGER = /CREATE\s+CONSTRAINT\s+TRIGGER\s+\w+([\s\S]*?);/gi;

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

function deferredTriggerTables(sql: string): { table: string; at: number }[] {
  const out: { table: string; at: number }[] = [];
  for (const m of sql.matchAll(CONSTRAINT_TRIGGER)) {
    const body = m[1] ?? '';
    if (!/INITIALLY\s+DEFERRED/i.test(body)) continue;
    const on = /\bON\s+(?:public\.)?(\w+)/i.exec(body);
    if (on?.[1]) out.push({ table: on[1].toLowerCase(), at: m.index ?? 0 });
  }
  return out;
}

function findPendingTriggerAlters(files: { name: string; sql: string }[]): string[] {
  const deferred = new Set<string>();
  const violations: string[] = [];
  for (const file of files) {
    const sql = stripComments(file.sql);
    const createdHere = deferredTriggerTables(sql);
    const tables = new Set([...deferred, ...createdHere.map((c) => c.table)]);
    for (const table of tables) {
      const createdAt = createdHere.find((c) => c.table === table)?.at ?? -1;
      const write = new RegExp(
        `\\b(?:UPDATE|INSERT\\s+INTO|DELETE\\s+FROM)\\s+(?:ONLY\\s+)?(?:public\\.)?${table}\\b`,
        'gi',
      );
      const writes = [...sql.matchAll(write)].map((m) => m.index ?? 0).filter((i) => i > createdAt);
      if (writes.length === 0) continue;
      const alter = new RegExp(
        `ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(?:public\\.)?${table}\\b`,
        'gi',
      );
      for (const a of sql.matchAll(alter)) {
        const alterAt = a.index ?? 0;
        const firstWrite = writes.find((w) => w < alterAt);
        if (firstWrite === undefined) continue;
        const between = sql.slice(firstWrite, alterAt);
        if (!/SET\s+CONSTRAINTS\s+ALL\s+IMMEDIATE/i.test(between)) {
          violations.push(`${file.name}: ${table}`);
          break;
        }
      }
    }
    for (const c of createdHere) deferred.add(c.table);
  }
  return violations;
}

function loadMigrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

describe('migrations that write then ALTER a table with a deferred constraint trigger', () => {
  it('fire the pending trigger events before the ALTER', () => {
    expect(findPendingTriggerAlters(loadMigrations())).toEqual([]);
  });

  it('detects the v0.122.0 shape and accepts the fix', () => {
    const trigger = {
      name: '0001-trigger.sql',
      sql: `CREATE CONSTRAINT TRIGGER t AFTER UPDATE ON public.links DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION f();`,
    };
    const broken = {
      name: '0002-broken.sql',
      sql: `DO $$ BEGIN UPDATE links SET x = 1; END $$;\nALTER TABLE links ADD CONSTRAINT c CHECK (true);`,
    };
    const fixed = {
      name: '0002-fixed.sql',
      sql: `DO $$ BEGIN UPDATE links SET x = 1; END $$;\nSET CONSTRAINTS ALL IMMEDIATE;\nALTER TABLE links ADD CONSTRAINT c CHECK (true);`,
    };
    const beforeTrigger = { name: '0000-early.sql', sql: broken.sql };
    expect(findPendingTriggerAlters([trigger, broken])).toEqual(['0002-broken.sql: links']);
    expect(findPendingTriggerAlters([trigger, fixed])).toEqual([]);
    expect(findPendingTriggerAlters([beforeTrigger, trigger])).toEqual([]);
  });
});
