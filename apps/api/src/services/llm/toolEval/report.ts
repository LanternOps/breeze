import type { CaptureSurfaceId } from '../toolCapture/surfaces';
import { GOLDEN_CASES, type GoldenExpectation } from './goldenPrompts';
import { AGENT_GOLDEN_TASKS } from './agentGoldenTasks';
import type { CaseScore, summarize } from './score';

export interface EvalReport {
  generatedAt: string;
  model: string;
  /** `chat` = the 67-case chat set on one surface; `agent` = the agent golden set, each task on its own surface. */
  suite: 'chat' | 'agent';
  toolSearch: string;
  /** `production` = each surface's own opt-in; `on` = measured as if the surface opted in (#7428). */
  surfaceSearch: 'production' | 'on';
  /** True when the production policy enabled search for every case. */
  toolSearchEnabled: boolean;
  surface: CaptureSurfaceId | 'agent-suite';
  systemPromptBytes: number;
  /** W11: the prompt variant appended to every case's system prompt; null = the base prompt. */
  promptVariant: string | null;
  cases: Array<CaseScore & {
    expected: GoldenExpectation[];
    surface: CaptureSurfaceId;
    /** What the policy resolved for this case's surface. */
    toolSearchEnabled: boolean;
    inputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    ttftMs: number | null;
    toolSearchUsed: boolean;
    /** API responses up to and including the one that made the first real (non-ToolSearch) call. */
    apiCallsToFirstTool: number;
    /** input + cache read + cache creation tokens summed over those responses. */
    contextTokensToFirstTool: number;
    /** Context of the response that made the first real call — what every later turn re-sends (mostly as cache reads). */
    contextTokensAtFirstTool: number;
    /** `priceInvocation` at the platform registry rate, summed over those responses, output included (NaN when unpriced). */
    costCentsToFirstTool: number;
  }>;
  summary: ReturnType<typeof summarize>;
  meanFirstCallInputTokens: number;
  meanContextTokensToFirstTool: number;
  meanContextTokensAtFirstTool: number;
  meanApiCallsToFirstTool: number;
  meanCostCentsToFirstTool: number;
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

export function renderMarkdownReport(input: EvalReport): string {
  const { summary } = input;
  const lines = [
    `# Tool-selection accuracy ${summary.hits}/${summary.total} = ${(summary.accuracy * 100).toFixed(1)}%`,
    '',
    `Generated: ${input.generatedAt}; model: ${input.model}; suite: ${input.suite}; surface: ${input.surface}; tool search: ${input.toolSearch}, surface opt-in: ${input.surfaceSearch} (${input.toolSearchEnabled ? 'enabled' : 'disabled'} by policy${input.suite === 'agent' ? ' for every case' : ''}); prompt: ${input.promptVariant ?? 'base'}.`,
    '',
    '| id | prompt | expected | observed |',
    '| --- | --- | --- | --- |',
  ];
  for (const miss of summary.misses) {
    const golden = GOLDEN_CASES.find((c) => c.id === miss.id);
    const agentTask = AGENT_GOLDEN_TASKS.find((t) => t.id === miss.id);
    const expected = input.cases.find((c) => c.id === miss.id)?.expected ?? golden?.expect ?? agentTask?.expect ?? [];
    const observed = miss.observedTool === null ? 'No tool call'
      : `${miss.observedTool}${miss.observedAction === null ? '' : `.${miss.observedAction}`}${miss.unavailableTool ? ' (not exposed)' : ''}`;
    lines.push(`| ${[miss.id, golden?.prompt ?? agentTask?.title ?? '', expected.map((e) =>
      `${e.tool}${e.action === undefined ? '' : `.${e.action}`}`).join(', '), observed].map(cell).join(' | ')} |`);
  }
  lines.push('', `Mean first-call input tokens: ${input.meanFirstCallInputTokens}; mean context tokens through the first real tool call: ${input.meanContextTokensToFirstTool}; at it: ${input.meanContextTokensAtFirstTool}; API calls to it: ${input.meanApiCallsToFirstTool}; cost to it: ${input.meanCostCentsToFirstTool} cents; system prompt bytes: ${input.systemPromptBytes}.`, '');
  return lines.join('\n');
}
