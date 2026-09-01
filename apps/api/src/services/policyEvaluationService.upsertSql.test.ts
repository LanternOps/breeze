/**
 * #4122 — `automation_policy_compliance` upserts must be atomic.
 *
 * The bug this guards was NOT "the wrong function was called". It was a
 * select-then-insert whose read/write gap let two concurrent policy
 * evaluations both insert for the same key, against a table with no uniqueness
 * at all. A call-shape assertion (`expect(db.insert).toHaveBeenCalled()`, or
 * `expect.objectContaining({ target: expect.any(Array) })` against a mocked
 * `../db`) reproduces that bug class exactly: it stays green when the conflict
 * target names the wrong columns, when `targetWhere` is dropped so Postgres
 * cannot infer the partial index (42P10), and when the arbiter drifts away
 * from the index the migration actually created.
 *
 * So this file deliberately does NOT mock `../db` — the real Drizzle builder
 * compiles real SQL — and it cross-checks that SQL against the migration file
 * and the Drizzle schema, the two other places the same predicate is written.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  buildConfigPolicyComplianceUpsert,
  buildPolicyComplianceUpsert,
} from './policyEvaluationService';
import { automationPolicyCompliance } from '../db/schema';

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/2026-09-29-100000-automation-policy-compliance-unique.sql',
);

const POLICY_INDEX = 'apc_policy_device_uq';
const CONFIG_INDEX = 'apc_config_policy_item_device_uq';

/** Collapse whitespace and drop `"automation_policy_compliance".` / quoting so
 *  a migration predicate and a compiled Drizzle predicate become comparable. */
function normalizePredicate(raw: string): string {
  return raw
    .replace(/"automation_policy_compliance"\./g, '')
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\(|\)$/g, '')
    .trim()
    .toLowerCase();
}

/** Parse `CREATE UNIQUE INDEX ... <name> ON <table> (cols) WHERE <pred>;` out of
 *  the migration, so the test fails if the migration is edited out of step. */
function readMigrationIndex(indexName: string): { columns: string[]; predicate: string } {
  const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
  const match = new RegExp(
    String.raw`CREATE UNIQUE INDEX IF NOT EXISTS ${indexName}\s+ON automation_policy_compliance\s*\(([^)]*)\)\s*WHERE ([^;]+);`,
    'i',
  ).exec(migrationSql);
  const [, columnList, predicate] = match ?? [];
  if (columnList === undefined || predicate === undefined) {
    throw new Error(`migration ${path.basename(MIGRATION_PATH)} has no unique index ${indexName}`);
  }
  return {
    columns: columnList.split(',').map((column) => column.trim()),
    predicate: normalizePredicate(predicate),
  };
}

/** Pull the `on conflict (...) where ... do update set ...` clause apart. */
function parseOnConflict(sql: string): { columns: string[]; predicate: string; setList: string } {
  const match = /on conflict \(([^)]*)\)\s*where (.+?) do update set (.*)$/is.exec(sql);
  const [, columnList, predicate, setList] = match ?? [];
  if (columnList === undefined || predicate === undefined || setList === undefined) {
    throw new Error(`compiled SQL has no partial-index ON CONFLICT arbiter:\n${sql}`);
  }
  return {
    columns: columnList.split(',').map((column) => column.trim().replace(/"/g, '')),
    predicate: normalizePredicate(predicate),
    setList,
  };
}

const CHECKED_AT = new Date('2026-09-29T10:00:00.000Z');

function policySql() {
  return buildPolicyComplianceUpsert({
    policyId: 'pol-1',
    deviceId: 'dev-1',
    status: 'non_compliant',
    details: { passed: false },
    checkedAt: CHECKED_AT,
  }).toSQL();
}

function configSql() {
  return buildConfigPolicyComplianceUpsert({
    configPolicyId: 'fl-1',
    configItemName: 'Disk space',
    deviceId: 'dev-1',
    status: 'compliant',
    details: { passed: true },
    checkedAt: CHECKED_AT,
  }).toSQL();
}

describe('buildPolicyComplianceUpsert — compiled SQL', () => {
  it('is a single INSERT ... ON CONFLICT, not a select-then-insert', () => {
    const { sql } = policySql();
    expect(sql).toMatch(/^insert into "automation_policy_compliance"/i);
    expect(sql).toMatch(/ do update set /i);
  });

  it('arbitrates on (policy_id, device_id) with the partial-index predicate', () => {
    const { columns, predicate } = parseOnConflict(policySql().sql);
    expect(columns).toEqual(['policy_id', 'device_id']);
    // Without this predicate Postgres cannot infer the PARTIAL index and the
    // statement fails 42P10 at runtime — a green call-shape test would not see it.
    expect(predicate).toBe('policy_id is not null');
  });

  it('updates status/details/last_checked_at/updated_at and preserves remediation_attempts', () => {
    const { sql, params } = policySql();
    const { setList } = parseOnConflict(sql);
    expect(setList).toMatch(/"status" = /i);
    expect(setList).toMatch(/"details" = /i);
    expect(setList).toMatch(/"last_checked_at" = /i);
    expect(setList).toMatch(/"updated_at" = /i);
    // The counter belongs to the remediation path; re-evaluating must not reset
    // it. Drizzle still names it in the INSERT column list (as `default`, so a
    // brand-new row gets 0) — what matters is that it is absent from the SET
    // list, which is the only branch that touches an existing row.
    expect(setList).not.toMatch(/remediation_attempts/i);
    expect(params).toEqual(expect.arrayContaining(['pol-1', 'dev-1', 'non_compliant']));
  });
});

describe('buildConfigPolicyComplianceUpsert — compiled SQL', () => {
  it('arbitrates on (config_policy_id, config_item_name, device_id) with both NOT NULL legs', () => {
    const { columns, predicate } = parseOnConflict(configSql().sql);
    expect(columns).toEqual(['config_policy_id', 'config_item_name', 'device_id']);
    // Both legs are required: config_item_name is nullable, and an index
    // predicate the statement does not imply is not inferable.
    expect(predicate).toBe('config_policy_id is not null and config_item_name is not null');
  });

  it('writes policy_id NULL so the row cannot also land in the policy-axis index', () => {
    const { sql, params } = configSql();
    expect(sql).toMatch(/"policy_id"/);
    expect(params).toEqual(expect.arrayContaining([null, 'fl-1', 'Disk space', 'dev-1', 'compliant']));
  });

  it('preserves remediation_attempts on the conflict branch', () => {
    expect(parseOnConflict(configSql().sql).setList).not.toMatch(/remediation_attempts/i);
  });
});

/**
 * The same two predicates are written in three places (migration, Drizzle
 * schema, service). Postgres infers a partial index as an ON CONFLICT arbiter
 * only when the statement's predicate implies the index's, so drift between
 * any two of them is a runtime 42P10 or — worse — a silently unenforced
 * uniqueness. These assert the three copies still agree.
 */
describe('unique-index lockstep: migration ↔ schema ↔ upsert', () => {
  it.each([
    [POLICY_INDEX, policySql],
    [CONFIG_INDEX, configSql],
  ])('%s matches the compiled ON CONFLICT arbiter', (indexName, build) => {
    const migrationIndex = readMigrationIndex(indexName as string);
    const arbiter = parseOnConflict((build as () => { sql: string })().sql);
    expect(arbiter.columns).toEqual(migrationIndex.columns);
    expect(arbiter.predicate).toBe(migrationIndex.predicate);
  });

  it('the Drizzle schema declares both partial unique indexes', () => {
    const { indexes } = getTableConfig(automationPolicyCompliance);
    const byName = new Map(indexes.map((entry) => [entry.config.name, entry.config]));

    for (const indexName of [POLICY_INDEX, CONFIG_INDEX]) {
      const declared = byName.get(indexName);
      // Drift here is what `pnpm db:check-drift` reports; asserting it in the
      // unit suite means CI catches a schema/migration split without a live DB.
      expect(declared, `${indexName} missing from the Drizzle schema`).toBeDefined();
      expect(declared?.unique).toBe(true);
      expect(declared?.where, `${indexName} must stay a PARTIAL index`).toBeDefined();

      const migrationIndex = readMigrationIndex(indexName);
      const declaredColumns = (declared?.columns ?? []).map(
        (column) => (column as { name?: string }).name,
      );
      expect(declaredColumns).toEqual(migrationIndex.columns);
    }
  });
});
