/**
 * Wisp W08 — `WISP_ENTITY_KINDS` (@breeze/shared) mirrors the
 * `wisp_thread_links_entity_kind_chk` CHECK in the migration that creates
 * `wisp_thread_links`. Change both together. Reads the source tree only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WISP_ENTITY_KINDS } from '@breeze/shared';

const MIGRATIONS = resolve(import.meta.dirname, '../../../migrations');

describe('WISP_ENTITY_KINDS ↔ wisp_thread_links CHECK', () => {
  it('lists exactly the CHECK kinds, in order', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('-wisp-thread-links.sql'));
    expect(files).toHaveLength(1);
    const sql = readFileSync(resolve(MIGRATIONS, files[0]!), 'utf8');
    const m = sql.match(/wisp_thread_links_entity_kind_chk\s+CHECK\s*\(\s*entity_kind\s+IN\s*\(([^)]*)\)/i);
    expect(m, 'entity_kind CHECK not found').toBeTruthy();
    const kinds = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(kinds).toEqual([...WISP_ENTITY_KINDS]);
  });
});
