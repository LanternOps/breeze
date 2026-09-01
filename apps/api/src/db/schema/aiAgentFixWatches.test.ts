import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getTableColumns } from 'drizzle-orm';
import {
  aiAgentFixWatches,
  AI_AGENT_FIX_WATCH_SOURCE_KINDS,
  AI_AGENT_FIX_WATCH_STATES,
} from './aiAgentFixWatches';
import { checkConstraintLiterals } from './checkConstraintTestHelpers';

describe('AI_AGENT_FIX_WATCH_STATES', () => {
  it('has exactly the six verdict states', () => {
    expect(AI_AGENT_FIX_WATCH_STATES).toEqual([
      'pending', 'watching', 'recurred', 'held_qualified', 'inconclusive', 'cancelled',
    ]);
  });

  it('matches the SQL CHECK constraint literals exactly', () => {
    const sqlPath = new URL(
      '../../../migrations/2026-09-18-ai-agents-safety-controls.sql',
      import.meta.url,
    );
    const sql = readFileSync(sqlPath, 'utf8');
    const literals = checkConstraintLiterals(sql, 'ai_agent_fix_watches_state_chk', 'state');
    expect([...literals].sort()).toEqual([...AI_AGENT_FIX_WATCH_STATES].sort());
  });
});

describe('AI_AGENT_FIX_WATCH_SOURCE_KINDS', () => {
  it('has exactly the two source kinds', () => {
    expect(AI_AGENT_FIX_WATCH_SOURCE_KINDS).toEqual(['act_run', 'intent']);
  });

  it('matches the SQL CHECK constraint literals exactly (P2-5, #4192)', () => {
    const sqlPath = new URL(
      '../../../migrations/2026-09-29-ai-agents-graduation-evidence.sql',
      import.meta.url,
    );
    const sql = readFileSync(sqlPath, 'utf8');
    const literals = checkConstraintLiterals(sql, 'ai_agent_fix_watches_source_kind_chk', 'source_kind');
    expect([...literals].sort()).toEqual([...AI_AGENT_FIX_WATCH_SOURCE_KINDS].sort());
  });
});

describe('ai_agent_fix_watches schema', () => {
  it('exposes exactly the watch columns', () => {
    const cols = getTableColumns(aiAgentFixWatches);
    expect(Object.keys(cols).sort()).toEqual(
      [
        'id', 'orgId', 'partnerId', 'agentId', 'runId', 'alertId', 'ruleId', 'deviceId',
        'configItemName', 'state', 'recoveryObservedAt', 'dueAt', 'evaluatedAt',
        'recurrenceAlertId', 'notifiedAt', 'createdAt',
        // P2-5 (#4192): intent-anchored fix watches.
        'intentId', 'sourceKind', 'opKeys',
      ].sort(),
    );
  });

  it('requires org_id, partner_id, agent_id, run_id, device_id, and state', () => {
    const cols = getTableColumns(aiAgentFixWatches);
    expect(cols.orgId.notNull).toBe(true);
    expect(cols.partnerId.notNull).toBe(true);
    expect(cols.agentId.notNull).toBe(true);
    expect(cols.runId.notNull).toBe(true);
    expect(cols.deviceId.notNull).toBe(true);
    expect(cols.state.notNull).toBe(true);
  });

  it('leaves alert_id, rule_id, recurrence_alert_id, and the timing columns nullable', () => {
    const cols = getTableColumns(aiAgentFixWatches);
    expect(cols.alertId.notNull).toBe(false);
    expect(cols.ruleId.notNull).toBe(false);
    expect(cols.recurrenceAlertId.notNull).toBe(false);
    expect(cols.recoveryObservedAt.notNull).toBe(false);
    expect(cols.dueAt.notNull).toBe(false);
    expect(cols.evaluatedAt.notNull).toBe(false);
    expect(cols.notifiedAt.notNull).toBe(false);
  });

  it('defaults state to pending and created_at to now()', () => {
    const cols = getTableColumns(aiAgentFixWatches);
    expect(cols.state.hasDefault).toBe(true);
    expect(cols.createdAt.notNull).toBe(true);
    expect(cols.createdAt.hasDefault).toBe(true);
  });

  // P2-5 (#4192): intent-anchored fix watches.
  it('leaves intent_id nullable with no default', () => {
    const cols = getTableColumns(aiAgentFixWatches);
    expect(cols.intentId.notNull).toBe(false);
    expect(cols.intentId.hasDefault).toBe(false);
  });

  it("requires source_kind, defaulting to 'act_run'", () => {
    const cols = getTableColumns(aiAgentFixWatches);
    expect(cols.sourceKind.notNull).toBe(true);
    expect(cols.sourceKind.hasDefault).toBe(true);
  });

  it("requires op_keys, defaulting to '{}'", () => {
    const cols = getTableColumns(aiAgentFixWatches);
    expect(cols.opKeys.notNull).toBe(true);
    expect(cols.opKeys.hasDefault).toBe(true);
  });
});
