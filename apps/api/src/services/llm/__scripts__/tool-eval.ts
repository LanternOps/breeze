#!/usr/bin/env tsx
/**
 * Evaluate first-call tool selection in deny mode. API scripts do not load dotenv.
 *
 * Usage:
 *   DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/unused ANTHROPIC_API_KEY=… \
 *   pnpm --filter @breeze/api ai:tool-eval -- [--suite chat|agent] [--surface chat|helper-standard|…]
 *     [--model <id>] [--tool-search default|on|off] [--surface-search production|on] [--cases g01,g02]
 *     [--concurrency 3] [--prompt-variant <id>] [--out tool-eval-report.json] [--summary-md tool-eval-summary.md]
 *
 * Defaults: chat suite on the chat surface, resolveDefaultModel(), default tool
 * search, production surface opt-in, all cases.
 *
 * `--suite agent` (#7428) runs the headless agent golden set
 * (`toolEval/agentGoldenTasks.ts`): each task on its own agent-profile surface
 * with the production agent system prompt and task turn for its run context.
 * `--surface` then narrows it to one agent surface. `--surface-search on`
 * measures a surface as if it opted in to tool search (agent runs do not
 * today); the host, `--tool-search` and the surface's real turn cap still
 * decide, exactly as `resolveToolSearchPolicy` would.
 * `--prompt-variant <id>` (W11 #7609) appends a registered prompt variant
 * (services/aiModels/promptVariants.ts) to every case's system prompt, so a
 * variant is evaluated against the base prompt before any live traffic sees it.
 * The variant's surface must match the suite and its profile must match
 * --model's (derivePromptProfile).
 * Scores and SDK errors never gate the caller; invalid usage or a missing key exits 2.
 */
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { closeDb } from '../../../db';
import { derivePromptProfile, resolveDefaultModel } from '../../aiModel';
import type { AiSurface } from '@breeze/shared';
import { PROMPT_VARIANTS, appendPromptGuidance, getPromptVariant, type PromptVariant } from '../../aiModels/promptVariants';
import { buildClaudeSdkChildEnv } from '../../streamingSessionManager';
import { getPlatformModelByModelId } from '../../aiModels/platformModels';
import { platformRateSnapshot, priceInvocation } from '../../aiModels/pricing';
import { buildAgentRunSystemPrompt, buildAgentRunTaskPrompt } from '../../aiAgents/runnerPrompt';
import type { CaptureSurface } from '../toolCapture/surfaces';
import { AGENT_GOLDEN_TASKS } from '../toolEval/agentGoldenTasks';
import { resolveLlmConfig } from '../llmConfigResolver';
import { captureToolSearchPolicy, getCaptureSystemPrompt, runSurfaceCapture } from '../toolCapture/runSurface';
import { CAPTURE_SURFACES, type CaptureSurfaceId } from '../toolCapture/surfaces';
import { GOLDEN_CASES, type GoldenCase } from '../toolEval/goldenPrompts';
import { renderMarkdownReport, type EvalReport } from '../toolEval/report';
import { scoreFirstCall, summarize } from '../toolEval/score';

class UsageError extends Error {}

/**
 * A searching run spends a turn on ToolSearch before its first real call
 * (plus one spare for a second search), so a 1-turn cap would score every
 * searched case as "no tool call". Non-searching runs keep the strict 1-turn
 * first-call cap. ToolSearch itself is never scored (streamObserver).
 */
const FIRST_CALL_MAX_TURNS_WITH_SEARCH = 3;
type EvalCaseResult = EvalReport['cases'][number] & { error?: string };

/** One scored run: a chat golden case or an agent golden task on its own surface. */
interface EvalJob {
  golden: GoldenCase;
  surface: CaptureSurface;
  /** Agent tasks carry their own production system prompt. */
  systemPrompt?: string;
}

const AGENT_SURFACE_IDS = new Set(AGENT_GOLDEN_TASKS.map((t) => t.surface));

/** The production prompt-hook surface each capture surface stands in for (--prompt-variant). */
const CAPTURE_AI_SURFACE: Record<CaptureSurfaceId, AiSurface> = {
  chat: 'chat', 'helper-basic': 'helper', 'helper-standard': 'helper', 'helper-extended': 'helper',
  'script-builder': 'script_builder', 'agent-full': 'ai_agents', 'agent-full-remediation': 'ai_agents', 'agent-analysis': 'ai_agents',
};

function parseArgs(args: string[]) {
  const values = new Map<string, string>();
  const flags = new Set(['--suite', '--surface', '--model', '--tool-search', '--surface-search', '--cases', '--concurrency', '--out', '--summary-md', '--prompt-variant']);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--') continue;
    if (!flags.has(flag)) throw new UsageError(`Unknown option: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new UsageError(`Missing value for ${flag}`);
    values.set(flag, value);
  }
  const suite = values.get('--suite') ?? 'chat';
  if (suite !== 'chat' && suite !== 'agent') throw new UsageError('--suite must be chat or agent');
  const surfaceArg = values.get('--surface');
  const surface = surfaceArg ?? 'chat';
  if (!Object.hasOwn(CAPTURE_SURFACES, surface)) throw new UsageError('--surface must be a capture surface ID');
  if (suite === 'agent' && surfaceArg && !AGENT_SURFACE_IDS.has(surfaceArg as never)) {
    throw new UsageError('--surface with --suite agent must be an agent surface');
  }
  const toolSearch = values.get('--tool-search') ?? 'default';
  if (!['default', 'on', 'off'].includes(toolSearch)) throw new UsageError('--tool-search must be default, on, or off');
  const surfaceSearch = values.get('--surface-search') ?? 'production';
  if (surfaceSearch !== 'production' && surfaceSearch !== 'on') throw new UsageError('--surface-search must be production or on');
  const concurrency = Number(values.get('--concurrency') ?? '3');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new UsageError('--concurrency must be a positive integer');
  const ids = values.get('--cases')?.split(',');
  const known = suite === 'agent' ? AGENT_GOLDEN_TASKS.map((t) => t.id) : GOLDEN_CASES.map((c) => c.id);
  if (ids?.some((id) => !known.includes(id))) throw new UsageError(`--cases must contain known ${suite} golden case IDs`);
  const jobs: EvalJob[] = suite === 'agent'
    ? AGENT_GOLDEN_TASKS
      .filter((t) => (!ids || ids.includes(t.id)) && (!surfaceArg || t.surface === surfaceArg))
      .map((t) => ({
        golden: { id: t.id, prompt: buildAgentRunTaskPrompt(t.context), expect: t.expect },
        surface: CAPTURE_SURFACES[t.surface],
        systemPrompt: buildAgentRunSystemPrompt(t.context),
      }))
    : GOLDEN_CASES
      .filter((c) => !ids || ids.includes(c.id))
      .map((c) => ({ golden: c, surface: CAPTURE_SURFACES[surface as CaptureSurfaceId] }));
  const model = values.get('--model') ?? resolveDefaultModel();
  const variantId = values.get('--prompt-variant');
  let promptVariant: PromptVariant | null = null;
  if (variantId) {
    promptVariant = getPromptVariant(variantId, PROMPT_VARIANTS) ?? null;
    if (!promptVariant) throw new UsageError(`--prompt-variant must be one of: ${PROMPT_VARIANTS.map((v) => v.id).join(', ')}`);
    const other = jobs.find((j) => CAPTURE_AI_SURFACE[j.surface.id] !== promptVariant!.surface);
    if (other) throw new UsageError(`--prompt-variant ${variantId} is a ${promptVariant.surface} variant; this run evaluates ${CAPTURE_AI_SURFACE[other.surface.id]}`);
    const profile = derivePromptProfile(model);
    if (profile !== promptVariant.profile) throw new UsageError(`--prompt-variant ${variantId} targets ${promptVariant.profile} models; --model ${model} is ${profile}`);
  }
  return {
    suite: suite as 'chat' | 'agent', surface: surface as CaptureSurfaceId, toolSearch, concurrency, jobs,
    surfaceSearch: surfaceSearch as 'production' | 'on',
    model, promptVariant,
    out: values.get('--out') ?? 'tool-eval-report.json',
    summaryMd: values.get('--summary-md') ?? 'tool-eval-summary.md',
  };
}

/** Exported so the CLI can be tested without starting SDK subprocesses or exiting Vitest. */
export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);
    // CI passes the dedicated eval key as AI_TOOL_EVAL_KEY (a repo guard forbids
    // workflows from naming the platform key variable); map it for the resolver.
    if (!process.env.ANTHROPIC_API_KEY?.trim() && process.env.AI_TOOL_EVAL_KEY?.trim()) {
      process.env.ANTHROPIC_API_KEY = process.env.AI_TOOL_EVAL_KEY.trim();
    }
    if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new UsageError('ANTHROPIC_API_KEY (or AI_TOOL_EVAL_KEY) is required');
    const resolved = await resolveLlmConfig(null);
    if (resolved.source === 'unavailable') throw new UsageError(`LLM configuration unavailable: ${resolved.reason}`);
    const env = buildClaudeSdkChildEnv(resolved);
    // The production policy (runSurface → aiToolSearchPolicy) owns
    // ENABLE_TOOL_SEARCH; --tool-search stands in for the AI_TOOL_SEARCH override.
    delete env.ENABLE_TOOL_SEARCH;
    const toolSearchOverride = args.toolSearch === 'default' ? 'auto' : args.toolSearch as 'on' | 'off';
    const surfaceSearch = args.surfaceSearch === 'on' ? true : undefined;
    const contextTokens = (call: { inputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }) =>
      call.inputTokens + call.cacheReadInputTokens + call.cacheCreationInputTokens;
    // Priced at the model's platform registry rate (the one cost function).
    // Dev script: an unpriced model reports NaN rather than a guessed rate.
    const platformRow = await getPlatformModelByModelId(args.model);
    const rate = platformRow ? platformRateSnapshot(platformRow) : null;
    const callCents = (call: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }) =>
      rate
        ? priceInvocation(rate, {
          input: call.inputTokens, output: call.outputTokens, cacheRead: call.cacheReadInputTokens, cacheWrite: call.cacheCreationInputTokens,
        }, {})
        : Number.NaN;

    async function evaluate(job: EvalJob): Promise<EvalCaseResult> {
      const { golden: c, surface } = job;
      const toolSearchEnabled = captureToolSearchPolicy(surface, env, toolSearchOverride, surfaceSearch).enabled;
      const maxTurns = toolSearchEnabled ? FIRST_CALL_MAX_TURNS_WITH_SEARCH : 1;
      const allowedTools = new Set(surface.allowedTools);
      const systemPrompt = args.promptVariant
        ? appendPromptGuidance(job.systemPrompt ?? getCaptureSystemPrompt(surface), args.promptVariant)
        : job.systemPrompt;
      for (let attempt = 0; ; attempt++) {
        try {
          const { observation } = await runSurfaceCapture({
            surface, prompt: c.prompt, model: args.model, env, maxTurns, toolSearchOverride,
            ...(systemPrompt === undefined ? {} : { systemPrompt }),
            ...(surfaceSearch === undefined ? {} : { surfaceSearch }),
          });
          const usage = observation.apiCalls[0];
          const throughFirstTool = observation.firstToolApiCallIndex === null
            ? observation.apiCalls
            : observation.apiCalls.slice(0, observation.firstToolApiCallIndex + 1);
          const firstToolCall = observation.firstToolApiCallIndex === null ? undefined : throughFirstTool.at(-1);
          return {
            ...scoreFirstCall(c, observation, allowedTools), expected: c.expect, surface: surface.id, toolSearchEnabled,
            inputTokens: usage?.inputTokens ?? 0,
            cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0,
            cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? 0,
            ttftMs: observation.ttftMs,
            toolSearchUsed: observation.toolSearchUses > 0 || observation.toolSearchResultBlocks > 0
              || observation.toolReferenceNames.length > 0,
            apiCallsToFirstTool: throughFirstTool.length,
            contextTokensToFirstTool: throughFirstTool.reduce((sum, call) => sum + contextTokens(call), 0),
            contextTokensAtFirstTool: firstToolCall ? contextTokens(firstToolCall) : 0,
            costCentsToFirstTool: throughFirstTool.reduce((sum, call) => sum + callCents(call), 0),
          };
        } catch (error) {
          if (attempt === 0) continue;
          return {
            ...scoreFirstCall(c, { toolUses: [] }), expected: c.expect, surface: surface.id, toolSearchEnabled,
            inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
            ttftMs: null, toolSearchUsed: false, apiCallsToFirstTool: 0, contextTokensToFirstTool: 0,
            contextTokensAtFirstTool: 0, costCentsToFirstTool: 0,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }

    const cases: EvalCaseResult[] = new Array(args.jobs.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(args.concurrency, args.jobs.length) }, async () => {
      while (next < args.jobs.length) {
        const index = next++;
        cases[index] = await evaluate(args.jobs[index]!);
      }
    }));
    const mean = (pick: (c: EvalCaseResult) => number) =>
      cases.length ? cases.reduce((sum, c) => sum + pick(c), 0) / cases.length : 0;
    const promptSurface = args.jobs[0]?.surface ?? CAPTURE_SURFACES[args.surface];
    const report: EvalReport = {
      generatedAt: new Date().toISOString(), model: args.model, suite: args.suite,
      surface: args.suite === 'agent' ? 'agent-suite' : args.surface,
      toolSearch: args.toolSearch, surfaceSearch: args.surfaceSearch,
      toolSearchEnabled: cases.length > 0 && cases.every((c) => c.toolSearchEnabled),
      promptVariant: args.promptVariant?.id ?? null,
      systemPromptBytes: Buffer.byteLength(
        appendPromptGuidance(args.jobs[0]?.systemPrompt ?? getCaptureSystemPrompt(promptSurface), args.promptVariant), 'utf8'),
      cases, summary: summarize(cases),
      meanFirstCallInputTokens: mean((c) => c.inputTokens),
      meanContextTokensToFirstTool: Math.round(mean((c) => c.contextTokensToFirstTool)),
      meanContextTokensAtFirstTool: Math.round(mean((c) => c.contextTokensAtFirstTool)),
      meanApiCallsToFirstTool: Math.round(mean((c) => c.apiCallsToFirstTool) * 100) / 100,
      meanCostCentsToFirstTool: Math.round(mean((c) => c.costCentsToFirstTool) * 1000) / 1000,
    };
    const markdown = renderMarkdownReport(report);
    await writeFile(args.out, JSON.stringify(report, null, 2) + '\n');
    await writeFile(args.summaryMd, markdown);
    console.log(markdown);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof UsageError ? 2 : 0;
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((code) => process.exit(code)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(0);
  });
}
