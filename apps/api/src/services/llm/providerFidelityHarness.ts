/**
 * Provider tool-call fidelity harness (#3922 phase 2, Wave 1).
 *
 * A catalog revision may only be activated once every model it maps has a
 * PASSING verification record at the current harness version. This file is the
 * thing that produces that verdict, so its pass/fail semantics are security
 * gating, not diagnostics:
 *
 *   - `passed` is `steps.every(step => step.ok)` — there is no partial credit.
 *   - A stage that could not be run (SDK binary missing, direct stage already
 *     failed) is recorded as a FAILING step whose detail starts with 'skipped'.
 *     A skipped stage must never produce a passing verification.
 *   - The harness never throws for a provider-side failure; it returns
 *     `passed:false` with the failing step named. It only throws for
 *     programmer errors.
 *   - The transient operator-supplied API key is redacted out of every step
 *     detail before it is returned (the caller persists `steps` into
 *     `llm_provider_verifications.detail`).
 *
 * Two stages, both must pass (advisor quorum P7 — a provider can fake the wire
 * format well enough for a single `messages.create` and still break the real
 * Agent SDK subprocess loop, so both are exercised):
 *   1. Direct `@anthropic-ai/sdk` client: full tool_use -> tool_result ->
 *      end_turn exchange against `baseUrl`.
 *   2. Real `@anthropic-ai/claude-agent-sdk` `query()` subprocess with one
 *      in-process MCP tool, pointed at `baseUrl` via the child env.
 *
 * Egress: the direct stage goes through `buildGuardedLlmFetch`
 * (`guardedLlmFetch.ts`, Wave 2 Task 2.1) — origin pinned to the revision's own
 * base URL and dialled through `safeFetch`, so a base URL aimed at
 * loopback/RFC1918/link-local/cloud-metadata space is refused rather than
 * proxied back to the operator through the returned steps. The harness has no
 * `llm_egress_events` row to write yet (that table doesn't exist until Task
 * 2.3), so it passes a no-op recorder — this stays dead code, per the Wave 2
 * map, until Wave 3 wires a real one through the resolver. The subprocess
 * stage only runs after the direct stage passes, so it can never be the first
 * thing to reach an internal address; Wave 2's CONNECT proxy is what pins the
 * child's own egress.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { buildGuardedLlmFetch } from './guardedLlmFetch';

/**
 * Bump this whenever the harness gets meaningfully stricter — verification
 * records are keyed by (revision, model, harnessVersion), so a bump
 * invalidates every previous pass and forces re-verification before a
 * revision can be activated.
 */
export const FIDELITY_HARNESS_VERSION = '1';

export const FIDELITY_STEP_NAMES = {
  directToolUse: 'direct_tool_use',
  directToolResult: 'direct_tool_result',
  sdkSubprocess: 'sdk_subprocess',
} as const;

export interface FidelityCheckInput {
  baseUrl: string;
  authMode: 'x-api-key' | 'bearer';
  providerModel: string;
  apiKey: string;
}

export interface FidelityCheckStep {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface FidelityCheckResult {
  passed: boolean;
  steps: FidelityCheckStep[];
  harnessVersion: string;
}

const TOOL_NAME = 'get_weather';
const MCP_SERVER_NAME = 'fidelity';
const SDK_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${TOOL_NAME}`;
const TOOL_DESCRIPTION = 'Get the current weather for a city. Always call this before answering about weather.';
const PROMPT = `What's the weather in Berlin? Use the ${TOOL_NAME} tool, then tell me the condition and temperature.`;
/** Sentinels the final answer has to echo for the tool result to have been read. */
const WEATHER_CONDITION = 'sunny';
const WEATHER_TEMPERATURE_C = 21;
const WEATHER_RESULT_JSON = JSON.stringify({
  city: 'Berlin',
  condition: WEATHER_CONDITION,
  temperature_c: WEATHER_TEMPERATURE_C,
});

const DIRECT_REQUEST_TIMEOUT_MS = 60_000;
const SDK_STAGE_TIMEOUT_MS = 150_000;
const MAX_DETAIL_CHARS = 600;

const WEATHER_TOOL_SCHEMA = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  input_schema: {
    type: 'object' as const,
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
};

/**
 * Patterns that mean "the Agent SDK could not launch its child process here",
 * as opposed to "the provider failed the check". Only these turn the
 * subprocess stage into a *skip* — and a skip still fails the run.
 */
const SDK_UNAVAILABLE_PATTERNS = [
  /executable not found/i,
  /executable at .* exists but failed to launch/i,
  /native binary (not found|at .* exists but failed to launch)/i,
  /\bENOENT\b/,
  /cannot find module/i,
  /failed to (launch|spawn)/i,
];

function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function isSdkUnavailableError(error: unknown): boolean {
  const message = describeError(error);
  return SDK_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(message));
}

/** Does the final answer actually reference what the tool returned? */
function referencesToolResult(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes(WEATHER_CONDITION) || lower.includes(String(WEATHER_TEMPERATURE_C));
}

/**
 * Providers vary: some return the tool input as a parsed object (correct),
 * some return it as a JSON string. Both are accepted; anything that does not
 * yield `{ city: string }` is a fidelity failure.
 */
function parseToolInput(raw: unknown): { city: string } | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const city = (value as Record<string, unknown>).city;
  return typeof city === 'string' && city.trim().length > 0 ? { city } : null;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => (
      typeof block === 'object'
      && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ))
    .map((block) => block.text)
    .join('\n');
}

function firstToolUseBlock(content: unknown): { id: string; name: string; input: unknown } | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (
      typeof block === 'object'
      && block !== null
      && (block as { type?: unknown }).type === 'tool_use'
    ) {
      const typed = block as { id?: unknown; name?: unknown; input?: unknown };
      return {
        id: typeof typed.id === 'string' ? typed.id : '',
        name: typeof typed.name === 'string' ? typed.name : '',
        input: typed.input,
      };
    }
  }
  return null;
}

/**
 * Env for the Agent SDK child. Deliberately hand-built rather than derived
 * from `process.env`: the parent's `ANTHROPIC_*` credentials must never reach
 * the child (otherwise the harness could "verify" an endpoint while actually
 * authenticating with the platform key), and the parent's proxy vars must not
 * redirect or bypass the child's egress.
 */
export function buildFidelityChildEnv(
  input: FidelityCheckInput,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const passthrough = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'COMSPEC',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ] as const;

  const env: Record<string, string> = {
    CI: 'true',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'breeze-api/provider-fidelity-harness',
  };

  for (const key of passthrough) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }

  env.ANTHROPIC_BASE_URL = input.baseUrl;
  if (input.authMode === 'x-api-key') {
    env.ANTHROPIC_API_KEY = input.apiKey;
  } else {
    env.ANTHROPIC_AUTH_TOKEN = input.apiKey;
  }

  return env;
}

/**
 * Re-exported so existing importers of the harness's egress error keep
 * working; the canonical definition now lives in `guardedLlmFetch.ts`
 * (Wave 2 Task 2.1) alongside the fetch implementation that throws it, so
 * there is exactly one guarded-fetch implementation in the codebase.
 */
export { LlmEgressViolationError } from './guardedLlmFetch';

/**
 * `safeFetch` (reached via `buildGuardedLlmFetch`) additionally asserts it is
 * not called inside a held DB context — which is why the `/verify` route is
 * registered in `middleware/selfManagedDbContextRoutes.ts`.
 */
function buildAnthropicClient(input: FidelityCheckInput): Anthropic {
  return new Anthropic({
    baseURL: input.baseUrl,
    ...(input.authMode === 'x-api-key'
      ? { apiKey: input.apiKey, authToken: null }
      : { authToken: input.apiKey, apiKey: null }),
    fetch: buildGuardedLlmFetch({
      allowedOrigin: new URL(input.baseUrl).origin,
      // `llm_egress_events` is org-scoped (see `llmEgressRecorder.ts`), and the
      // harness is a platform-admin vetting tool with no tenant behind it —
      // there is no org/partner to attribute a row to. Partner traffic is
      // recorded where it has a tenant: the resolver-built clients in Wave 3.
      recordEgress: () => {},
    }) as unknown as typeof fetch,
    timeout: DIRECT_REQUEST_TIMEOUT_MS,
    maxRetries: 1,
  });
}

interface DirectStageOutcome {
  toolUse: FidelityCheckStep;
  toolResult: FidelityCheckStep;
}

async function runDirectStage(input: FidelityCheckInput): Promise<DirectStageOutcome> {
  const client = buildAnthropicClient(input);
  const userMessage = { role: 'user' as const, content: PROMPT };

  let first: { content?: unknown; stop_reason?: unknown };
  try {
    first = await client.messages.create({
      model: input.providerModel,
      max_tokens: 512,
      tools: [WEATHER_TOOL_SCHEMA],
      messages: [userMessage],
    }) as { content?: unknown; stop_reason?: unknown };
  } catch (error) {
    return {
      toolUse: { name: FIDELITY_STEP_NAMES.directToolUse, ok: false, detail: `request failed: ${describeError(error)}` },
      toolResult: {
        name: FIDELITY_STEP_NAMES.directToolResult,
        ok: false,
        detail: 'skipped: the tool_use stage did not complete',
      },
    };
  }

  const block = firstToolUseBlock(first.content);
  if (!block) {
    return {
      toolUse: {
        name: FIDELITY_STEP_NAMES.directToolUse,
        ok: false,
        detail: `no tool_use block in the response (stop_reason=${String(first.stop_reason)})`,
      },
      toolResult: {
        name: FIDELITY_STEP_NAMES.directToolResult,
        ok: false,
        detail: 'skipped: the tool_use stage did not complete',
      },
    };
  }

  if (block.name !== TOOL_NAME) {
    return {
      toolUse: {
        name: FIDELITY_STEP_NAMES.directToolUse,
        ok: false,
        detail: `tool_use named '${block.name}', expected '${TOOL_NAME}'`,
      },
      toolResult: {
        name: FIDELITY_STEP_NAMES.directToolResult,
        ok: false,
        detail: 'skipped: the tool_use stage did not complete',
      },
    };
  }

  const parsedInput = parseToolInput(block.input);
  if (!parsedInput) {
    return {
      toolUse: {
        name: FIDELITY_STEP_NAMES.directToolUse,
        ok: false,
        detail: `malformed tool_use input, expected { city: string }, got ${typeof block.input}`,
      },
      toolResult: {
        name: FIDELITY_STEP_NAMES.directToolResult,
        ok: false,
        detail: 'skipped: the tool_use stage did not complete',
      },
    };
  }

  if (!block.id) {
    return {
      toolUse: {
        name: FIDELITY_STEP_NAMES.directToolUse,
        ok: false,
        detail: 'tool_use block carried no id, so no tool_result can be submitted',
      },
      toolResult: {
        name: FIDELITY_STEP_NAMES.directToolResult,
        ok: false,
        detail: 'skipped: the tool_use stage did not complete',
      },
    };
  }

  const toolUse: FidelityCheckStep = {
    name: FIDELITY_STEP_NAMES.directToolUse,
    ok: true,
    detail: `tool_use for city='${parsedInput.city}'`,
  };

  let second: { content?: unknown; stop_reason?: unknown };
  try {
    second = await client.messages.create({
      model: input.providerModel,
      max_tokens: 512,
      tools: [WEATHER_TOOL_SCHEMA],
      messages: [
        userMessage,
        { role: 'assistant', content: first.content },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: block.id, content: WEATHER_RESULT_JSON }],
        },
      ],
    } as Parameters<Anthropic['messages']['create']>[0]) as { content?: unknown; stop_reason?: unknown };
  } catch (error) {
    return {
      toolUse,
      toolResult: {
        name: FIDELITY_STEP_NAMES.directToolResult,
        ok: false,
        detail: `tool_result request failed: ${describeError(error)}`,
      },
    };
  }

  if (second.stop_reason !== 'end_turn') {
    return {
      toolUse,
      toolResult: {
        name: FIDELITY_STEP_NAMES.directToolResult,
        ok: false,
        detail: `expected stop_reason 'end_turn' after the tool_result, got '${String(second.stop_reason)}'`,
      },
    };
  }

  const answer = textOf(second.content);
  if (!referencesToolResult(answer)) {
    return {
      toolUse,
      toolResult: {
        name: FIDELITY_STEP_NAMES.directToolResult,
        ok: false,
        detail: 'the final answer did not reference the submitted tool_result',
      },
    };
  }

  return {
    toolUse,
    toolResult: { name: FIDELITY_STEP_NAMES.directToolResult, ok: true, detail: 'end_turn referencing the tool_result' },
  };
}

async function runSdkSubprocessStage(input: FidelityCheckInput): Promise<FidelityCheckStep> {
  const name = FIDELITY_STEP_NAMES.sdkSubprocess;

  let sdk: typeof import('@anthropic-ai/claude-agent-sdk');
  try {
    sdk = await import('@anthropic-ai/claude-agent-sdk');
  } catch (error) {
    return { name, ok: false, detail: `skipped: agent SDK unavailable (${describeError(error)})` };
  }

  let toolExecuted = false;
  const weatherTool = sdk.tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    { city: z.string().describe('City name') },
    async () => {
      toolExecuted = true;
      return { content: [{ type: 'text' as const, text: WEATHER_RESULT_JSON }] };
    },
  );

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), SDK_STAGE_TIMEOUT_MS);
  timer.unref?.();

  try {
    const session = sdk.query({
      prompt: PROMPT,
      options: {
        model: input.providerModel,
        maxTurns: 4,
        tools: [],
        allowedTools: [SDK_TOOL_NAME],
        mcpServers: {
          [MCP_SERVER_NAME]: sdk.createSdkMcpServer({
            name: MCP_SERVER_NAME,
            version: '1.0.0',
            tools: [weatherTool],
          }),
        },
        settingSources: [],
        persistSession: false,
        thinking: { type: 'disabled' },
        abortController,
        env: buildFidelityChildEnv(input),
      },
    } as Parameters<typeof sdk.query>[0]);

    let result: { subtype?: unknown; is_error?: unknown; result?: unknown } | null = null;
    for await (const message of session) {
      if ((message as { type?: unknown }).type === 'result') {
        result = message as { subtype?: unknown; is_error?: unknown; result?: unknown };
      }
    }

    if (!result) {
      return { name, ok: false, detail: 'the subprocess session ended without a result message' };
    }
    if (result.subtype !== 'success' || result.is_error === true) {
      return { name, ok: false, detail: `subprocess session failed (subtype=${String(result.subtype)})` };
    }
    if (!toolExecuted) {
      return { name, ok: false, detail: `the subprocess answered without executing the ${TOOL_NAME} tool` };
    }
    const answer = typeof result.result === 'string' ? result.result : '';
    if (!referencesToolResult(answer)) {
      return { name, ok: false, detail: 'the subprocess answer did not reference the tool result' };
    }
    return { name, ok: true, detail: 'tool executed and answered in-subprocess' };
  } catch (error) {
    if (isSdkUnavailableError(error)) {
      return { name, ok: false, detail: `skipped: agent SDK subprocess unavailable (${describeError(error)})` };
    }
    return { name, ok: false, detail: `subprocess session errored: ${describeError(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeStep(step: FidelityCheckStep, secret: string): FidelityCheckStep {
  if (step.detail === undefined) return { name: step.name, ok: step.ok };
  const detail = redactSecret(step.detail, secret).slice(0, MAX_DETAIL_CHARS);
  return { name: step.name, ok: step.ok, detail };
}

export async function runFidelityCheck(input: FidelityCheckInput): Promise<FidelityCheckResult> {
  const direct = await runDirectStage(input);
  const directPassed = direct.toolUse.ok && direct.toolResult.ok;

  // A stage that cannot run is a FAILING step, never an omitted one — the
  // caller persists these steps as the verification record, and a record with
  // a missing stage must never read as a pass.
  const subprocess = directPassed
    ? await runSdkSubprocessStage(input)
    : {
      name: FIDELITY_STEP_NAMES.sdkSubprocess,
      ok: false,
      detail: 'skipped: the direct SDK stage did not pass',
    } satisfies FidelityCheckStep;

  const steps = [direct.toolUse, direct.toolResult, subprocess]
    .map((step) => sanitizeStep(step, input.apiKey));

  return {
    passed: steps.every((step) => step.ok),
    steps,
    harnessVersion: FIDELITY_HARNESS_VERSION,
  };
}
