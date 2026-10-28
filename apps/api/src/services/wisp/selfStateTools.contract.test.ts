/**
 * CONTRACT — WISP_SELF_STATE_TOOLS (#10392, wisp/selfStateTools.ts).
 *
 * Membership lets a Wisp chat call skip the per_step approval card. That is
 * safe only while every member stays a Tier-2 write to Wisp's own tables: no
 * device argument, no action multiplexing that could hide a mutating action,
 * no per-action tier escalation, and no read-only classification (which would
 * also change MCP hints and agent allowlists). The tier-3 memory tools and the
 * budget-spending Wisp writes must stay out, and must still require approval.
 *
 * No vi.mock: the real tool registry and guardrail tables are the subject.
 */
import { describe, expect, it } from 'vitest';

import { TOOL_TIERS } from '../aiAgentSdkTools';
import {
  checkGuardrails,
  isReadOnlyResolution,
  TIER1_ACTIONS,
  TIER2_ACTIONS,
  TIER2_READONLY_ACTIONS,
  TIER2_READONLY_TOOLS,
  TIER3_ACTIONS,
  TOOL_ACTION_INPUT_KEYS,
} from '../aiGuardrails';
import { aiTools, getToolTier } from '../aiTools';
import { HUMAN_ONLY_TOOLS } from '../aiToolExposure';
import { WISP_SELF_STATE_TOOLS } from './selfStateTools';

const MEMBERS = [...WISP_SELF_STATE_TOOLS.keys()];

describe('WISP_SELF_STATE_TOOLS contract (#10392)', () => {
  it('is exactly the reviewed bookkeeping set and scopes (a change is a deliberate, reviewed change)', () => {
    expect(Object.fromEntries(WISP_SELF_STATE_TOOLS)).toEqual({
      remember: 'own_memory',
      raise_concern: 'adds_row',
      link_entity: 'adds_row',
      snooze_concern: 'own_concern',
      resolve_concern: 'own_concern',
    });
  });

  it.each(MEMBERS)('%s is a registered Tier-2 ai-domain tool with no device arguments', (tool) => {
    expect(TOOL_TIERS[tool]).toBe(2);
    expect(getToolTier(tool)).toBe(2);
    const entry = aiTools.get(tool);
    expect(entry, `${tool} must be in the aiTools registry`).toBeDefined();
    expect(entry!.domain).toBe('ai');
    expect(entry!.deviceArgs).toEqual([]);
    expect(HUMAN_ONLY_TOOLS.has(tool)).toBe(false);
  });

  it.each(MEMBERS)('%s has no action multiplexing or per-action tier entry', (tool) => {
    expect(TOOL_ACTION_INPUT_KEYS[tool]).toBeUndefined();
    expect(TIER1_ACTIONS[tool]).toBeUndefined();
    expect(TIER2_ACTIONS[tool]).toBeUndefined();
    expect(TIER3_ACTIONS[tool]).toBeUndefined();
  });

  it.each(MEMBERS)('%s stays a WRITE: not read-only anywhere, resolves Tier 2 without readOnly', (tool) => {
    expect(TIER2_READONLY_TOOLS.has(tool)).toBe(false);
    expect(TIER2_READONLY_ACTIONS[tool]).toBeUndefined();
    const check = checkGuardrails(tool, { action: 'delete', ownerKind: 'org' });
    expect(check.allowed).toBe(true);
    expect(check.tier).toBe(2);
    expect(check.readOnly).toBeUndefined();
    expect(isReadOnlyResolution(tool, check)).toBe(false);
  });

  it.each(['confirm_memory', 'retract_memory', 'create_watch', 'launch_specialist', 'manage_patches', 'execute_command'])(
    '%s is not a member',
    (tool) => {
      expect(WISP_SELF_STATE_TOOLS.has(tool)).toBe(false);
    },
  );

  it.each(['confirm_memory', 'retract_memory'])('%s still resolves Tier 3 and requires approval', (tool) => {
    const check = checkGuardrails(tool, { blockId: '00000000-0000-4000-8000-000000000001' });
    expect(check.tier).toBe(3);
    expect(check.requiresApproval).toBe(true);
  });

  it('asks-first specialist kinds still escalate launch_specialist to Tier 3 with approval', () => {
    const check = checkGuardrails('launch_specialist', { kind: 'patch_plan', orgId: '00000000-0000-4000-8000-000000000001' });
    expect(check.tier).toBe(3);
    expect(check.requiresApproval).toBe(true);
  });
});
