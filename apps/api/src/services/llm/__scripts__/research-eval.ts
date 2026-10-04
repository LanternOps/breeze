#!/usr/bin/env tsx
/**
 * Research eval (AI Suggested Fixes W2): runs REAL research on ~20
 * alert shapes against a DISPOSABLE stack and reports cost, turns and
 * suggestion validity per depth, with a recommended per-run cap. Budget
 * ceilings are lifted to 100 cents for the run; turn caps stay as shipped.
 * API scripts do not load dotenv.
 *
 * Usage:
 *   DATABASE_URL=<disposable test db> REDIS_URL=<test redis> BREEZE_AI_AGENTS_ENABLED=true \
 *   RESEARCH_EVAL_ALLOW_WRITES=1 ANTHROPIC_API_KEY=… \
 *   npx tsx src/services/llm/__scripts__/research-eval.ts [--depth quick|deep|quick,deep]
 *     [--cases w-svc-1,l-disk-1] [--concurrency 2] [--out research-eval-report.json]
 *     [--summary-md research-eval-summary.md]
 *
 * It WRITES fixture tenants (partner, org, device, alert, scripts) per case and
 * never cleans them up (disposable stack only), so it refuses without
 * RESEARCH_EVAL_ALLOW_WRITES=1, in production, and when DATABASE_URL is not a
 * loopback host (override: RESEARCH_EVAL_ALLOW_REMOTE_DB=1). The
 * numbers inform a human decision; scores never gate (exit 0). Invalid usage,
 * a missing key, or a refused environment exits 2;
 * an unexpected failure exits 1.
 */
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import { closeDb } from '../../../db';
import { RESEARCH_EVAL_CASES, type ResearchEvalCase } from '../researchEval/cases';
import { runResearchEvalCase } from '../researchEval/runCase';
import { renderEvalMarkdown, scoreRun, summarizeDepth, type CaseRun, type CaseScore } from '../researchEval/score';

class UsageError extends Error {}

/** True when the URL's host is loopback. Unparseable or absent URLs are not loopback. */
export function isLoopbackDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

type Depth = 'quick' | 'deep';

function parseArgs(args: string[]) {
  const values = new Map<string, string>();
  const flags = new Set(['--depth', '--cases', '--concurrency', '--out', '--summary-md']);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--') continue;
    if (!flags.has(flag)) throw new UsageError(`Unknown option: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new UsageError(`Missing value for ${flag}`);
    values.set(flag, value);
  }
  const depths = (values.get('--depth') ?? 'quick,deep').split(',');
  if (depths.length === 0 || depths.some((d) => d !== 'quick' && d !== 'deep') || new Set(depths).size !== depths.length) {
    throw new UsageError('--depth must be quick, deep or quick,deep');
  }
  const concurrency = Number(values.get('--concurrency') ?? '2');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new UsageError('--concurrency must be a positive integer');
  const ids = values.get('--cases')?.split(',');
  if (ids?.some((id) => !RESEARCH_EVAL_CASES.some((c) => c.id === id))) throw new UsageError('--cases must contain known research eval case IDs');
  const cases: readonly ResearchEvalCase[] = RESEARCH_EVAL_CASES.filter((c) => !ids || ids.includes(c.id));
  return {
    depths: depths as Depth[], concurrency, cases,
    out: values.get('--out') ?? 'research-eval-report.json',
    summaryMd: values.get('--summary-md') ?? 'research-eval-summary.md',
  };
}

/** Exported so the CLI can be tested without a database or model calls. */
export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);
    // The dedicated eval key (CI) is mapped for the platform LLM resolver, as in tool-eval.
    if (!process.env.ANTHROPIC_API_KEY?.trim() && process.env.AI_TOOL_EVAL_KEY?.trim()) {
      process.env.ANTHROPIC_API_KEY = process.env.AI_TOOL_EVAL_KEY.trim();
    }
    if (!process.env.ANTHROPIC_API_KEY?.trim()) {
      throw new UsageError('ANTHROPIC_API_KEY (or AI_TOOL_EVAL_KEY) is required: the eval makes real model calls and a run without a key would measure nothing');
    }
    if (process.env.NODE_ENV === 'production') throw new UsageError('refusing to run the research eval with NODE_ENV=production');
    if (process.env.RESEARCH_EVAL_ALLOW_WRITES !== '1') {
      throw new UsageError('refusing to write eval fixtures: set RESEARCH_EVAL_ALLOW_WRITES=1 and point DATABASE_URL at a disposable stack (pnpm test-stack up)');
    }

    if (process.env.RESEARCH_EVAL_ALLOW_REMOTE_DB !== '1' && !isLoopbackDatabaseUrl(process.env.DATABASE_URL)) {
      throw new UsageError('refusing to write eval fixtures: DATABASE_URL is not a loopback host; point it at the disposable test stack (or set RESEARCH_EVAL_ALLOW_REMOTE_DB=1 to override)');
    }

    const jobs = args.depths.flatMap((depth) => args.cases.map((c) => ({ c, depth })));
    const runs: Array<CaseRun & { model?: string | null }> = new Array(jobs.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(args.concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        const index = next++;
        const { c, depth } = jobs[index]!;
        try {
          runs[index] = await runResearchEvalCase(c, depth);
        } catch (error) {
          runs[index] = {
            caseId: c.id, depth, status: 'harness_error', errorCode: null, costCents: 0, turns: 0, outcome: null,
            denial: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }));

    const byId = new Map(args.cases.map((c) => [c.id, c]));
    const scores: CaseScore[] = runs.map((r) => scoreRun(byId.get(r.caseId)!, r));
    const summaries = args.depths.map((d) => summarizeDepth(scores, d));
    const defaults = { quick: AI_AGENT_LIMIT_DEFAULTS.researchQuickBudgetCentsPerRun, deep: AI_AGENT_LIMIT_DEFAULTS.researchDeepBudgetCentsPerRun };
    const models = [...new Set(runs.map((r) => r.model).filter((m): m is string => !!m))];
    const denied = runs.filter((r) => r.status === 'denied' || r.status === 'harness_error');
    const markdown = renderEvalMarkdown(summaries, scores, defaults)
      + `\nModel(s): ${models.join(', ') || 'unknown'}\n`
      + (denied.length ? `\n${denied.length} run(s) denied or errored (measured nothing): ${denied.map((r) => `${r.caseId}/${r.depth}=${r.errorCode ?? r.status}`).join(', ')}\n` : '');
    await writeFile(args.out, JSON.stringify({ generatedAt: new Date().toISOString(), models, cases: runs, scores, summaries }, null, 2) + '\n');
    await writeFile(args.summaryMd, markdown);
    console.log(markdown);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof UsageError ? 2 : 1;
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((code) => process.exit(code)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
