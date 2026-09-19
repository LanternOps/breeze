import { describe, expect, it } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentLimits } from '@breeze/shared';
import {
  PATCH_OUTCOME_TOOL_NAME, PATCH_TOOL_ALLOWLIST, isPatchProfile, patchLimits, patchToolAllowlist,
} from './patchProfile';
import { AGENT_KIND_PRESETS, buildAgentToolCatalog } from './agentToolCatalog';
import { TOOL_TIERS } from '../aiAgentSdkTools';

describe('patch profile', () => {
  it('detects the profile', () => {
    expect(isPatchProfile({ profile: 'patch' })).toBe(true);
    expect(isPatchProfile({ profile: 'full' })).toBe(false);
    expect(isPatchProfile({ profile: 'design' })).toBe(false);
  });

  it('substitutes patch budget and turns and pins actions to 0', () => {
    const l = patchLimits({ ...AI_AGENT_LIMIT_DEFAULTS, maxActionsPerRun: 5, patchBudgetCentsPerRun: 90, patchMaxTurns: 12 });
    expect(l.maxBudgetCentsPerRun).toBe(90);
    expect(l.maxTurnsPerRun).toBe(12);
    expect(l.maxActionsPerRun).toBe(0);
  });

  it('tolerates a pre-v11 snapshot with no patch fields', () => {
    const legacy = patchLimits({ ...AI_AGENT_LIMIT_DEFAULTS, patchMaxTurns: undefined, patchBudgetCentsPerRun: undefined } as unknown as AiAgentLimits);
    expect(legacy.maxTurnsPerRun).toBe(AI_AGENT_LIMIT_DEFAULTS.patchMaxTurns);
    expect(legacy.maxBudgetCentsPerRun).toBe(AI_AGENT_LIMIT_DEFAULTS.patchBudgetCentsPerRun);
  });

  it('is a floor: ignores the agent allowlist, ends with exactly one outcome tool', () => {
    const floor = patchToolAllowlist(['manage_patches:install', 'run_script', 'manage_deployments:start']);
    expect(floor.filter((n) => n.startsWith('submit_'))).toEqual(['submit_patch_plan']);
    expect(floor[floor.length - 1]).toBe(PATCH_OUTCOME_TOOL_NAME);
    expect(floor.slice(0, -1)).toEqual([...PATCH_TOOL_ALLOWLIST]);
    expect(floor).not.toContain('manage_patches:install');
    expect(floor).not.toContain('run_script');
    expect(floor).not.toContain('manage_deployments:start');
    // inert stub (aiToolsFleet.ts) — the model must not be told it can scan
    expect(floor).not.toContain('manage_patches:scan');
    expect(floor).not.toContain('manage_patches');
  });

  it('the patch-kind create preset no longer offers the software-rollout engine', () => {
    expect(AGENT_KIND_PRESETS.patch).not.toContain('manage_deployments:start');
    expect(AGENT_KIND_PRESETS.patch).toContain('manage_patches:install');
  });

  it('every floor entry is a read-only operation of a tool the SDK actually wires', () => {
    const catalog = buildAgentToolCatalog();
    const byName = new Map(catalog.tools.map((t) => [t.name, t]));
    for (const entry of PATCH_TOOL_ALLOWLIST) {
      const [base, action] = entry.split(':') as [string, string | undefined];
      expect(TOOL_TIERS[base as keyof typeof TOOL_TIERS], `${base} is not in TOOL_TIERS`).toBeDefined();
      const tool = byName.get(base);
      expect(tool, `${base} is not a catalog tool`).toBeDefined();
      if (action === undefined) {
        expect(tool!.readOnly, `${entry} must be read-only`).toBe(true);
      } else {
        const op = tool!.operations.find((o) => o.key === entry);
        expect(op, `${entry} is not a catalog operation`).toBeDefined();
        expect(op!.readOnly, `${entry} must be read-only`).toBe(true);
      }
    }
  });
});
