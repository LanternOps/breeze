// apps/api/src/services/aiAgents/verdictProfile.test.ts
import { describe, expect, it } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import { VERDICT_TOOL_ALLOWLIST, verdictLimits, verdictToolAllowlist } from './verdictProfile';
import { TIER2_ACTIONS, TIER2_READONLY_TOOLS } from '../aiGuardrails';
import { TOOL_TIERS } from '../aiAgentSdkTools';

describe('verdict profile', () => {
  it('pins turns to 3 and budget to verdictBudgetCentsPerRun', () => {
    const l = verdictLimits({ ...AI_AGENT_LIMIT_DEFAULTS, verdictBudgetCentsPerRun: 2 });
    expect(l.maxTurnsPerRun).toBe(3);
    expect(l.maxBudgetCentsPerRun).toBe(2);
    expect(l.maxActionsPerRun).toBe(0);
  });
  it('intersects, never widens, and always includes the outcome tool', () => {
    expect(verdictToolAllowlist(['manage_alerts:list', 'run_script'])).toEqual(['manage_alerts:list', 'submit_alert_verdict']);
    expect(verdictToolAllowlist([])).toEqual(['submit_alert_verdict']);
  });
  it('every allowlisted tool/action is read-only', () => {
    for (const entry of VERDICT_TOOL_ALLOWLIST) {
      // `noUncheckedIndexedAccess` widens array-destructure results to
      // `T | undefined`; `entry` always has a tool segment before an
      // optional `:action` one, by construction of VERDICT_TOOL_ALLOWLIST.
      const [tool, action] = entry.split(':') as [string, string | undefined];
      if (action) expect(TIER2_ACTIONS[tool] ?? []).not.toContain(action);
      else expect(TOOL_TIERS[tool as keyof typeof TOOL_TIERS] === 1 || TIER2_READONLY_TOOLS.has(tool)).toBe(true);
    }
  });
});
