/**
 * The `surface_turn` verification stage (#11393 W04 T10): one real Agent SDK
 * turn of a surface, as that surface would run it on the model under test —
 * its system prompt, its tool list under the offering's tool exposure (names,
 * descriptions and schemas exactly as production registers them) and its
 * `allowedTools` — answered by STUBS. Every tool is advertised inline: a host
 * that defers chat tools behind tool search (AI_TOOL_SEARCH) is not mirrored;
 * constrained profiles and gateways never defer.
 *
 * A stub keeps the production declaration and swaps only the handler: the
 * handler validates the input (the declaration's Zod shape, then the
 * surface's own validator) and answers `{ ok: true, verification_code }` or
 * the validation error. It never calls the production handler, so a verify
 * turn runs no tool, writes nothing and sends nothing to a device
 * (surfaceTurnStubs.contract.test.ts traps the DB, executeTool, the command
 * queue and fetch to prove it).
 *
 * Verdict (`outcome`):
 *  - `passed`: a call with valid input reached a stub AND the final answer
 *    carries the run's random sentinel (proof the tool result was read).
 *  - `failed`: the MODEL could not do the round trip — no tool call, a call
 *    that never reached a stub (an input the SDK rejected, a name not
 *    offered), only invalid input, no sentinel, out of turns, or a tool-call
 *    batch the gateway refused. Eligibility refuses the surface on this (T11).
 *  - `inconclusive`: the ENDPOINT, the run or Breeze failed (an HTTP error, a
 *    context window the prompt does not fit, a timeout, a spawn error, a
 *    validator that threw). Never refuses anything: the W02 window learning
 *    and the next verification own those.
 *
 * Side effects: the SDK child it spawns and an empty temp directory it runs
 * in; the caller (offeringVerification) owns the grant, the egress proxy and
 * persistence.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AiSurface } from '@breeze/shared';
import type { SdkTool } from '../aiAgents/outcomeTools';
import type { GatewayFailure } from '../aiModels/gateway/failureNotes';
import { createIsolatedSdkCwd, type IsolatedSdkCwd } from '../aiModels/sdkChildEnv';
import type { ResolvedToolProfile } from '../aiModels/toolExposure';

/** The stage version lives with the stored record (aiModels/surfaceReadiness.ts) so readers need not load the harness. */
export { SURFACE_TURN_VERSION } from '../aiModels/surfaceReadiness';
export const SURFACE_TURN_MAX_TURNS = 4;
const DETAIL_MAX = 200;

export type SurfaceTurnOutcome = 'passed' | 'failed' | 'inconclusive';

export interface SurfaceTurnPlan {
  surface: AiSurface;
  profile: ResolvedToolProfile;
  /** The exposure's fingerprint (the ledger's `tool_exposure_fingerprint`). */
  fingerprint: string;
  /** The exposure compacts the advertised upstream schemas (a constrained gateway grant does). */
  compactSchemas: boolean;
  systemPrompt: string;
  /** The `mcpServers` key (and the `<server>` in `mcp__<server>__<tool>`). */
  mcpServerName: string;
  /** The production declarations under the exposure. Their handlers are never called. */
  tools: SdkTool[];
  /** `query({ allowedTools })` under the exposure. */
  allowedTools: string[];
  /** Bare name of the tool the prompt asks for (any valid call to any stub counts). */
  targetTool: string;
  /** The surface's own validator, run after the declaration's Zod shape. Pure. */
  validate(name: string, input: Record<string, unknown>): { success: true } | { success: false; error: string };
}

export interface SurfaceTurnResult {
  outcome: SurfaceTurnOutcome;
  passed: boolean;
  /** Why, ≤ 200 chars; the caller scrubs secrets before storing it. */
  detail: string;
  /**
   * The first request's prompt tokens (cache reads and writes included) as the
   * gateway reported them (its estimate when the endpoint states none),
   * falling back to the session total; null when nothing non-zero was reported.
   */
  promptTokens: number | null;
  cachedTokens: number | null;
  /** Bare name of the first tool the model called; null = none. */
  calledTool: string | null;
  /** At least one call passed validation. */
  zodValid: boolean;
  sentinelSeen: boolean;
}

/** The two Agent SDK entry points the stage uses (injected in tests). */
export interface SurfaceTurnSdk {
  query: (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<unknown>;
  createSdkMcpServer: (config: { name: string; version?: string; tools: SdkTool[] }) => unknown;
}

export interface SurfaceTurnInput {
  plan: SurfaceTurnPlan;
  wireModel: string;
  /** The child env pointed at a verification grant behind the deny-all proxy. */
  childEnv: Record<string, string>;
  deadlineMs: number;
  /** The gateway's note for this run, read once when the session ends (failureNotes.takeGatewayFailure). */
  gatewayFailure?: () => GatewayFailure | null;
}

export interface SurfaceTurnDeps {
  sdk?: SurfaceTurnSdk;
  /** Test seam; otherwise a fresh random code per run. */
  sentinel?: string;
  isolatedCwd?: () => Promise<IsolatedSdkCwd | null>;
}

interface StubCall { name: string; valid: boolean; error?: string; harnessError?: string }

function clip(text: string): string {
  return text.length <= DETAIL_MAX ? text : `${text.slice(0, DETAIL_MAX - 1)}…`;
}

function zodIssues(error: z.ZodError): string {
  return `Invalid input: ${error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ')}`;
}

/**
 * The plan's declarations with only the handler replaced. Everything the
 * model is shown (name, description, input schema, annotations, _meta) is
 * the production object's own, so the advertised request is identical.
 */
export function stubTools(plan: SurfaceTurnPlan, sentinel: string, onCall: (call: StubCall) => void): SdkTool[] {
  return plan.tools.map((declaration) => {
    const handler = async (args: unknown) => {
      const input = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
      let verdict: { success: true } | { success: false; error: string };
      try {
        const shape = z.object(declaration.inputSchema as z.ZodRawShape).safeParse(input);
        verdict = shape.success ? plan.validate(declaration.name, input) : { success: false as const, error: zodIssues(shape.error) };
      } catch (error) {
        // A Breeze defect (a declaration or validator that throws), never the
        // model's: the run is judged inconclusive, not failed.
        onCall({ name: declaration.name, valid: false, harnessError: error instanceof Error ? error.message : 'unknown error' });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Breeze could not check this call.' }) }], isError: true };
      }
      if (!verdict.success) {
        onCall({ name: declaration.name, valid: false, error: verdict.error });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: verdict.error }) }], isError: true };
      }
      onCall({ name: declaration.name, valid: true });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, verification_code: sentinel }) }] };
    };
    return { ...declaration, handler } as SdkTool;
  });
}

export function surfaceTurnPrompt(plan: SurfaceTurnPlan): string {
  const tool = `mcp__${plan.mcpServerName}__${plan.targetTool}`;
  return `This is an automated Breeze tool check, not a user request. Call the tool ${tool} exactly once with valid arguments `
    + '(where it needs an id, any well-formed value will do). It returns JSON with a verification_code. '
    + 'Then reply with only that verification_code.';
}

const MCP_NAME = /^mcp__.+?__(.+)$/;

function firstUsage(usage: unknown): { prompt: number; cached: number } | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === 'number' && Number.isFinite(u[k]) ? (u[k] as number) : 0);
  if (typeof u.input_tokens !== 'number') return null;
  const prompt = n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens');
  // A gateway stream starts with zero usage (the real count arrives later): not a size.
  return prompt > 0 ? { prompt, cached: n('cache_read_input_tokens') } : null;
}

export async function runSurfaceTurn(input: SurfaceTurnInput, deps: SurfaceTurnDeps = {}): Promise<SurfaceTurnResult> {
  const { plan } = input;
  const sentinel = deps.sentinel ?? `BRZ-${randomBytes(4).toString('hex').toUpperCase()}`;
  const calls: StubCall[] = [];
  let calledTool: string | null = null;
  let usage: { prompt: number; cached: number } | null = null;
  type ResultMessage = { subtype?: unknown; is_error?: unknown; result?: unknown; usage?: unknown };
  // A holder: TS does not see the assignment inside the for-await loop below.
  const final: { message: ResultMessage | null } = { message: null };
  let failureRead = false;
  let failure: GatewayFailure | null = null;
  const gatewayFailure = (): GatewayFailure | null => {
    if (!failureRead) { failureRead = true; failure = input.gatewayFailure?.() ?? null; }
    return failure;
  };

  const verdict = (outcome: SurfaceTurnOutcome, detail: string): SurfaceTurnResult => ({
    outcome,
    passed: outcome === 'passed',
    detail: clip(detail),
    promptTokens: usage?.prompt ?? null,
    cachedTokens: usage?.cached ?? null,
    calledTool,
    zodValid: calls.some((c) => c.valid),
    sentinelSeen: typeof final.message?.result === 'string' && final.message.result.includes(sentinel),
  });

  let sdk: SurfaceTurnSdk;
  try {
    sdk = deps.sdk ?? (await import('@anthropic-ai/claude-agent-sdk')) as unknown as SurfaceTurnSdk;
  } catch (error) {
    return verdict('inconclusive', `could not run: agent SDK unavailable (${error instanceof Error ? error.message : 'unknown error'})`);
  }

  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abortController.abort(); }, input.deadlineMs);
  timer.unref?.();
  let cwd: IsolatedSdkCwd | null = null;
  try {
    // An untrusted endpoint: the child runs in an empty temp directory so the
    // environment block the CLI sends upstream names no host path.
    cwd = await (deps.isolatedCwd ?? createIsolatedSdkCwd)();
    const server = sdk.createSdkMcpServer({
      name: plan.mcpServerName,
      version: '1.0.0',
      tools: stubTools(plan, sentinel, (call) => calls.push(call)),
    });
    const session = sdk.query({
      prompt: surfaceTurnPrompt(plan),
      options: {
        model: input.wireModel,
        systemPrompt: plan.systemPrompt,
        maxTurns: SURFACE_TURN_MAX_TURNS,
        // No built-in tools: only the surface's own (stubbed) server.
        tools: [],
        allowedTools: plan.allowedTools,
        mcpServers: { [plan.mcpServerName]: server },
        settingSources: [],
        persistSession: false,
        abortController,
        env: input.childEnv,
        ...(cwd ? { cwd: cwd.cwd } : {}),
      },
    });
    for await (const raw of session) {
      const message = raw as { type?: unknown; message?: { content?: unknown; usage?: unknown } };
      if (message.type === 'assistant') {
        usage ??= firstUsage(message.message?.usage);
        const content = Array.isArray(message.message?.content) ? message.message.content : [];
        for (const block of content as Array<{ type?: unknown; name?: unknown }>) {
          if (block?.type === 'tool_use' && typeof block.name === 'string' && calledTool === null) {
            calledTool = MCP_NAME.exec(block.name)?.[1] ?? block.name;
          }
        }
      } else if (message.type === 'result') {
        final.message = raw as ResultMessage;
      }
    }
  } catch (error) {
    if (timedOut) return verdict('inconclusive', `did not finish within ${Math.round(input.deadlineMs / 1000)} s`);
    // The SDK rejects the iterator when the CLI exits non-zero AFTER its
    // `result` (e.g. error_max_turns; see toolCapture/runSurface.ts): a
    // delivered result is judged below, as if the session had ended normally.
    if (!final.message) {
      const note = gatewayFailure();
      if (note?.code === 'refused_tool_batch') return verdict('failed', `the gateway refused the model's tool calls: ${note.message}`);
      return verdict('inconclusive', `could not complete: ${note?.message ?? (error instanceof Error ? error.message : 'unknown error')}`);
    }
  } finally {
    clearTimeout(timer);
    cwd?.remove();
  }

  const result = final.message;
  usage ??= firstUsage(result?.usage);
  if (timedOut) return verdict('inconclusive', `did not finish within ${Math.round(input.deadlineMs / 1000)} s`);
  if (!result) return verdict('inconclusive', 'the session ended without a result');

  const harnessError = calls.find((c) => c.harnessError);
  if (harnessError) return verdict('inconclusive', `Breeze could not check the ${harnessError.name} call: ${harnessError.harnessError}`);
  const note = gatewayFailure();
  if (note?.code === 'refused_tool_batch') return verdict('failed', `the gateway refused the model's tool calls: ${note.message}`);
  if (result.subtype !== 'success' || result.is_error === true) {
    if (note) return verdict('inconclusive', `the endpoint failed: ${note.message}`);
    if (result.subtype === 'error_max_turns') return verdict('failed', `did not finish within ${SURFACE_TURN_MAX_TURNS} turns`);
    return verdict('inconclusive', `the session failed (${String(result.subtype)})`);
  }
  if (calls.length === 0 && calledTool === null) return verdict('failed', 'answered without calling a tool');
  if (!calls.some((c) => c.valid)) {
    const invalid = calls.find((c) => !c.valid);
    return verdict('failed', invalid?.error ? `the tool input was invalid: ${invalid.error}` : 'no tool call reached the tool');
  }
  if (typeof result.result !== 'string' || !result.result.includes(sentinel)) {
    return verdict('failed', 'the final answer did not contain the sentinel');
  }
  return verdict('passed', `called ${calledTool ?? calls[0]!.name} and read its result`);
}
