export type SuggestionStatus = 'suggested' | 'accepted' | 'edited' | 'rejected' | 'executed' | 'failed';

export type OutcomeState = 'pending' | 'awaiting_recovery' | 'holding' | 'verified' | 'failed' | 'recurred' | 'inconclusive' | 'cancelled';
export type SuggestionOutcome = { state: OutcomeState; stateReason: string | null; humanVote: 'up' | 'down' | null };

export type RemediationSuggestion = {
  id: string;
  sourceType: string;
  sourceId: string;
  deviceId: string | null;
  targetType: 'script' | 'script_template' | 'playbook' | 'diagnostic' | 'manual_steps' | 'builtin_action' | 'script_draft';
  scriptId: string | null;
  scriptTemplateId: string | null;
  playbookId: string | null;
  title: string;
  rationale: string;
  expectedAction: string;
  riskTier: 'low' | 'medium' | 'high' | 'critical';
  status: SuggestionStatus;
  confidence: number | null;
  parameters: Record<string, unknown>;
  targetDeviceIds: string[];
  elevationRequestId: string | null;
  scriptExecutionId: string | null;
  builtinAction?: string | null;
  agentRunId?: string | null;
  origin?: 'catalog_match' | 'memory' | 'ai_research';
  evidence?: Record<string, unknown>;
  outcome?: SuggestionOutcome | null;
};

export type ReviewedInstructions = { id: string; title: string; steps: string[]; osType: string | null };

export const OUTCOME_STATE_KEYS: Record<OutcomeState, string> = {
  pending: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.pending',
  awaiting_recovery: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.awaitingRecovery',
  holding: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.holding',
  verified: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.verified',
  failed: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.failed',
  recurred: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.recurred',
  inconclusive: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.inconclusive',
  cancelled: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.cancelled',
};

export function canMarkDone(s: RemediationSuggestion): boolean {
  return s.targetType === 'manual_steps' && (s.status === 'accepted' || s.status === 'edited') && !s.outcome;
}

export type EditDraft = Pick<RemediationSuggestion, 'title' | 'rationale' | 'expectedAction' | 'riskTier'>;

export const riskClasses: Record<RemediationSuggestion['riskTier'], string> = {
  low: 'border-success/30 bg-success/10 text-success',
  medium: 'border-warning/30 bg-warning/10 text-warning',
  high: 'border-destructive/40 bg-destructive/10 text-destructive',
  critical: 'border-destructive bg-destructive/15 text-destructive',
};

export function targetLabel(suggestion: RemediationSuggestion, t: (key: string) => string): string {
  if (suggestion.targetType === 'builtin_action') return t('longTail.remediation.RemediationSuggestionsPanel.targets.builtin');
  if (suggestion.targetType === 'manual_steps') return t('longTail.remediation.RemediationSuggestionsPanel.targets.manualSteps');
  if (suggestion.targetType === 'script_draft') return t('longTail.remediation.RemediationSuggestionsPanel.targets.scriptDraft');
  if (suggestion.targetType === 'script') return t('longTail.remediation.RemediationSuggestionsPanel.targets.script');
  if (suggestion.targetType === 'script_template') return t('longTail.remediation.RemediationSuggestionsPanel.targets.template');
  if (suggestion.targetType === 'playbook') return t('longTail.remediation.RemediationSuggestionsPanel.targets.playbook');
  return t('longTail.remediation.RemediationSuggestionsPanel.targets.diagnostic');
}

export function targetIdentifier(suggestion: RemediationSuggestion, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (suggestion.targetType === 'builtin_action') {
    return t('longTail.remediation.RemediationSuggestionsPanel.targetIdentifiers.builtin', { action: suggestion.builtinAction ?? '' });
  }
  if (suggestion.targetType === 'script') {
    return suggestion.scriptId
      ? t('longTail.remediation.RemediationSuggestionsPanel.targetIdentifiers.script', { id: suggestion.scriptId })
      : t('longTail.remediation.RemediationSuggestionsPanel.targetIdentifiers.scriptMissing');
  }
  if (suggestion.targetType === 'script_template') {
    return suggestion.scriptTemplateId
      ? t('longTail.remediation.RemediationSuggestionsPanel.targetIdentifiers.template', { id: suggestion.scriptTemplateId })
      : t('longTail.remediation.RemediationSuggestionsPanel.targetIdentifiers.templateMissing');
  }
  if (suggestion.targetType === 'playbook') {
    return suggestion.playbookId
      ? t('longTail.remediation.RemediationSuggestionsPanel.targetIdentifiers.playbook', { id: suggestion.playbookId })
      : t('longTail.remediation.RemediationSuggestionsPanel.targetIdentifiers.playbookMissing');
  }
  return t('longTail.remediation.RemediationSuggestionsPanel.targetIdentifiers.diagnostic');
}

export function targetDeviceLabel(suggestion: RemediationSuggestion, t: (key: string, options?: Record<string, unknown>) => string): string {
  const ids = suggestion.targetDeviceIds.length > 0
    ? suggestion.targetDeviceIds
    : suggestion.deviceId
      ? [suggestion.deviceId]
      : [];

  if (ids.length === 0) return t('longTail.remediation.RemediationSuggestionsPanel.targetDevices.none');
  if (ids.length === 1) return t('longTail.remediation.RemediationSuggestionsPanel.targetDevices.one', { id: ids[0] });
  return t('longTail.remediation.RemediationSuggestionsPanel.targetDevices.many', { count: ids.length, ids: ids.join(', ') });
}

export function parametersPreview(suggestion: RemediationSuggestion): string | null {
  if (!suggestion.parameters || Object.keys(suggestion.parameters).length === 0) return null;
  return JSON.stringify(suggestion.parameters, null, 2);
}

export function singleTargetDeviceId(suggestion: RemediationSuggestion): string | null {
  if (suggestion.targetDeviceIds.length === 1) return suggestion.targetDeviceIds[0] ?? null;
  if (suggestion.targetDeviceIds.length === 0) return suggestion.deviceId;
  return null;
}

export function canQueueSuggestion(suggestion: RemediationSuggestion): boolean {
  const hasTarget = suggestion.targetType === 'script'
    ? Boolean(suggestion.scriptId)
    : suggestion.targetType === 'builtin_action' && Boolean(suggestion.builtinAction);
  return (
    hasTarget &&
    Boolean(singleTargetDeviceId(suggestion)) &&
    (suggestion.status === 'accepted' || suggestion.status === 'edited') &&
    !suggestion.scriptExecutionId
  );
}

export function requiresExecutionApproval(suggestion: RemediationSuggestion): boolean {
  return suggestion.riskTier === 'high' || suggestion.riskTier === 'critical';
}

export function canExecuteSuggestion(suggestion: RemediationSuggestion): boolean {
  return canQueueSuggestion(suggestion) && (!requiresExecutionApproval(suggestion) || Boolean(suggestion.elevationRequestId));
}

