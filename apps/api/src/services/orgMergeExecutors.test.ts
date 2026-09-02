/**
 * Compiled-SQL unit tests for the org-merge policy executors (org-lifecycle
 * Wave 2, Task 2). Per repo convention, assertions run the drizzle `SQL`
 * objects through `PgDialect().sqlToQuery()` and compare the actual compiled
 * text + params — never mock-call shapes.
 *
 * Also exercises every `key`/`keyWhere` literal SHAPE the registry can declare,
 * so a future entry using a new literal form (not just the two examples in the
 * task brief) is guaranteed to compile here before it ever reaches Postgres.
 *
 * Two of the shape probes below name tables — `incidents` and
 * `playbook_definitions` — that the final review reclassified from
 * `repoint-dedupe` to `custom`, because their dedupe DELETE either aborted the
 * merge on NOT NULL NO ACTION children or destroyed an incident's case file.
 * The probes are KEPT rather than retargeted: the shapes they pin (a `{col}`
 * partial predicate, an expression key) are both still live — `action_intents`
 * declares the first, and `orgMergeCustomExecutors.ts`'s `keyMatch` builds the
 * second through the very same exported `keyExpr`. `getOrgMergePolicies()`-driven
 * loops at the bottom of each describe block are the ones that track what the
 * registry actually declares today.
 */
import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  buildRepoint,
  buildKeepSurvivor,
  buildKeepSurvivorDropCount,
  buildRepointDedupe,
  buildRepointDedupeDropCount,
  keyExpr,
} from './orgMergeExecutors';
import { getOrgMergePolicies } from './orgMergeRegistry';

const dialect = new PgDialect();
const L = '11111111-1111-1111-1111-111111111111';
const S = '22222222-2222-2222-2222-222222222222';
const compile = (q: SQL) => dialect.sqlToQuery(q);
type Compiled = ReturnType<typeof compile>;

// Builder signatures return `SQL[]` (per the Task 3 consumer contract, not a
// fixed-length tuple), so under `noUncheckedIndexedAccess` a plain
// `[a, b] = arr` destructure types each element as possibly `undefined`.
// These two helpers assert (and encode) the known-fixed arity of each
// builder's output at the test boundary, matching the repo's existing
// `as [Type, ...]` convention for narrowing array results in tests.
const pair = (arr: Compiled[]): [Compiled, Compiled] => arr as [Compiled, Compiled];
const single = (arr: Compiled[]): [Compiled] => arr as [Compiled];

describe('orgMergeExecutors', () => {
  it('repoint updates org_id for the loser only', () => {
    const { sql: text, params } = compile(buildRepoint('quotes', L, S));
    expect(text).toBe('UPDATE "quotes" SET org_id = $1::uuid WHERE org_id = $2::uuid');
    expect(params).toEqual([S, L]);
  });

  it('keep-survivor deletes loser rows only when survivor has one, then repoints', () => {
    const [del, repoint] = pair(buildKeepSurvivor('portal_branding', L, S).map(compile));
    expect(del.sql).toBe(
      'DELETE FROM "portal_branding" WHERE org_id = $1::uuid AND EXISTS (SELECT 1 FROM "portal_branding" s WHERE s.org_id = $2::uuid)'
    );
    expect(del.params).toEqual([L, S]);
    expect(repoint.sql).toBe('UPDATE "portal_branding" SET org_id = $1::uuid WHERE org_id = $2::uuid');
    expect(repoint.params).toEqual([S, L]);
  });

  it('repoint-dedupe deletes colliding loser rows on the key, honoring keyWhere on both sides', () => {
    const [del, repoint] = pair(buildRepointDedupe(
      'incidents',
      ['source_type', 'source_ref'],
      '{source_ref} IS NOT NULL',
      L,
      S,
    ).map(compile));
    expect(del.sql).toBe(
      'DELETE FROM "incidents" t WHERE t.org_id = $1::uuid AND (t.source_ref IS NOT NULL) AND EXISTS (' +
        'SELECT 1 FROM "incidents" s WHERE s.org_id = $2::uuid AND (s.source_ref IS NOT NULL) ' +
        'AND s.source_type IS NOT DISTINCT FROM t.source_type AND s.source_ref IS NOT DISTINCT FROM t.source_ref)'
    );
    expect(del.params).toEqual([L, S]);
    expect(repoint.sql).toBe('UPDATE "incidents" SET org_id = $1::uuid WHERE org_id = $2::uuid');
  });

  it('expression keys substitute the alias into {col} placeholders', () => {
    const [del] = single(buildRepointDedupe('playbook_definitions', ['lower({name})'], undefined, L, S).map(compile));
    expect(del.sql).toContain('lower(s.name) IS NOT DISTINCT FROM lower(t.name)');
  });

  it('plain (non-braced) key columns get the alias prefixed directly', () => {
    const [del] = single(buildRepointDedupe('m365_connections', ['profile'], undefined, L, S).map(compile));
    expect(del.sql).toBe(
      'DELETE FROM "m365_connections" t WHERE t.org_id = $1::uuid AND EXISTS (' +
        'SELECT 1 FROM "m365_connections" s WHERE s.org_id = $2::uuid ' +
        'AND s.profile IS NOT DISTINCT FROM t.profile)'
    );
    expect(del.params).toEqual([L, S]);
  });

  it('multi-column keys AND every column match together', () => {
    const [del] = single(buildRepointDedupe(
      'client_ai_usage',
      ['client_user_id', 'period', 'period_key'],
      undefined,
      L,
      S,
    ).map(compile));
    expect(del.sql).toBe(
      'DELETE FROM "client_ai_usage" t WHERE t.org_id = $1::uuid AND EXISTS (' +
        'SELECT 1 FROM "client_ai_usage" s WHERE s.org_id = $2::uuid ' +
        'AND s.client_user_id IS NOT DISTINCT FROM t.client_user_id ' +
        'AND s.period IS NOT DISTINCT FROM t.period ' +
        'AND s.period_key IS NOT DISTINCT FROM t.period_key)'
    );
  });

  it('an expression key mixing a placeholder with a literal (COALESCE .. uuid cast) substitutes only the placeholder', () => {
    const [del] = single(buildRepointDedupe(
      'tunnel_allowlists',
      ['direction', 'pattern', "COALESCE({site_id}, '00000000-0000-0000-0000-000000000000'::uuid)"],
      undefined,
      L,
      S,
    ).map(compile));
    expect(del.sql).toContain(
      "COALESCE(s.site_id, '00000000-0000-0000-0000-000000000000'::uuid) IS NOT DISTINCT FROM " +
        "COALESCE(t.site_id, '00000000-0000-0000-0000-000000000000'::uuid)"
    );
  });

  it('a keyWhere with an IN-list substitutes the alias and stays scoped to that alias only', () => {
    const [del] = single(buildRepointDedupe(
      'action_intents',
      ['idempotency_key'],
      "{status} IN ('pending_approval','approved','executing')",
      L,
      S,
    ).map(compile));
    expect(del.sql).toBe(
      'DELETE FROM "action_intents" t WHERE t.org_id = $1::uuid AND (t.status IN (\'pending_approval\',\'approved\',\'executing\')) AND EXISTS (' +
        'SELECT 1 FROM "action_intents" s WHERE s.org_id = $2::uuid AND (s.status IN (\'pending_approval\',\'approved\',\'executing\')) ' +
        'AND s.idempotency_key IS NOT DISTINCT FROM t.idempotency_key)'
    );
  });

  it('every real repoint-dedupe registry entry compiles without throwing', () => {
    const policies = getOrgMergePolicies();
    for (const [table, policy] of policies) {
      if (policy.kind !== 'repoint-dedupe') continue;
      expect(() => buildRepointDedupe(table, policy.key, policy.keyWhere, L, S).map(compile), table).not.toThrow();
    }
  });
});

/**
 * The preview's would-drop column must count EXACTLY the rows the merge would
 * delete. These assertions pin each count mirror's predicate against its
 * DELETE twin's, so a one-sided edit — the way a preview silently starts
 * lying — fails here rather than in production.
 */
describe('orgMergeExecutors would-drop count mirrors', () => {
  const predicateOf = (text: string) => text.slice(text.indexOf(' WHERE '));

  it('keep-survivor count shares its DELETE twin predicate verbatim', () => {
    const [del] = pair(buildKeepSurvivor('portal_branding', L, S).map(compile));
    const count = compile(buildKeepSurvivorDropCount('portal_branding', L, S));
    expect(count.sql).toBe(
      'SELECT count(*)::int AS n FROM "portal_branding" WHERE org_id = $1::uuid AND EXISTS (SELECT 1 FROM "portal_branding" s WHERE s.org_id = $2::uuid)'
    );
    expect(count.params).toEqual([L, S]);
    expect(predicateOf(count.sql)).toBe(predicateOf(del.sql));
  });

  it('repoint-dedupe count shares its DELETE twin predicate verbatim, keyWhere included', () => {
    const [del] = single(
      buildRepointDedupe('incidents', ['source_type', 'source_ref'], '{source_ref} IS NOT NULL', L, S).map(compile)
    );
    const count = compile(
      buildRepointDedupeDropCount('incidents', ['source_type', 'source_ref'], '{source_ref} IS NOT NULL', L, S)
    );
    expect(count.sql).toBe(
      'SELECT count(*)::int AS n FROM "incidents" t WHERE t.org_id = $1::uuid AND (t.source_ref IS NOT NULL) AND EXISTS (' +
        'SELECT 1 FROM "incidents" s WHERE s.org_id = $2::uuid AND (s.source_ref IS NOT NULL) ' +
        'AND s.source_type IS NOT DISTINCT FROM t.source_type AND s.source_ref IS NOT DISTINCT FROM t.source_ref)'
    );
    expect(count.params).toEqual([L, S]);
    expect(predicateOf(count.sql)).toBe(predicateOf(del.sql));
  });

  it('every real keep-survivor / repoint-dedupe entry has a compilable count mirror', () => {
    let covered = 0;
    for (const [table, policy] of getOrgMergePolicies()) {
      if (policy.kind === 'keep-survivor') {
        const [del] = pair(buildKeepSurvivor(table, L, S).map(compile));
        expect(predicateOf(compile(buildKeepSurvivorDropCount(table, L, S)).sql), table).toBe(predicateOf(del.sql));
        covered++;
      } else if (policy.kind === 'repoint-dedupe') {
        const [del] = single(buildRepointDedupe(table, policy.key, policy.keyWhere, L, S).map(compile));
        const count = compile(buildRepointDedupeDropCount(table, policy.key, policy.keyWhere, L, S));
        expect(predicateOf(count.sql), table).toBe(predicateOf(del.sql));
        covered++;
      }
    }
    // Guard against the loop passing vacuously over an empty registry.
    expect(covered).toBeGreaterThan(20);
  });
});

/**
 * `keyExpr` is exported so the custom executors' re-home-then-delete helper
 * resolves unique keys through the SAME substitution these builders use. Pin it
 * directly: it is now shared across two files, and a change made for one of
 * them silently changes the other's collision predicate.
 */
describe('keyExpr substitution (shared with orgMergeCustomExecutors)', () => {
  it('prefixes a bare column name with the alias', () => {
    expect(compile(keyExpr('ip_address', 't')).sql).toBe('t.ip_address');
  });

  it('substitutes every {col} placeholder inside an expression, leaving literals alone', () => {
    expect(compile(keyExpr('lower({name})', 's')).sql).toBe('lower(s.name)');
    expect(compile(keyExpr("COALESCE({site_id}, '0'::uuid)", 't')).sql).toBe(
      "COALESCE(t.site_id, '0'::uuid)",
    );
  });
});
