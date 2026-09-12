import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { aiScriptPolicies } from './aiScriptPolicies';
import { aiScriptLaneState } from './aiScriptLaneState';
import { actionIntents } from './actionIntents';

describe('ai script lane schema', () => {
  it('ai_script_policies is dual-owner: both axes nullable', () => {
    const cols = Object.fromEntries(getTableConfig(aiScriptPolicies).columns.map((c) => [c.name, c]));
    expect(cols.org_id!.notNull).toBe(false);
    expect(cols.partner_id!.notNull).toBe(false);
    expect(cols.unattended_allowed!.notNull).toBe(true);
    expect(cols.unattended_enabled!.notNull).toBe(true);
  });

  it('ai_script_lane_state is keyed on org_id alone', () => {
    const cfg = getTableConfig(aiScriptLaneState);
    expect(cfg.columns.find((c) => c.name === 'org_id')!.primary).toBe(true);
    expect(cfg.columns.map((c) => c.name)).not.toContain('id');
  });

  it('action_intents carries the script reviewer evidence column', () => {
    expect(getTableConfig(actionIntents).columns.map((c) => c.name)).toContain('script_reviewer_evidence');
  });
});
