import { describe, expect, it } from 'vitest';
import { canonicalPolicyKey } from './canonicalPolicyKey';

/**
 * P2-5 (#4192) — the resolver moved out of policyDecide.ts (Deviation #2,
 * plan `2026-09-01-ai-agents-p2-5-graduation.md`) so it has exactly one
 * definition shared by the release worker and the evidence writers. Must
 * derive the key EXACTLY the way `resolveActionForTool` does — no second ad
 * hoc parse of `arguments`.
 */
describe('canonicalPolicyKey', () => {
  it('joins the tool name and the resolved action with a colon', () => {
    expect(canonicalPolicyKey('manage_services', { action: 'restart' })).toBe('manage_services:restart');
  });

  it('falls back to the bare tool name when no action is resolvable', () => {
    expect(canonicalPolicyKey('manage_devices', {})).toBe('manage_devices');
  });

  it('falls back to the bare tool name when the action value is not a string', () => {
    expect(canonicalPolicyKey('manage_services', { action: 42 })).toBe('manage_services');
  });
});
