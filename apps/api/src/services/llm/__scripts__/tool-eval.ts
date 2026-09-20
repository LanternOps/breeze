#!/usr/bin/env tsx
/**
 * Evaluate first-call tool selection in deny mode. API scripts do not load dotenv.
 *
 * Usage:
 *   DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/unused ANTHROPIC_API_KEY=… \
 *   pnpm --filter @breeze/api ai:tool-eval -- [--surface chat|helper-standard|…]
 *     [--model <id>] [--tool-search default|on|off] [--cases g01,g02]
 *     [--concurrency 3] [--out tool-eval-report.json] [--summary-md tool-eval-summary.md]
 *
 * Defaults: chat, resolveDefaultModel(), default tool search, all golden cases.
 * Scores and SDK errors never gate the caller; invalid usage or a missing key exits 2.
 */
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { closeDb } from '../../../db';
import { resolveDefaultModel } from '../../aiModel';
import { buildClaudeSdkChildEnv } from '../../streamingSessionManager';
import { resolveLlmConfig } from '../llmConfigResolver';
import { getCaptureSystemPrompt, runSurfaceCapture } from '../toolCapture/runSurface';
import { CAPTURE_SURFACES, type CaptureSurfaceId } from '../toolCapture/surfaces';
import { GOLDEN_CASES, type GoldenCase } from '../toolEval/goldenPrompts';
import { renderMarkdownReport, type EvalReport } from '../toolEval/report';
import { scoreFirstCall, summarize } from '../toolEval/score';

class UsageError extends Error {}
type EvalCaseResult = EvalReport['cases'][number] & { error?: string };

function parseArgs(args: string[]) {
  const values = new Map<string, string>();
  const flags = new Set(['--surface', '--model', '--tool-search', '--cases', '--concurrency', '--out', '--summary-md']);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--') continue;
    if (!flags.has(flag)) throw new UsageError(`Unknown option: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new UsageError(`Missing value for ${flag}`);
    values.set(flag, value);
  }
  const surface = values.get('--surface') ?? 'chat';
  if (!Object.hasOwn(CAPTURE_SURFACES, surface)) throw new UsageError('--surface must be a capture surface ID');
  const toolSearch = values.get('--tool-search') ?? 'default';
  if (!['default', 'on', 'off'].includes(toolSearch)) throw new UsageError('--tool-search must be default, on, or off');
  const concurrency = Number(values.get('--concurrency') ?? '3');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new UsageError('--concurrency must be a positive integer');
  const ids = values.get('--cases')?.split(',');
  if (ids?.some((id) => !GOLDEN_CASES.some((c) => c.id === id))) throw new UsageError('--cases must contain known golden case IDs');
  return {
    surface: surface as CaptureSurfaceId, toolSearch, concurrency,
    cases: GOLDEN_CASES.filter((c) => !ids || ids.includes(c.id)),
    model: values.get('--model') ?? resolveDefaultModel(),
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
    delete env.ENABLE_TOOL_SEARCH;
    if (args.toolSearch !== 'default') env.ENABLE_TOOL_SEARCH = args.toolSearch === 'on' ? 'true' : 'false';

    const allowedTools = new Set(CAPTURE_SURFACES[args.surface].allowedTools);

    async function evaluate(c: GoldenCase): Promise<EvalCaseResult> {
      for (let attempt = 0; ; attempt++) {
        try {
          const { observation } = await runSurfaceCapture({
            surface: CAPTURE_SURFACES[args.surface], prompt: c.prompt, model: args.model, env, maxTurns: 1,
          });
          const usage = observation.apiCalls[0];
          return {
            ...scoreFirstCall(c, observation, allowedTools), expected: c.expect,
            inputTokens: usage?.inputTokens ?? 0,
            cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0,
            cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? 0,
            ttftMs: observation.ttftMs,
            toolSearchUsed: observation.toolSearchUses > 0 || observation.toolSearchResultBlocks > 0
              || observation.toolReferenceNames.length > 0,
          };
        } catch (error) {
          if (attempt === 0) continue;
          return {
            ...scoreFirstCall(c, { toolUses: [] }), expected: c.expect,
            inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
            ttftMs: null, toolSearchUsed: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }

    const cases: EvalCaseResult[] = new Array(args.cases.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(args.concurrency, args.cases.length) }, async () => {
      while (next < args.cases.length) {
        const index = next++;
        cases[index] = await evaluate(args.cases[index]!);
      }
    }));
    const report: EvalReport = {
      generatedAt: new Date().toISOString(), model: args.model, surface: args.surface,
      toolSearch: args.toolSearch, systemPromptBytes: Buffer.byteLength(getCaptureSystemPrompt(CAPTURE_SURFACES[args.surface]), 'utf8'),
      cases, summary: summarize(cases),
      meanFirstCallInputTokens: cases.length ? cases.reduce((sum, c) => sum + c.inputTokens, 0) / cases.length : 0,
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
