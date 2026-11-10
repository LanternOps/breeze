/**
 * Per-surface tool floors (#11393 W01): what a surface cannot work without.
 * A profile can narrow a surface's tools, but never below its floor — the
 * floor is CHECKED, not silently re-added: a surface whose exposure misses a
 * required tool refuses up front (`tool_profile_underpowered`) with a message
 * telling the operator to assign a larger model or widen the profile, before
 * any provider call. Exposure only; authority is unchanged.
 */
import type { AiAgentRunProfile, AiSurface } from '@breeze/shared';
import { outcomeToolsForRun } from '../aiAgents/outcomeTools';
import type { ToolExposure } from './toolExposure';

export const TOOL_PROFILE_UNDERPOWERED = 'tool_profile_underpowered' as const;

export interface RunFloorRef { profile: AiAgentRunProfile; taskId?: string | null }

/** Registry tools a run profile cannot do its job without, beyond its outcome tools. */
const REQUIRED_BY_RUN_PROFILE: Readonly<Partial<Record<AiAgentRunProfile, readonly string[]>>> = {
  // troubleshootProfile.ts: the run proposes commands and scripts (forced shadow).
  device_troubleshooting: ['execute_command', 'run_script'],
};

/** Static floors. `ai_agents` is per run: see `requiredToolsFor`. */
export const SURFACE_REQUIRED_TOOLS: Readonly<Record<'chat' | 'office_chat' | 'helper' | 'script_builder', readonly string[]>> = {
  chat: ['set_device_context'],
  office_chat: [],
  helper: [],
  script_builder: ['execute_script_on_device', 'apply_script_code'],
};

export function requiredToolsFor(surface: AiSurface, run?: RunFloorRef): string[] {
  if (surface === 'ai_agents') {
    if (!run) throw new Error('requiredToolsFor(ai_agents) needs the run');
    return [...outcomeToolsForRun(run), ...(REQUIRED_BY_RUN_PROFILE[run.profile] ?? [])];
  }
  return [...((SURFACE_REQUIRED_TOOLS as Partial<Record<AiSurface, readonly string[]>>)[surface] ?? [])];
}

export type SurfaceCoverage = { ok: true } | { ok: false; missing: string[] };

/** Does the exposure keep every tool the surface needs? The identity exposure (names null) always does. */
export function checkSurfaceCoverage(surface: AiSurface, exposure: ToolExposure, run?: RunFloorRef): SurfaceCoverage {
  if (surface === 'ai_agents' && !run) throw new Error('checkSurfaceCoverage(ai_agents) needs the run');
  if (exposure.names === null) return { ok: true };
  const kept = new Set([...exposure.names, ...exposure.extraToolNames]);
  const missing = requiredToolsFor(surface, run).filter((name) => !kept.has(name));
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

export function SURFACE_UNDERPOWERED_MESSAGE(surfaceLabel: string): string {
  return `This model's tool profile does not include what the ${surfaceLabel} needs. Assign a larger model to this surface, or widen the profile.`;
}
