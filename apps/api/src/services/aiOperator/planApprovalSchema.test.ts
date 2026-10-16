/**
 * Plan-approval schema contract (Recipe Library E4, #6169).
 *
 * The CHECK lists in the creating migration, the Drizzle `as const` arrays and
 * the @breeze/shared arrays are hand-written in three places (no pgEnum under
 * forced RLS), so this test is what keeps them together. It also pins the
 * structural properties the release-time membership check leans on: forced
 * RLS in the creating migration, deferrable composite FKs, immutable effect
 * rows, a closed effect set, and the one-shot intent link.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES as SHARED_EFFECT_IDEMPOTENCY_CLASSES,
  AI_OPERATOR_PLAN_APPROVAL_STATES as SHARED_PLAN_APPROVAL_STATES,
} from '@breeze/shared';
import {
  AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES as SCHEMA_EFFECT_IDEMPOTENCY_CLASSES,
  AI_OPERATOR_EFFECT_PROVIDERS as SCHEMA_EFFECT_PROVIDERS,
  AI_OPERATOR_PLAN_APPROVAL_STATES as SCHEMA_PLAN_APPROVAL_STATES,
} from '../../db/schema/aiOperatorPlanApprovals';

const MIGRATION = readFileSync(
  join(__dirname, '../../../migrations/2026-12-23-190000-ai-operator-plan-approvals.sql'),
  'utf8',
);

function checkMembers(sql: string, column: string): string[] {
  const m = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(sql);
  if (!m) throw new Error(`no CHECK found for ${column} — the migration shape changed; fix this test`);
  return m[1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

describe('plan-approval schema parity (E4)', () => {
  it('state CHECK === schema array === shared array', () => {
    expect(checkMembers(MIGRATION, 'state')).toEqual([...SHARED_PLAN_APPROVAL_STATES]);
    expect([...SCHEMA_PLAN_APPROVAL_STATES]).toEqual([...SHARED_PLAN_APPROVAL_STATES]);
  });

  it('idempotency_class CHECK === schema array === shared array', () => {
    expect(checkMembers(MIGRATION, 'idempotency_class')).toEqual([...SHARED_EFFECT_IDEMPOTENCY_CLASSES]);
    expect([...SCHEMA_EFFECT_IDEMPOTENCY_CLASSES]).toEqual([...SHARED_EFFECT_IDEMPOTENCY_CLASSES]);
  });

  it('provider CHECK === schema array', () => {
    expect(checkMembers(MIGRATION, 'provider')).toEqual([...SCHEMA_EFFECT_PROVIDERS]);
  });

  it('both tables FORCE row level security with four policies in the creating migration', () => {
    for (const t of ['ai_operator_plan_approvals', 'ai_operator_plan_approval_effects']) {
      expect(MIGRATION).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      expect(MIGRATION).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      for (const cmd of ['select', 'insert', 'update', 'delete']) {
        expect(MIGRATION).toContain(`breeze_org_isolation_${cmd}_${t}`);
      }
    }
  });

  it('every composite FK that references an org_id column is DEFERRABLE INITIALLY IMMEDIATE', () => {
    const fks = MIGRATION.match(/ADD CONSTRAINT[\s\S]*?FOREIGN KEY[\s\S]*?(?=;)/g) ?? [];
    expect(fks.length).toBeGreaterThanOrEqual(4);
    for (const fk of fks) {
      if (/org_id/.test(fk)) expect(fk).toMatch(/DEFERRABLE INITIALLY IMMEDIATE/);
    }
  });

  it('effect rows are immutable and the set is closed once linked', () => {
    expect(MIGRATION).toMatch(/REVOKE UPDATE ON ai_operator_plan_approval_effects FROM breeze_app/);
    expect(MIGRATION).toMatch(/BEFORE UPDATE ON ai_operator_plan_approval_effects/);
    expect(MIGRATION).toMatch(/BEFORE INSERT ON ai_operator_plan_approval_effects/);
    expect(MIGRATION).toMatch(/BEFORE UPDATE ON ai_operator_plan_approvals/);
  });

  it('a decided plan must carry its intent link', () => {
    expect(MIGRATION).toMatch(/CHECK \(state NOT IN \('approved','rejected'\) OR intent_id IS NOT NULL\)/);
  });

  it('the migration writes no rows, so it needs no breeze.scope election', () => {
    expect(MIGRATION).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/im);
  });
});
