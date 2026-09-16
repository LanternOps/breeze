/**
 * Execution plane W04 (spec §5.3) — the four sandbox-workspace tools.
 *
 * Deliberately THIN. Every cap, every containment rule and the whole sandbox
 * lifecycle live in `WorkspaceService`; these handlers resolve the run's
 * service, pass arguments through and translate failures into the typed
 * envelope the model reads. A second caller (W05's chat-launched analysis)
 * therefore cannot end up with different limits than the run loop.
 *
 * Tier 1 (they execute nothing on the fleet) but NOT read-only: the allowlist
 * gate is what makes them opt-in per agent — see `TIER1_NON_READONLY_TOOLS`
 * in `aiGuardrails.ts`.
 *
 * `captureExempt: true` on all four (spec §5.2): their results are small,
 * structured and ALREADY carry artifact handles. Capturing a
 * `workspace_collect` result would mint an artifact whose content is a list
 * of artifact handles — pure noise, and it would push the handle the model
 * actually needs behind another handle.
 */
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../aiTools';
import { captureException } from '../sentry';
import { WorkspaceToolError } from './workspaceErrors';
import { getWorkspaceForRun } from './workspaceRegistry';
import type { WorkspaceService } from './workspaceService';
import { WORKSPACE_IN_DIR, WORKSPACE_OUT_DIR } from './workspacePaths';

function requiresRun(): WorkspaceToolError {
  return new WorkspaceToolError(
    'workspace_requires_run',
    'The workspace tools only work inside an analysis run. Launch one instead of calling them here.',
  );
}

/**
 * Run resolution — cross-wave decision R2. The run id comes from the CALLER
 * IDENTITY and from nowhere else: `buildAgentAuthContext` builds
 * `principal: { kind: 'ai_agent', agentId, runId }` for every headless run, so
 * the value is already on the AuthContext every gate in the request reads.
 *
 * Deliberately NOT `ToolExecutionContext`. That type's header states the rule:
 * it carries per-invocation EXECUTION MATERIAL produced by a release path, and
 * identity — "who is asking, and what they may reach" — belongs on
 * `AuthContext`. A `runId` on it would be caller identity smuggled onto an
 * object execution paths extend, and it would be a SECOND channel: two places
 * to keep in sync, one of which an intermediate wrapper can silently drop.
 *
 * With one channel there is no fallback to get wrong. A principal that is not
 * `ai_agent` (a chat user, an MCP key, the helper) has no run, and the typed
 * `workspace_requires_run` is the correct, final answer for it. Nothing the
 * model sends influences this: there is no `runId` input on any of these
 * tools, by design.
 */
function resolveWorkspace(auth: AuthContext): WorkspaceService {
  const principal = auth.principal as { kind?: string; runId?: string } | undefined;
  const runId = principal?.kind === 'ai_agent' ? principal.runId : undefined;
  if (!runId) throw requiresRun();
  const svc = getWorkspaceForRun(runId);
  if (!svc) throw requiresRun();
  return svc;
}

/**
 * One envelope for every outcome. A `WorkspaceToolError` is reported with its
 * stable code; anything else is reported as `workspace_unavailable` with a
 * FIXED message — a raw `Error.message` here could carry a blob key, a
 * provider id or a Postgres role name straight into the model's context.
 */
async function envelope(fn: () => Promise<unknown>, toolName: string): Promise<string> {
  try {
    return JSON.stringify(await fn());
  } catch (error) {
    if (error instanceof WorkspaceToolError) return error.toToolResult();
    console.error('[workspaceTools] unexpected failure', { toolName, error });
    captureException(error instanceof Error ? error : new Error(String(error)));
    return new WorkspaceToolError(
      'workspace_unavailable',
      'The workspace could not complete that request.',
    ).toToolResult();
  }
}

export const WORKSPACE_TOOL_DESCRIPTIONS = {
  workspace_stage: `Copy artifacts you already hold handles for into the analysis sandbox at ${WORKSPACE_IN_DIR}. `
    + 'Only handles that were provided as inputs to this run, or that this run produced, can be staged.',
  workspace_run: 'Run a short script inside the analysis sandbox. The script is written to a file and executed by '
    + 'path; it has NO network access and cannot reach any device. Returns the exit code and the first 2 KiB of '
    + 'stdout/stderr; larger stdout is stored as an artifact handle.',
  workspace_collect: `Store files your script wrote under ${WORKSPACE_OUT_DIR} as artifacts and get their handles `
    + 'back. Nothing outside that directory can be collected.',
  workspace_cancel: "Destroy this run's sandbox early when you no longer need it. The run continues; later "
    + 'workspace calls will be refused.',
} as const;

/** Model-facing Zod shapes, reused verbatim by `createBreezeMcpServer`. */
export const WORKSPACE_MCP_SHAPES = {
  workspace_stage: {
    handles: z.array(z.string().uuid()).min(1).max(200)
      .describe("Artifact handles from this run's inputs or from an earlier tool result."),
    into: z.string().max(200).optional()
      .describe(`Optional subdirectory under ${WORKSPACE_IN_DIR}. Defaults to ${WORKSPACE_IN_DIR}.`),
  },
  workspace_run: {
    script: z.string().min(1).max(100_000).describe('The script source. It is written to a file and run by path.'),
    language: z.enum(['bash', 'python', 'node']),
    timeoutSeconds: z.number().int().min(1).max(600).optional()
      .describe("Clamped down to the run's remaining compute and wall clock."),
    stdinHandle: z.string().uuid().optional().describe('Optional artifact handle piped to the script on stdin.'),
  },
  workspace_collect: {
    paths: z.array(z.string().min(1).max(400)).min(1).max(50)
      .describe(`Paths under ${WORKSPACE_OUT_DIR}, absolute or relative to it.`),
    labels: z.record(z.string().max(400), z.string().max(200)).optional()
      .describe('Optional display name per path.'),
  },
  workspace_cancel: {},
} as const;

function definition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Anthropic.Tool {
  return { name, description, input_schema: { type: 'object' as const, properties, required } };
}

export function registerWorkspaceTools(map: Map<string, AiTool>): void {
  const add = (tool: AiTool) => { map.set(tool.definition.name, tool); };

  add({
    tier: 1,
    captureExempt: true,
    definition: definition('workspace_stage', WORKSPACE_TOOL_DESCRIPTIONS.workspace_stage, {
      handles: { type: 'array', items: { type: 'string' }, description: 'Artifact handles to stage.' },
      into: { type: 'string', description: `Optional subdirectory under ${WORKSPACE_IN_DIR}.` },
    }, ['handles']),
    handler: async (input, auth) => envelope(async () => {
      const svc = resolveWorkspace(auth);
      return svc.stage(input.handles as string[], input.into as string | undefined);
    }, 'workspace_stage'),
  });

  add({
    tier: 1,
    captureExempt: true,
    definition: definition('workspace_run', WORKSPACE_TOOL_DESCRIPTIONS.workspace_run, {
      script: { type: 'string', description: 'Script source.' },
      language: { type: 'string', enum: ['bash', 'python', 'node'] },
      timeoutSeconds: { type: 'number', description: 'Per-step timeout in seconds.' },
      stdinHandle: { type: 'string', description: 'Artifact handle piped to stdin.' },
    }, ['script', 'language']),
    handler: async (input, auth) => envelope(async () => {
      const svc = resolveWorkspace(auth);
      return svc.runStep({
        script: String(input.script),
        language: input.language as 'bash' | 'python' | 'node',
        timeoutSeconds: input.timeoutSeconds as number | undefined,
        stdinHandle: input.stdinHandle as string | undefined,
      });
    }, 'workspace_run'),
  });

  add({
    tier: 1,
    captureExempt: true,
    definition: definition('workspace_collect', WORKSPACE_TOOL_DESCRIPTIONS.workspace_collect, {
      paths: { type: 'array', items: { type: 'string' }, description: `Paths under ${WORKSPACE_OUT_DIR}.` },
      labels: { type: 'object', description: 'Optional display name per path.' },
    }, ['paths']),
    handler: async (input, auth) => envelope(async () => {
      const svc = resolveWorkspace(auth);
      return svc.collect(input.paths as string[], input.labels as Record<string, string> | undefined);
    }, 'workspace_collect'),
  });

  add({
    tier: 1,
    captureExempt: true,
    definition: definition('workspace_cancel', WORKSPACE_TOOL_DESCRIPTIONS.workspace_cancel, {}, []),
    handler: async (_input, auth) => envelope(async () => {
      const svc = resolveWorkspace(auth);
      await svc.cancel();
      return { status: 'cancelled' };
    }, 'workspace_cancel'),
  });
}
