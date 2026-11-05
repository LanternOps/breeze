import type { ScriptProposalReviewFindingDto } from '@breeze/shared';

const FINDING_SEVERITIES = new Set(['info', 'warning', 'blocking']);

/**
 * Project the reviewer's stored `verdict.findings` (model output, jsonb) into
 * the finding DTO. Shared by the web detail read (detail.ts) and the
 * `get_script_proposal` / `propose_script` AI tools (#10399) so both report
 * the same findings. Drops entries without text; an unknown severity reads as
 * `info`.
 */
export function projectFindings(raw: unknown): ScriptProposalReviewFindingDto[] {
  if (!Array.isArray(raw)) return [];
  const out: ScriptProposalReviewFindingDto[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const f = item as { severity?: unknown; text?: unknown; lineRef?: unknown };
    if (typeof f.text !== 'string') continue;
    const severity = FINDING_SEVERITIES.has(String(f.severity)) ? (f.severity as ScriptProposalReviewFindingDto['severity']) : 'info';
    out.push({ severity, text: f.text, ...(typeof f.lineRef === 'number' ? { lineRef: f.lineRef } : {}) });
  }
  return out;
}
