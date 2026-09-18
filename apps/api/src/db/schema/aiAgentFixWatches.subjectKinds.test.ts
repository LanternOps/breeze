/**
 * Contract: `ai_agent_fix_watches_subject_kind_chk` names exactly
 * `AI_SWEEP_KINDS` (#5751 W02, #5753).
 *
 * `aiAgentSchedulesPartnerRls.integration.test.ts` enforces the same
 * value-set contract for `ai_agent_schedules_kinds_chk` — but it needs a live
 * database, so a drift there only reds two CI jobs later. This asserts it at
 * UNIT level by parsing the migration file, so W03 adding `expiring_certs` to
 * `AI_SWEEP_KINDS` and not to the CHECK (or the reverse) reds in **Test API**.
 *
 * Both directions matter. A kind in the catalog but missing from the CHECK is
 * a runtime 23514 the first time that kind mints a watch; a kind in the CHECK
 * but not in the catalog is a value no code can ever produce, which quietly
 * advertises support that does not exist.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_SWEEP_KINDS } from '@breeze/shared';

const MIGRATIONS_DIR = join(__dirname, '../../../migrations');

/**
 * The migration that declares the CHECK **last** in apply order is the one
 * that decides the live constraint. A shipped migration is never edited, so a
 * later wave adding a kind re-declares the constraint in its own file (#5754
 * did exactly that for `expiring_certs`); pinning a fixed filename here would
 * have asserted against a superseded definition.
 */
function effectiveMigration(constraint: string): string {
  const declaring = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}-.*\.sql$/.test(f))
    .sort((a, b) => a.localeCompare(b))
    .filter((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), 'utf8').includes(`ADD CONSTRAINT ${constraint}`),
    );
  expect(declaring.length, `no migration declares ${constraint}`).toBeGreaterThan(0);
  return join(MIGRATIONS_DIR, declaring[declaring.length - 1]!);
}

const MIGRATION = effectiveMigration('ai_agent_fix_watches_subject_kind_chk');

/** W02's own file — the one that created the table and the shape constraint. */
const ORIGIN_MIGRATION = join(MIGRATIONS_DIR, '2026-10-16-190300-sweep-condition-fix-watches.sql');

/** The quoted literals of the `subject_kind IN (...)` list, in file order. */
function checkConstraintKinds(sql: string): string[] {
  const constraint = sql.match(
    /ADD CONSTRAINT ai_agent_fix_watches_subject_kind_chk\s+CHECK\s*\(([\s\S]*?)\);/,
  );
  expect(constraint, 'the subject_kind CHECK is not in the migration').not.toBeNull();
  const inList = constraint![1]!.match(/subject_kind IN \(([\s\S]*?)\)/);
  expect(inList, 'the subject_kind CHECK has no IN (...) value list').not.toBeNull();
  return [...inList![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('ai_agent_fix_watches_subject_kind_chk', () => {
  it('names exactly AI_SWEEP_KINDS', () => {
    const kinds = checkConstraintKinds(readFileSync(MIGRATION, 'utf8'));

    // Set equality, asserted in BOTH directions rather than by comparing
    // sorted arrays, so a failure names the specific missing value.
    for (const kind of AI_SWEEP_KINDS) {
      expect(kinds, `AI_SWEEP_KINDS has '${kind}' but the CHECK does not`).toContain(kind);
    }
    for (const kind of kinds) {
      expect(
        AI_SWEEP_KINDS as readonly string[],
        `the CHECK has '${kind}' but AI_SWEEP_KINDS does not`,
      ).toContain(kind);
    }
    expect(new Set(kinds).size, 'the CHECK repeats a kind').toBe(kinds.length);
  });

  it('allows NULL — a NULL subject_kind is how an alert-anchored watch is recognised', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql).toMatch(/CHECK \(subject_kind IS NULL OR subject_kind IN/);
  });

  it('pairs subject_kind with subject_key both-or-neither', () => {
    const sql = readFileSync(ORIGIN_MIGRATION, 'utf8');
    expect(sql).toMatch(
      /ai_agent_fix_watches_subject_shape_chk\s+CHECK \(\(subject_kind IS NULL\) = \(subject_key IS NULL\)\)/,
    );
  });

  it('writes no DML — an existing watch is already correctly classified by subject_kind IS NULL', () => {
    const sql = readFileSync(MIGRATION, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT|MERGE)\b/i);
  });
});
