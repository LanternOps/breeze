/**
 * Wisp analysis sessions W01 (#11845, spec §4.1): an analysis run's result as
 * the next chat turn sees it.
 *
 * Everything that originated in the run (summary, findings, proposals and the
 * names of the files it produced) goes inside ONE `analysis_run_result`
 * untrusted-data fence. The block is capped at 8 KB in UTF-8 bytes: findings
 * are cut first (from the end), then proposals, then the summary is shortened,
 * and only then are files dropped from the end. When anything was cut by that
 * cap, one Breeze-authored line after the fence says what was left out.
 *
 * Pure: no I/O. Called from exactly one place, `drainPendingRunResults`
 * (`chatRunBridge.ts`), which is where `chain` (W03) arrives.
 */
import type { AiRunResultArtifactRef, AnalysisOutcome } from '@breeze/shared';
import { wrapUntrustedData } from '../aiInputSanitizer';

export const ANALYSIS_RESULT_MAX_BYTES = 8192;
export const ANALYSIS_RESULT_MAX_FINDINGS = 20;
export const ANALYSIS_RESULT_MAX_PROPOSALS = 10;
export const ANALYSIS_FINDING_DETAIL_MAX_CHARS = 500;

const FENCE_LABEL = 'analysis_run_result';
const NO_SUMMARY = '(no summary was produced)';
const ELLIPSIS = '…';

export interface RenderAnalysisRunResultInput {
  /** `ai_agent_runs.outcome.analysis`, already schema-checked; null when the run submitted none. */
  outcome: AnalysisOutcome | null;
  /** The `summary` column: the fallback when there is no outcome. */
  summary: string | null;
  /** The run's `output` files. */
  artifacts: AiRunResultArtifactRef[];
  /** W03: the run's position in its chain (`chain_depth`). */
  chain?: { depth: number };
}

/** Code points, never UTF-16 units, so a cut never splits a surrogate pair. */
function cutChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}${ELLIPSIS}` : text;
}

/** One list item stays on one line, whatever the run wrote. */
const oneLine = (text: string): string => text.replace(/[\r\n]+/g, ' ');

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

interface Draft {
  summary: string;
  summaryCut: boolean;
  findings: string[];
  findingTotal: number;
  proposals: string[];
  proposalTotal: number;
  files: string[];
  // What the byte cap removed (the 20/10 caps are stated by "showing k of n").
  cutFindings: number;
  cutProposals: number;
  cutFiles: number;
}

function compose(d: Draft, chain: { depth: number } | undefined): string {
  const lines: string[] = [];
  if (chain) lines.push(`Step ${chain.depth + 1} of this investigation`);
  lines.push(`Summary: ${d.summary}`);
  if (d.findingTotal > 0) {
    lines.push(`Findings (showing ${d.findings.length} of ${d.findingTotal}):`, ...d.findings);
  }
  if (d.proposalTotal > 0) {
    lines.push(`Proposed actions (showing ${d.proposals.length} of ${d.proposalTotal}):`, ...d.proposals);
  }
  lines.push('Files it produced:');
  lines.push(...(d.files.length > 0 ? d.files : ['  (none)']));
  const fenced = wrapUntrustedData(FENCE_LABEL, lines.join('\n'));

  const parts: string[] = [];
  if (d.cutFindings > 0) parts.push(plural(d.cutFindings, 'finding', 'findings'));
  if (d.cutProposals > 0) parts.push(plural(d.cutProposals, 'proposed action', 'proposed actions'));
  if (d.summaryCut) parts.push('part of the summary');
  if (d.cutFiles > 0) parts.push(plural(d.cutFiles, 'file', 'files'));
  if (parts.length === 0) return fenced;
  return `${fenced}\n(Breeze shortened this result to fit 8 KB. Left out: ${parts.join(', ')}. The run page has the full result.)`;
}

const fits = (text: string): boolean => Buffer.byteLength(text, 'utf8') <= ANALYSIS_RESULT_MAX_BYTES;

/**
 * The longest summary prefix (in code points) that fits with everything else
 * in `d`, or null when even an empty prefix does not. Binary search: the
 * rendered size grows monotonically with the prefix length.
 */
function fitSummary(d: Draft, full: string, chain: { depth: number } | undefined): string | null {
  const chars = Array.from(full);
  const at = (k: number): Draft => ({ ...d, summary: `${chars.slice(0, k).join('')}${ELLIPSIS}`, summaryCut: true });
  if (!fits(compose(at(0), chain))) return null;
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(compose(at(mid), chain))) lo = mid;
    else hi = mid - 1;
  }
  return at(lo).summary;
}

/** The fenced result for one analysis run, at most `ANALYSIS_RESULT_MAX_BYTES` UTF-8 bytes. */
export function renderAnalysisRunResult(input: RenderAnalysisRunResultInput): string {
  const { outcome, chain } = input;
  const fullSummary = outcome?.summary || input.summary || NO_SUMMARY;
  const findings = outcome?.findings ?? [];
  const proposals = outcome?.proposedActions ?? [];

  const d: Draft = {
    summary: fullSummary,
    summaryCut: false,
    findings: findings.slice(0, ANALYSIS_RESULT_MAX_FINDINGS).map((f) =>
      `- ${f.severity} · ${oneLine(f.title)} · ${oneLine(cutChars(f.detail, ANALYSIS_FINDING_DETAIL_MAX_CHARS))}`),
    findingTotal: findings.length,
    proposals: proposals.slice(0, ANALYSIS_RESULT_MAX_PROPOSALS).map((p) =>
      `- ${oneLine(p.action ? `${p.tool}:${p.action}` : p.tool)} · ${oneLine(p.deviceId ?? '(no device)')} · ${oneLine(p.rationale)}`),
    proposalTotal: proposals.length,
    files: input.artifacts.map((a) =>
      `- ${oneLine(a.name)} (${a.bytes} bytes, ${oneLine(a.contentType)}, handle ${oneLine(a.handle)})`),
    cutFindings: 0,
    cutProposals: 0,
    cutFiles: 0,
  };

  let rendered = compose(d, chain);
  while (!fits(rendered) && d.findings.length > 0) {
    d.findings.pop();
    d.cutFindings += 1;
    rendered = compose(d, chain);
  }
  while (!fits(rendered) && d.proposals.length > 0) {
    d.proposals.pop();
    d.cutProposals += 1;
    rendered = compose(d, chain);
  }
  if (fits(rendered)) return rendered;

  let summary = fitSummary(d, fullSummary, chain);
  while (summary === null && d.files.length > 0) {
    d.files.pop();
    d.cutFiles += 1;
    summary = fitSummary(d, fullSummary, chain);
  }
  // Unreachable in practice (an empty result is far under 8 KB); kept total.
  return compose({ ...d, summary: summary ?? ELLIPSIS, summaryCut: true }, chain);
}
