/**
 * Wisp companion W02a (#10212) — `WISP_TIMELINE_POST_KINDS` (@breeze/shared)
 * mirrors the `wisp_thread_posts_kind_chk` CHECK in the migration that creates
 * `wisp_thread_posts`, and the Drizzle schema's CHECK. Change all together.
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
  it('the migration CHECK lists exactly the shared kinds, in order', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('-wisp-thread-posts.sql'));
    expect(files).toHaveLength(1);
    const sql = readFileSync(resolve(MIGRATIONS, files[0]!), 'utf8');
    expect(kindsIn(sql, /wisp_thread_posts_kind_chk\s+CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)/i)).toEqual([...WISP_TIMELINE_POST_KINDS]);
  });

  it('the Drizzle CHECK lists the same kinds', () => {
    const src = readFileSync(SCHEMA, 'utf8');
    expect(kindsIn(src, /wisp_thread_posts_kind_chk',\s*sql`\$\{t\.kind\}\s+IN\s*\(([^)]*)\)/)).toEqual([...WISP_TIMELINE_POST_KINDS]);
  });
});
