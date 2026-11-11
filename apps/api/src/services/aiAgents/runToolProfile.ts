/**
 * Tool profiles on agent runs (#11393 W01). Narrows what the run's SDK query
 * registers and allow-lists to the model's tool profile, on top of the run
 * profile's own exposure (`resolveRunToolExposure`). Exposure only:
 * `guardrailPolicy.toolAllowlist` (authority) is never read or written here.
 *
 * The run's outcome tools (incl. `submit_task_step`) always survive. A
 * profile that drops a tool the run profile needs (the troubleshoot run's
 * `execute_command` / `run_script`) blocks the run before any provider call:
 * an admin's model choice, so circuit-neutral like `model_unavailable`.
 */
import type { AiToolDomain } from '@breeze/shared';
import { bareToolName } from '../aiModels/sessionToolExposure';
import { SURFACE_UNDERPOWERED_MESSAGE, TOOL_PROFILE_UNDERPOWERED, checkSurfaceCoverage, type RunFloorRef } from '../aiModels/surfaceRequiredTools';
import { resolveToolExposure, type ToolExposure, type ToolProfileFacts } from '../aiModels/toolExposure';
import { AgentRunBlockedError, blockedOutcome } from './modelBlocked';
import { outcomeToolsForRun } from './outcomeTools';

export interface RunToolProfileInput {
  run: RunFloorRef;
  facts: ToolProfileFacts;
  /** `resolveRunToolExposure(...).exposedNames` plus flow tool names (`mcp__…` names). */
  exposedNames: readonly string[];
  /** `resolveRunToolExposure(...).onlyTools`. */
  onlyTools: ReadonlySet<string> | undefined;
  /** Flow tool names (bare `flow__…`) the run would register. */
  flowToolNames: readonly string[];
  offeringId: string | null;
  domainOf: (name: string) => AiToolDomain | undefined;
}

export interface RunToolProfile {
  exposure: ToolExposure;
  exposedNames: string[];
  onlyTools: ReadonlySet<string> | undefined;
  keepsFlowTool: (name: string) => boolean;
}

export function applyRunToolProfile(input: RunToolProfileInput): RunToolProfile {
  const { run, facts, flowToolNames } = input;
  const outcome = new Set<string>(outcomeToolsForRun(run));
  const flows = new Set(flowToolNames);
  const surfaceBaseSet = [...new Set(input.exposedNames.map(bareToolName))].filter((n) => !outcome.has(n) && !flows.has(n));
  const exposure = resolveToolExposure({
    surface: 'ai_agents',
    runProfile: run.profile,
    facts,
    surfaceBaseSet,
    extraTools: [
      ...[...outcome].map((name) => ({ name, domain: null, alwaysKeep: true })),
      ...flowToolNames.map((name) => ({ name, domain: 'scripts' as const })),
    ],
  }, { domainOf: input.domainOf });
  if (exposure.names === null) {
    return { exposure, exposedNames: [...input.exposedNames], onlyTools: input.onlyTools, keepsFlowTool: () => true };
  }
  const coverage = checkSurfaceCoverage('ai_agents', exposure, run);
  if (!coverage.ok) {
    const message = SURFACE_UNDERPOWERED_MESSAGE('AI agent');
    throw new AgentRunBlockedError(
      TOOL_PROFILE_UNDERPOWERED,
      { ...blockedOutcome(TOOL_PROFILE_UNDERPOWERED, { message, offeringId: input.offeringId }), missingTools: coverage.missing },
      message,
    );
  }
  const names = new Set(exposure.names);
  const kept = new Set([...exposure.names, ...exposure.extraToolNames]);
  return {
    exposure,
    exposedNames: input.exposedNames.filter((n) => kept.has(bareToolName(n))),
    onlyTools: new Set([...(input.onlyTools ?? names)].filter((n) => names.has(n))),
    keepsFlowTool: (name) => kept.has(name),
  };
}
