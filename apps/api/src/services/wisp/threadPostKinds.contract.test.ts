/**
 * Wisp companion W02a (#10212) — `WISP_TIMELINE_POST_KINDS` (@breeze/shared)
 * mirrors the newest `wisp_thread_posts_kind_chk` CHECK across the migrations
 * (created by *-wisp-thread-posts.sql, widened by later files such as
 * *-wisp-check-ins.sql), and the Drizzle schema's CHECK. Change all together.
 * Reads the source tree only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WISP_TIMELINE_POST_KINDS } from '@breeze/shared';

const MIGRATIONS = resolve(import.meta.dirname, '../../../migrations');
const SCHEMA = resolve(import.meta.dirname, '../../db/schema/wispThreadPosts.ts');

const kindsIn = (text: string, re: RegExp): string[] => {
  const m = text.match(re);
  expect(m, `kind CHECK not found by ${re}`).toBeTruthy();
  return [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
};

describe('WISP_TIMELINE_POST_KINDS ↔ wisp_thread_posts CHECK', () => {
  it('the newest migration CHECK lists exactly the shared kinds, in order', () => {
    // The CHECK is created by *-wisp-thread-posts.sql and widened by later
    // migrations (DROP CONSTRAINT IF EXISTS + ADD), e.g. *-wisp-check-ins.sql.
    // autoMigrate applies files in localeCompare order, so the last definition
    // in that order is the one a fresh database ends up with.
    const re = /wisp_thread_posts_kind_chk\s+CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)/gi;
    const files = readdirSync(MIGRATIONS)
      .filter((f) => /^\d{4}-.*\.sql$/.test(f))
      .sort((a, b) => a.localeCompare(b));
    const defs: { file: string; body: string }[] = [];
    for (const f of files) {
      const sql = readFileSync(resolve(MIGRATIONS, f), 'utf8');
      for (const m of sql.matchAll(re)) defs.push({ file: f, body: m[1]! });
    }
    expect(defs.length, 'no wisp_thread_posts_kind_chk CHECK found in any migration').toBeGreaterThan(0);
    expect(defs[0]!.file).toMatch(/-wisp-thread-posts\.sql$/);
    const last = defs[defs.length - 1]!;
    const kinds = [...last.body.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
    expect(kinds, `kinds in ${last.file}`).toEqual([...WISP_TIMELINE_POST_KINDS]);
  });

  it('the Drizzle CHECK lists the same kinds', () => {
    const src = readFileSync(SCHEMA, 'utf8');
    expect(kindsIn(src, /wisp_thread_posts_kind_chk',\s*sql`\$\{t\.kind\}\s+IN\s*\(([^)]*)\)/)).toEqual([...WISP_TIMELINE_POST_KINDS]);
  });
});
