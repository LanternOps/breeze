import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getTableColumns } from 'drizzle-orm';
import { aiAgentCircuitState, AI_AGENT_CIRCUIT_STATES } from './aiAgentCircuitState';

describe('AI_AGENT_CIRCUIT_STATES', () => {
  it('has exactly closed and open', () => {
    expect(AI_AGENT_CIRCUIT_STATES).toEqual(['closed', 'open']);
  });

  it('matches the SQL CHECK constraint literals exactly', () => {
    const sqlPath = new URL(
      '../../../migrations/2026-09-18-ai-agents-safety-controls.sql',
      import.meta.url,
    );
    const sql = readFileSync(sqlPath, 'utf8');

    const check = /ai_agent_circuit_state_state_chk\s+CHECK\s*\(\s*state\s+IN\s*\(([^)]*)\)\s*\)/i.exec(sql);
    const memberList = check?.[1];
    expect(memberList, 'ai_agent_circuit_state_state_chk CHECK constraint not found in the migration').toBeDefined();

    const literals = (memberList ?? '')
      .split(',')
      .map((raw) => raw.trim())
      .filter((raw) => raw.length > 0)
      .map((raw) => {
        expect(raw, `CHECK member ${raw} is not a single-quoted literal`).toMatch(/^'[^']*'$/);
        return raw.slice(1, -1);
      });

    expect([...literals].sort()).toEqual([...AI_AGENT_CIRCUIT_STATES].sort());
  });
});

describe('ai_agent_circuit_state schema', () => {
  it('exposes exactly the circuit-state columns', () => {
    const cols = getTableColumns(aiAgentCircuitState);
    expect(Object.keys(cols).sort()).toEqual(
      [
        'orgId', 'agentId', 'partnerId', 'consecutiveFailures', 'state', 'openedAt',
        'openedReason', 'lastRunId', 'lastTransitionAt', 'resetBy', 'resetAt',
      ].sort(),
    );
  });

  it('requires org_id, agent_id, partner_id, consecutive_failures, and state', () => {
    const cols = getTableColumns(aiAgentCircuitState);
    expect(cols.orgId.notNull).toBe(true);
    expect(cols.agentId.notNull).toBe(true);
    expect(cols.partnerId.notNull).toBe(true);
    expect(cols.consecutiveFailures.notNull).toBe(true);
    expect(cols.state.notNull).toBe(true);
  });

  it('leaves opened_at, opened_reason, last_run_id, reset_by, reset_at nullable', () => {
    const cols = getTableColumns(aiAgentCircuitState);
    expect(cols.openedAt.notNull).toBe(false);
    expect(cols.openedReason.notNull).toBe(false);
    expect(cols.lastRunId.notNull).toBe(false);
    expect(cols.resetBy.notNull).toBe(false);
    expect(cols.resetAt.notNull).toBe(false);
  });

  it('defaults consecutive_failures to 0, state to closed, and last_transition_at to now()', () => {
    const cols = getTableColumns(aiAgentCircuitState);
    expect(cols.consecutiveFailures.hasDefault).toBe(true);
    expect(cols.state.hasDefault).toBe(true);
    expect(cols.lastTransitionAt.notNull).toBe(true);
    expect(cols.lastTransitionAt.hasDefault).toBe(true);
  });
});
