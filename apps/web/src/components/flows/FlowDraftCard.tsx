import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { FlowDetailDto, FlowValidationResult } from '@breeze/shared';
import { FlowStepList } from './FlowStepList';
import { TriggerSummary } from './TriggerSummary';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLOW_CARD_TOOLS = new Set(['draft_flow', 'get_flow']);

export interface FlowToolPayload {
  flow: FlowDetailDto;
  validation: FlowValidationResult;
}

/**
 * Decides whether a chat tool result becomes a Flow card (#5218). Only a SAVED
 * `draft_flow` or a `get_flow` result carrying a flow qualifies; validation
 * failures, errors and unparsable output return null so the default tool card
 * keeps the failure visible.
 */
export function parseFlowToolResult(toolName: string | undefined, output: unknown): FlowToolPayload | null {
  if (!toolName || !FLOW_CARD_TOOLS.has(toolName)) return null;
  let parsed = output;
  if (typeof output === 'string') {
    try {
      parsed = JSON.parse(output);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const body = parsed as { saved?: unknown; flow?: unknown; validation?: unknown };
  if (toolName === 'draft_flow' && body.saved !== true) return null;
  const flow = body.flow as Partial<FlowDetailDto> | undefined;
  const validation = body.validation as Partial<FlowValidationResult> | undefined;
  // Model-visible output: check every element the card dereferences, so a
  // malformed payload falls back to the default card instead of throwing
  // inside the transcript.
  const objects = (xs: unknown[]) => xs.every((x) => !!x && typeof x === 'object');
  if (
    !flow || typeof flow !== 'object' || typeof flow.id !== 'string' ||
    !flow.definition || !Array.isArray(flow.definition.steps) || !objects(flow.definition.steps) ||
    typeof (flow.definition.trigger as { type?: unknown } | undefined)?.type !== 'string' ||
    !validation || typeof validation !== 'object' ||
    !Array.isArray(validation.steps) || !objects(validation.steps) ||
    !Array.isArray(validation.issues) || !objects(validation.issues)
  ) {
    return null;
  }
  return { flow: flow as FlowDetailDto, validation: validation as FlowValidationResult };
}

/** Compact, read-only Flow summary shown inline in AI chat. */
export default function FlowDraftCard({ flow, validation }: FlowToolPayload) {
  const { t } = useTranslation('flows');
  const errors = validation.issues.filter((i) => i.severity === 'error').length;
  const warnings = validation.issues.length - errors;
  // Same guard as scriptProposalHref: the id goes into an href.
  const href = UUID_RE.test(flow.id) ? `/flows/${flow.id.toLowerCase()}` : null;

  return (
    <div className="space-y-2 rounded-md border bg-card p-3 text-sm" data-testid="flow-draft-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs text-muted-foreground">{t('card.title')}</p>
          <p className="font-medium">{flow.definition.name}</p>
        </div>
        {href && (
          <a
            href={href}
            className="text-xs text-primary underline-offset-2 hover:underline"
            data-testid="flow-draft-review"
          >
            {t('card.review')}
          </a>
        )}
      </div>
      <p className="font-mono text-xs text-muted-foreground">
        <TriggerSummary trigger={flow.definition.trigger} />
      </p>
      <FlowStepList steps={flow.definition.steps} summaries={validation.steps} compact />
      <p className="text-xs text-muted-foreground" data-testid="flow-draft-issue-counts">
        {t('card.steps', { count: flow.definition.steps.length })}
        {' · '}
        {t('issues.error')}: {errors}
        {' · '}
        {t('issues.warning')}: {warnings}
      </p>
    </div>
  );
}
