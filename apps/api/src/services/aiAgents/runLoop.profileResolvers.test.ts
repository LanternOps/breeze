import { describe, expect, it } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentLimits, type AiAgentRunProfile } from '@breeze/shared';
import {
  declaredFullRunToolExposure, resolveRunProfileLimits, resolveRunProfileToolAllowlist, resolveRunToolExposure,
} from './runLoop';
import { isOutcomeTool, OUTCOME_MCP_TOOL_NAMES } from './outcomeTools';
import { verdictLimits, verdictToolAllowlist } from './verdictProfile';
import { sweepLimits, sweepToolAllowlist } from './sweepProfile';
import { narrativeLimits, narrativeToolAllowlist } from './narrativeProfile';
import { triageLimits, triageToolAllowlist } from './triageProfile';
import { designLimits, designToolAllowlist } from './designProfile';
import { patchLimits, patchToolAllowlist } from './patchProfile';
import { ANALYSIS_TOOL_ALLOWLIST, analysisLimits, analysisToolAllowlist } from './analysisProfile';

/**
 * #7428 moved driveSdkLoop's per-profile arms into these three helpers so the
 * tool-selection harness can reuse them. Each arm is pinned against the
 * profile module's OWN function, so a swapped or dropped arm goes red here.
 */
const ARMS: ReadonlyArray<[
  AiAgentRunProfile,
  (limits: AiAgentLimits) => AiAgentLimits,
  (allowlist: string[]) => string[],
]> = [
  ['verdict', verdictLimits, verdictToolAllowlist],
  ['sweep', sweepLimits, sweepToolAllowlist],
  ['narrative', narrativeLimits, narrativeToolAllowlist],
  ['triage', triageLimits, triageToolAllowlist],
  ['design', designLimits, designToolAllowlist],
  ['patch', patchLimits, patchToolAllowlist],
  ['analysis', analysisLimits, analysisToolAllowlist],
];

const AGENT_ALLOWLIST = ['manage_services:restart', 'manage_alerts:acknowledge', 'disk_cleanup'];

describe('runLoop profile resolvers', () => {
  it.each(ARMS)('%s gets its own pinned limits, not the policy\'s', (profile, limits) => {
    const resolved = resolveRunProfileLimits({ profile }, AI_AGENT_LIMIT_DEFAULTS);
    expect(resolved).toEqual(limits(AI_AGENT_LIMIT_DEFAULTS));
    expect(resolved.maxTurnsPerRun).not.toBe(AI_AGENT_LIMIT_DEFAULTS.maxTurnsPerRun);
  });

  it('full keeps the policy limits unchanged', () => {
    expect(resolveRunProfileLimits({ profile: 'full' }, AI_AGENT_LIMIT_DEFAULTS)).toBe(AI_AGENT_LIMIT_DEFAULTS);
  });

  it.each(ARMS)('%s authority/exposure floor is its own pinned allowlist', (profile, _limits, allowlist) => {
    expect(resolveRunProfileToolAllowlist({ profile }, AGENT_ALLOWLIST)).toEqual(allowlist(AGENT_ALLOWLIST));
  });

  it('full has no pinned floor, so authority stays the agent\'s own allowlist', () => {
    expect(resolveRunProfileToolAllowlist({ profile: 'full' }, AGENT_ALLOWLIST)).toBeNull();
  });

  it.each(ARMS)('%s exposes its floor and registers it minus outcome tools', (profile, _limits, allowlist) => {
    const floor = allowlist(AGENT_ALLOWLIST);
    const { exposedNames, onlyTools } = resolveRunToolExposure({ profile }, AGENT_ALLOWLIST);
    expect(exposedNames).toEqual(floor.map((name) => (
      isOutcomeTool(name) ? OUTCOME_MCP_TOOL_NAMES[name] : `mcp__breeze__${name.split(':')[0]}`)));
    expect(onlyTools).toEqual(new Set(floor.map((name) => name.split(':')[0]!).filter((name) => !isOutcomeTool(name))));
  });

  it('pins the triage and analysis exposure literally (neither is pinned through driveSdkLoop)', () => {
    const triage = resolveRunToolExposure({ profile: 'triage' }, AGENT_ALLOWLIST);
    expect(triage.exposedNames).toEqual([OUTCOME_MCP_TOOL_NAMES.submit_ticket_proposal]);
    expect(triage.onlyTools).toEqual(new Set());
    const analysis = resolveRunToolExposure({ profile: 'analysis' }, AGENT_ALLOWLIST);
    expect(analysis.onlyTools).toEqual(new Set(ANALYSIS_TOOL_ALLOWLIST));
    expect(analysis.exposedNames).toContain(OUTCOME_MCP_TOOL_NAMES.submit_analysis);
    expect(analysis.exposedNames).not.toContain('mcp__breeze__execute_command');
  });

  it('full exposes and registers exactly the declared full-run floor (#7427)', () => {
    const floor = declaredFullRunToolExposure(AGENT_ALLOWLIST);
    const { exposedNames, onlyTools } = resolveRunToolExposure({ profile: 'full' }, AGENT_ALLOWLIST);
    expect(onlyTools).toEqual(new Set(floor));
    expect(exposedNames).toEqual(floor.map((name) => `mcp__breeze__${name}`));
  });
});
