/**
 * What a `surface_turn` verify run (#11393 W04 T10) sends for each surface:
 * built from the SAME production resolvers and server tool lists the W03
 * prefix measurement reads (toolCapture/advertisedPrefix.ts), for the
 * offering's own tool-profile facts. Nothing here is re-typed, so a surface
 * change moves the verify with it (surfaceTurnStubs.contract.test.ts pins
 * the declarations against the production servers).
 *
 * Verified surfaces and the variant each one runs:
 *  - chat           → the chat registry (no tenant/flow tools: org-less run)
 *  - helper         → the `extended` permission level (the largest)
 *  - script_builder → the script builder server
 *  - ai_agents      → the `analysis` run profile (+ its outcome tool), as the
 *    plan names it: read-only and small (the prefix pins also measure the
 *    larger `full` remediation variant). Its verdict stands for every agent
 *    run on the offering.
 * Office is not verified in v1: its tools are declared and run by the Office
 * client, there is no production server to mirror, and its prefixes are
 * unmeasured. An Office readiness entry is therefore always absent (eligible).
 */
import { AgentRunBlockedError } from '../aiAgents/modelBlocked';
import { ContextWindowTooSmallError, ToolProfileUnderpoweredError } from '../aiModels/sessionToolExposure';
import { TOOL_PROFILE_UNDERPOWERED } from '../aiModels/surfaceRequiredTools';
import type { ToolProfileFacts } from '../aiModels/toolExposure';
import { toolInputSchemas, validateToolInput } from '../aiToolSchemas';
import type { SurfaceTurnPlan } from './surfaceTurnHarness';
import { advertisedRequestForFacts } from './toolCapture/advertisedPrefix';
import { CAPTURE_SURFACES, type CaptureSurfaceId } from './toolCapture/surfaces';

export const SURFACE_TURN_SURFACES = ['chat', 'helper', 'script_builder', 'ai_agents'] as const;
export type SurfaceTurnSurface = (typeof SURFACE_TURN_SURFACES)[number];

export const SURFACE_TURN_CAPTURE_SURFACE: Readonly<Record<SurfaceTurnSurface, CaptureSurfaceId>> = Object.freeze({
  chat: 'chat',
  helper: 'helper-extended',
  script_builder: 'script-builder',
  ai_agents: 'agent-analysis',
});

export function isSurfaceTurnSurface(surface: string): surface is SurfaceTurnSurface {
  return (SURFACE_TURN_SURFACES as readonly string[]).includes(surface);
}

/** Read-only tools a turn asks for, in order; else the first tool with no required argument, else the first tool. */
const TARGET_PREFERENCE = ['query_devices', 'list_time_sync_issues', 'list_scripts', 'get_device_details'] as const;

export type SurfaceTurnPlanResult =
  | { kind: 'planned'; plan: SurfaceTurnPlan }
  | { kind: 'refused'; reason: 'context_window_too_small' | typeof TOOL_PROFILE_UNDERPOWERED; message: string };

function targetTool(tools: SurfaceTurnPlan['tools']): string {
  const names = new Set(tools.map((t) => t.name));
  const preferred = TARGET_PREFERENCE.find((n) => names.has(n));
  if (preferred) return preferred;
  const noRequired = tools.find((t) => Object.values(t.inputSchema as Record<string, { isOptional?: () => boolean }>)
    .every((field) => typeof field?.isOptional === 'function' && field.isOptional()));
  return (noRequired ?? tools[0])!.name;
}

/** Registry tools get the registry's own validator (what their production handler runs); everything else its Zod shape only. */
function validateFor(server: 'breeze' | 'script_builder'): SurfaceTurnPlan['validate'] {
  if (server !== 'breeze') return () => ({ success: true });
  return (name, input) => (Object.prototype.hasOwnProperty.call(toolInputSchemas, name) ? validateToolInput(name, input) : { success: true });
}

/**
 * The plan for one surface, or why the surface would refuse this model up
 * front (the session-start refusals of W01/W02). A refused surface is not
 * run: the user already gets that refusal, never a verify verdict.
 */
export function planSurfaceTurn(surface: SurfaceTurnSurface, facts: ToolProfileFacts): SurfaceTurnPlanResult {
  const capture = CAPTURE_SURFACES[SURFACE_TURN_CAPTURE_SURFACE[surface]];
  let request: ReturnType<typeof advertisedRequestForFacts>;
  try {
    request = advertisedRequestForFacts(capture, facts, { strict: true });
  } catch (err) {
    if (err instanceof ContextWindowTooSmallError) return { kind: 'refused', reason: 'context_window_too_small', message: err.message };
    if (err instanceof ToolProfileUnderpoweredError || err instanceof AgentRunBlockedError) {
      const tooSmall = err instanceof AgentRunBlockedError && /window is too small/.test(err.message);
      return { kind: 'refused', reason: tooSmall ? 'context_window_too_small' : TOOL_PROFILE_UNDERPOWERED, message: err.message };
    }
    throw err;
  }
  const tools = request.serverTools;
  if (tools.length === 0) throw new Error(`surface_turn: ${surface} registers no tools`);
  return {
    kind: 'planned',
    plan: {
      surface,
      profile: request.exposure.profile,
      fingerprint: request.exposure.fingerprint,
      compactSchemas: request.exposure.compactSchemas,
      systemPrompt: request.system,
      mcpServerName: capture.mcpServerName,
      tools,
      allowedTools: request.allowedTools,
      targetTool: targetTool(tools),
      validate: validateFor(capture.server),
    },
  };
}
