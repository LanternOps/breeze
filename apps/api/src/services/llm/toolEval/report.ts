import type { CaptureSurfaceId } from '../toolCapture/surfaces';
import { GOLDEN_CASES, type GoldenExpectation } from './goldenPrompts';
import type { CaseScore, summarize } from './score';

export interface EvalReport {
  generatedAt: string;
  model: string;
  toolSearch: string;
  surface: CaptureSurfaceId;
  systemPromptBytes: number;
  cases: Array<CaseScore & {
    expected: GoldenExpectation[];
    inputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    ttftMs: number | null;
    toolSearchUsed: boolean;
  }>;
  summary: ReturnType<typeof summarize>;
  meanFirstCallInputTokens: number;
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

export function renderMarkdownReport(input: EvalReport): string {
  const { summary } = input;
  const lines = [
    `# Tool-selection accuracy ${summary.hits}/${summary.total} = ${(summary.accuracy * 100).toFixed(1)}%`,
    '',
    `Generated: ${input.generatedAt}; model: ${input.model}; surface: ${input.surface}; tool search: ${input.toolSearch}.`,
    '',
    '| id | prompt | expected | observed |',
    '| --- | --- | --- | --- |',
  ];
  for (const miss of summary.misses) {
    const golden = GOLDEN_CASES.find((c) => c.id === miss.id);
    const expected = input.cases.find((c) => c.id === miss.id)?.expected ?? golden?.expect ?? [];
    const observed = miss.observedTool === null ? 'No tool call'
      : `${miss.observedTool}${miss.observedAction === null ? '' : `.${miss.observedAction}`}${miss.unavailableTool ? ' (not exposed)' : ''}`;
    lines.push(`| ${[miss.id, golden?.prompt ?? '', expected.map((e) =>
      `${e.tool}${e.action === undefined ? '' : `.${e.action}`}`).join(', '), observed].map(cell).join(' | ')} |`);
  }
  lines.push('', `Mean first-call input tokens: ${input.meanFirstCallInputTokens}; system prompt bytes: ${input.systemPromptBytes}.`, '');
  return lines.join('\n');
}
