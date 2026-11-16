/**
 * CONTRACT — TIER2_NOTE_WRITE_TOOLS (aiNoteWrites.ts).
 *
 * Membership lets a chat call skip the per_step approval card in ANY chat, with
 * or without a Wisp grant. That is safe only while every member is an
 * append-only note: Tier 2, one action, nothing sent to a device, and never
 * classified read-only (which would also change MCP hints and agent
 * allowlists). Anything that edits, hides or deletes existing state stays out.
 *
 * No vi.mock: the real tool registry and guardrail tables are the subject.
 */
import { describe, expect, it } from 'vitest';

import { TOOL_TIERS } from './aiAgentSdkTools';
import {
  checkGuardrails,
  isReadOnlyResolution,
  TIER1_ACTIONS,
  TIER2_ACTIONS,
  TIER2_READONLY_ACTIONS,
  TIER2_READONLY_TOOLS,
  TIER3_ACTIONS,
  TOOL_ACTION_INPUT_KEYS,
} from './aiGuardrails';
import { aiTools, getToolTier } from './aiTools';
import { HUMAN_ONLY_TOOLS } from './aiToolExposure';
import { TIER2_NOTE_WRITE_TOOLS } from './aiNoteWrites';
import { WISP_SELF_STATE_TOOLS } from './wisp/selfStateTools';

const MEMBERS = [...TIER2_NOTE_WRITE_TOOLS];

describe('TIER2_NOTE_WRITE_TOOLS contract', () => {
  it('is exactly the reviewed set (a change is a deliberate, reviewed change)', () => {
    expect(MEMBERS).toEqual(['set_device_context']);
  });

  it.each(MEMBERS)('%s is a registered Tier-2 tool a model may call', (tool) => {
    expect(TOOL_TIERS[tool]).toBe(2);
    expect(getToolTier(tool)).toBe(2);
    expect(aiTools.get(tool), `${tool} must be in the aiTools registry`).toBeDefined();
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
    const check = checkGuardrails(tool, { deviceId: '00000000-0000-4000-8000-000000000001', contextType: 'quirk', summary: 'x' });
    expect(check.allowed).toBe(true);
    expect(check.tier).toBe(2);
    expect(check.readOnly).toBeUndefined();
    expect(isReadOnlyResolution(tool, check)).toBe(false);
  });

  it('shares no member with the Wisp bookkeeping set (one rule per tool)', () => {
    expect(MEMBERS.filter((tool) => WISP_SELF_STATE_TOOLS.has(tool))).toEqual([]);
  });

  // These change or hide existing state, or reach a device.
  it.each(['resolve_device_context', 'manage_tags', 'execute_command', 'registry_operations', 'run_script'])('%s is not a member', (tool) => {
    expect(TIER2_NOTE_WRITE_TOOLS.has(tool)).toBe(false);
  });
});
