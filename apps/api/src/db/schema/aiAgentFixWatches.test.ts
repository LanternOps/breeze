import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getTableColumns } from 'drizzle-orm';
import { aiAgentFixWatches, AI_AGENT_FIX_WATCH_STATES } from './aiAgentFixWatches';

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

    const check = /ai_agent_fix_watches_state_chk\s+CHECK\s*\(\s*state\s+IN\s*\(([^)]*)\)\s*\)/i.exec(sql);
    const memberList = check?.[1];
    expect(memberList, 'ai_agent_fix_watches_state_chk CHECK constraint not found in the migration').toBeDefined();

    const literals = (memberList ?? '')
      .split(',')
      .map((raw) => raw.trim())
      .filter((raw) => raw.length > 0)
      .map((raw) => {
        expect(raw, `CHECK member ${raw} is not a single-quoted literal`).toMatch(/^'[^']*'$/);
        return raw.slice(1, -1);
      });

    expect([...literals].sort()).toEqual([...AI_AGENT_FIX_WATCH_STATES].sort());
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
});
