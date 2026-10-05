/**
 * AI Suggested Fixes W2 — the ONE definition of the `parameters` JSON a
 * research item persists, shared by the validator (researchSubmission.ts,
 * DB-free) and the mapper (researchPersist.ts) so the size bound enforced at
 * validation can never drift from what is written.
 */
import type { ResearchSuggestionItem } from '@breeze/shared';

/** remediation_suggestions_parameters_size_check: octet_length(parameters::text) <= 8192. */
export const MAX_SUGGESTION_PARAMETERS_BYTES = 8192;

export function researchItemParameters(item: ResearchSuggestionItem): Record<string, unknown> {
  switch (item.kind) {
    case 'catalog': return {};
    case 'builtin_action': return item.params as Record<string, unknown>;
    case 'manual_steps': return { steps: item.steps };
    case 'draft_request': return { brief: item.brief, language: item.language };
  }
}

/** jsonb::text rendering (`{"k": v, "k2": v2}`, `[a, b]`) — Postgres pads separators, JSON.stringify does not. */
function jsonbText(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jsonbText).join(', ')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${JSON.stringify(k)}: ${jsonbText(x)}`).join(', ')}}`;
  }
  return JSON.stringify(v);
}

export function researchItemParametersBytes(item: ResearchSuggestionItem): number {
  return Buffer.byteLength(jsonbText(researchItemParameters(item)), 'utf8');
}

export function researchItemTooLarge(item: ResearchSuggestionItem): boolean {
  return researchItemParametersBytes(item) > MAX_SUGGESTION_PARAMETERS_BYTES;
}
