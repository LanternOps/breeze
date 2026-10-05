import { useTranslation } from 'react-i18next';
import { CheckCheck, CheckCircle, PencilLine, PlayCircle, ShieldAlert, ShieldCheck, ThumbsDown, ThumbsUp, XCircle } from 'lucide-react';

import { trackRecordText } from './suggestionGroups';
import {
  canExecuteSuggestion,
  canMarkDone,
  canQueueSuggestion,
  OUTCOME_STATE_KEYS,
  parametersPreview,
  requiresExecutionApproval,
  riskClasses,
  targetDeviceLabel,
  targetIdentifier,
  targetLabel,
  type EditDraft,
  type RemediationSuggestion,
  type ReviewedInstructions,
  type SuggestionOutcome,
} from './suggestionRowModel';

type SavingReviewed = { id: string; title: string; steps: string };

export type SuggestionRowProps = {
  suggestion: RemediationSuggestion;
  approvalStatus: string | undefined;
  /** Non-null only while THIS row is being edited. */
  editDraft: EditDraft | null;
  setEditDraft: (draft: EditDraft | null) => void;
  busy: {
    updatingId: string | null;
    executingId: string | null;
    requestingApprovalId: string | null;
    votingId: string | null;
    markingDoneId: string | null;
  };
  reviewed: ReviewedInstructions[] | null;
  reviewedChoice: string;
  onReviewedChoice: (value: string) => void;
  /** Non-null only while THIS row's "Save as reviewed steps" editor is open. */
  savingReviewed: SavingReviewed | null;
  setSavingReviewed: (draft: SavingReviewed | null) => void;
  savingReviewedBusy: boolean;
  canManagePartnerWide: boolean | undefined;
  onUpdate: (suggestion: RemediationSuggestion, status: 'accepted' | 'edited' | 'rejected') => void;
  onBeginEdit: (suggestion: RemediationSuggestion) => void;
  onCancelEdit: () => void;
  onSaveEdit: (suggestion: RemediationSuggestion) => void;
  onExecute: (suggestion: RemediationSuggestion) => void;
  onVote: (suggestion: RemediationSuggestion, vote: 'up' | 'down') => void;
  onMarkDone: (suggestion: RemediationSuggestion) => void;
  onRequestApproval: (suggestion: RemediationSuggestion) => void;
  onSaveReviewed: (suggestion: RemediationSuggestion) => void;
  onDraftScript: (suggestion: RemediationSuggestion) => void | Promise<void>;
};

/** Proven-fix track record text for a row whose evidence carries the memory stats. */
export function provenTrackText(
  s: RemediationSuggestion,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const e = s.evidence ?? {};
  const verified = typeof e.verifiedCount === 'number' ? e.verifiedCount : null;
  const attempts = typeof e.attempts === 'number' ? e.attempts : null;
  if (verified === null || attempts === null) return null;
  const scope = e.scope === 'this_client' ? 'this_client' : 'all_clients';
  const lastVerifiedAt = typeof e.lastVerifiedAt === 'string' ? e.lastVerifiedAt : null;
  const { lastVerifiedDays } = trackRecordText({ verified, attempts, scope, lastVerifiedAt });
  const track = scope === 'this_client'
    ? t('longTail.remediation.RemediationSuggestionsPanel.proven.trackThisClient', { verified, attempts })
    : t('longTail.remediation.RemediationSuggestionsPanel.proven.trackAllClients', { verified, attempts });
  const age = lastVerifiedDays === null
    ? t('longTail.remediation.RemediationSuggestionsPanel.track.neverVerified')
    : t('longTail.remediation.RemediationSuggestionsPanel.track.lastVerified', { days: lastVerifiedDays });
  return `${track} · ${age}`;
}

export default function SuggestionRow(props: SuggestionRowProps) {
  const { t } = useTranslation('common');
  const {
    suggestion, approvalStatus, editDraft, setEditDraft, busy, reviewed, reviewedChoice, onReviewedChoice,
    savingReviewed, setSavingReviewed, savingReviewedBusy, canManagePartnerWide,
    onUpdate, onBeginEdit, onCancelEdit, onSaveEdit, onExecute, onVote, onMarkDone, onRequestApproval, onSaveReviewed, onDraftScript,
  } = props;
      const approvalPending = requiresExecutionApproval(suggestion) && suggestion.elevationRequestId && approvalStatus === 'pending';
    const editing = editDraft;
    const executionPreview = suggestion.status === 'accepted' || suggestion.status === 'edited';
    const parameterJson = parametersPreview(suggestion);
    return (
      <div key={suggestion.id} data-testid={`suggestion-row-${suggestion.id}`} className="rounded-md border p-3">
        {editing ? (
          <div className="space-y-3">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_10rem]">
              <label className="grid gap-1 text-sm font-medium">
                {t('longTail.remediation.RemediationSuggestionsPanel.fields.title')}
                <input
                  value={editDraft.title}
                  onChange={(event) => setEditDraft({ ...editDraft, title: event.currentTarget.value })}
                  className="rounded-md border bg-background px-3 py-2 text-sm font-normal"
                />
              </label>
              <label className="grid gap-1 text-sm font-medium">
                {t('longTail.remediation.RemediationSuggestionsPanel.fields.risk')}
                <select
                  value={editDraft.riskTier}
                  onChange={(event) => setEditDraft({ ...editDraft, riskTier: event.currentTarget.value as RemediationSuggestion['riskTier'] })}
                  className="rounded-md border bg-background px-3 py-2 text-sm font-normal"
                >
                  <option value="low">{t('longTail.remediation.RemediationSuggestionsPanel.risk.low')}</option>
                  <option value="medium">{t('longTail.remediation.RemediationSuggestionsPanel.risk.medium')}</option>
                  <option value="high">{t('longTail.remediation.RemediationSuggestionsPanel.risk.high')}</option>
                  <option value="critical">{t('longTail.remediation.RemediationSuggestionsPanel.risk.critical')}</option>
                </select>
              </label>
            </div>
            <label className="grid gap-1 text-sm font-medium">
              {t('longTail.remediation.RemediationSuggestionsPanel.fields.rationale')}
              <textarea
                value={editDraft.rationale}
                onChange={(event) => setEditDraft({ ...editDraft, rationale: event.currentTarget.value })}
                rows={3}
                className="rounded-md border bg-background px-3 py-2 text-sm font-normal"
              />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              {t('longTail.remediation.RemediationSuggestionsPanel.fields.expectedAction')}
              <textarea
                value={editDraft.expectedAction}
                onChange={(event) => setEditDraft({ ...editDraft, expectedAction: event.currentTarget.value })}
                rows={3}
                className="rounded-md border bg-background px-3 py-2 text-sm font-normal"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy.updatingId === suggestion.id || !editDraft.title.trim() || !editDraft.rationale.trim() || !editDraft.expectedAction.trim()}
                onClick={() => void onSaveEdit(suggestion)}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <CheckCircle className="h-4 w-4" />
                {t('longTail.remediation.RemediationSuggestionsPanel.saveEdits')}
              </button>
              <button
                type="button"
                disabled={busy.updatingId === suggestion.id}
                onClick={onCancelEdit}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                <XCircle className="h-4 w-4" />
                {t('common:actions.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{suggestion.title}</span>
                <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{targetLabel(suggestion, t)}</span>
                <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${riskClasses[suggestion.riskTier]}`}>
                  {t(/* i18n-dynamic */ `longTail.remediation.RemediationSuggestionsPanel.risk.${suggestion.riskTier}`)}
                </span>
                {suggestion.origin === 'ai_research' && (
                  <span data-testid={`suggestion-ai-badge-${suggestion.id}`} className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-700 dark:text-violet-300">
                    {t('longTail.remediation.RemediationSuggestionsPanel.badges.aiResearched')}
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{suggestion.rationale}</p>
              <p className="mt-2 text-sm">{suggestion.expectedAction}</p>
              {suggestion.targetType === 'manual_steps' && suggestion.evidence?.aiWritten === true && (
                <p data-testid={`suggestion-ai-written-${suggestion.id}`} className="mt-2 text-xs font-medium text-warning">
                  {t('longTail.remediation.RemediationSuggestionsPanel.badges.aiWritten')}
                </p>
              )}
              {suggestion.targetType === 'manual_steps' && Array.isArray(suggestion.parameters?.steps) && (
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
                  {(suggestion.parameters.steps as unknown[]).map((step, index) => <li key={index}>{String(step)}</li>)}
                </ol>
              )}
              {suggestion.status !== 'suggested' && (
                <p className="mt-2 text-xs font-medium text-muted-foreground">
                  {t('longTail.remediation.RemediationSuggestionsPanel.statusLine', {
                    status: t(/* i18n-dynamic */ `longTail.remediation.RemediationSuggestionsPanel.status.${suggestion.status}`),
                  })}
                </p>
              )}
              {suggestion.origin === 'memory' && (
                <p className="mt-2 inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300" data-testid="remediation-proven-badge">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  {t('longTail.remediation.RemediationSuggestionsPanel.proven.badge')}
                  {provenTrackText(suggestion, t) && <span className="font-normal">· {provenTrackText(suggestion, t)}</span>}
                </p>
              )}
              {suggestion.outcome && (
                <p className="mt-2 text-xs text-muted-foreground" data-testid="remediation-outcome">
                  {t('longTail.remediation.RemediationSuggestionsPanel.outcome.label', {
                    state: t(/* i18n-dynamic */ OUTCOME_STATE_KEYS[suggestion.outcome.state]),
                  })}
                </p>
              )}
              {executionPreview && (
                <div className="mt-3 rounded-md border bg-muted/30 p-3">
                  <p className="text-xs font-semibold text-foreground">{t('longTail.remediation.RemediationSuggestionsPanel.executionPreview')}</p>
                  <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                    <div className="min-w-0">
                      <dt className="font-medium text-muted-foreground">{t('longTail.remediation.RemediationSuggestionsPanel.preview.willRun')}</dt>
                      <dd className="wrap-break-word text-foreground">{targetLabel(suggestion, t)}: {targetIdentifier(suggestion, t)}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="font-medium text-muted-foreground">{t('longTail.remediation.RemediationSuggestionsPanel.preview.where')}</dt>
                      <dd className="wrap-break-word text-foreground">{targetDeviceLabel(suggestion, t)}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="font-medium text-muted-foreground">{t('longTail.remediation.RemediationSuggestionsPanel.preview.source')}</dt>
                      <dd className="wrap-break-word text-foreground">{suggestion.sourceType} {suggestion.sourceId}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="font-medium text-muted-foreground">{t('longTail.remediation.RemediationSuggestionsPanel.preview.risk')}</dt>
                      <dd className="wrap-break-word text-foreground">{t(/* i18n-dynamic */ `longTail.remediation.RemediationSuggestionsPanel.risk.${suggestion.riskTier}`)}</dd>
                    </div>
                    <div className="min-w-0 sm:col-span-2">
                      <dt className="font-medium text-muted-foreground">{t('longTail.remediation.RemediationSuggestionsPanel.preview.why')}</dt>
                      <dd className="wrap-break-word text-foreground">{suggestion.rationale}</dd>
                    </div>
                    <div className="min-w-0 sm:col-span-2">
                      <dt className="font-medium text-muted-foreground">{t('longTail.remediation.RemediationSuggestionsPanel.preview.expectedAction')}</dt>
                      <dd className="wrap-break-word text-foreground">{suggestion.expectedAction}</dd>
                    </div>
                  </dl>
                  {parameterJson && (
                    <div className="mt-2">
                      <p className="text-xs font-medium text-muted-foreground">{t('longTail.remediation.RemediationSuggestionsPanel.preview.parameters')}</p>
                      <pre className="mt-1 max-h-36 overflow-auto rounded-md border bg-background p-2 text-xs text-foreground">{parameterJson}</pre>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy.updatingId === suggestion.id || busy.executingId === suggestion.id || suggestion.status === 'accepted'}
              onClick={() => void onUpdate(suggestion, 'accepted')}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              <CheckCircle className="h-4 w-4" />
              {t('longTail.remediation.RemediationSuggestionsPanel.accept')}
            </button>
            <button
              type="button"
              disabled={
                busy.updatingId === suggestion.id ||
                busy.executingId === suggestion.id ||
                suggestion.status === 'rejected' ||
                suggestion.status === 'executed' ||
                suggestion.status === 'failed'
              }
              onClick={() => onBeginEdit(suggestion)}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              <PencilLine className="h-4 w-4" />
              {t('common:actions.edit')}
            </button>
            <button
              type="button"
              disabled={busy.updatingId === suggestion.id || busy.executingId === suggestion.id || suggestion.status === 'rejected'}
              onClick={() => void onUpdate(suggestion, 'rejected')}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              <XCircle className="h-4 w-4" />
              {t('longTail.remediation.RemediationSuggestionsPanel.reject')}
            </button>
            {canExecuteSuggestion(suggestion) && !approvalPending && (
              <button
                type="button"
                disabled={busy.executingId === suggestion.id || busy.requestingApprovalId === suggestion.id}
                onClick={() => void onExecute(suggestion)}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <PlayCircle className="h-4 w-4" />
                {suggestion.targetType === 'builtin_action'
                  ? t('longTail.remediation.RemediationSuggestionsPanel.runBuiltin', { action: suggestion.builtinAction ?? '' })
                  : t('longTail.remediation.RemediationSuggestionsPanel.execute')}
              </button>
            )}
            {/* A cancelled attempt never counts (a vote on it changes nothing): no rating. */}
            {suggestion.outcome && suggestion.outcome.state !== 'cancelled' && (
              <>
                <button
                  type="button"
                  aria-pressed={suggestion.outcome.humanVote === 'up'}
                  disabled={busy.votingId === suggestion.id}
                  onClick={() => void onVote(suggestion, 'up')}
                  className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 aria-pressed:bg-muted"
                  data-testid="remediation-vote-up"
                >
                  <ThumbsUp className="h-4 w-4" />
                  {t('longTail.remediation.RemediationSuggestionsPanel.feedback.worked')}
                </button>
                <button
                  type="button"
                  aria-pressed={suggestion.outcome.humanVote === 'down'}
                  disabled={busy.votingId === suggestion.id}
                  onClick={() => void onVote(suggestion, 'down')}
                  className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 aria-pressed:bg-muted"
                  data-testid="remediation-vote-down"
                >
                  <ThumbsDown className="h-4 w-4" />
                  {t('longTail.remediation.RemediationSuggestionsPanel.feedback.didNotWork')}
                </button>
              </>
            )}
            {canMarkDone(suggestion) && (
              <>
                <select
                  data-testid={`suggestion-done-reviewed-${suggestion.id}`}
                  value={reviewedChoice}
                  onChange={(event) => onReviewedChoice(event.currentTarget.value)}
                  aria-label={t('longTail.remediation.RemediationSuggestionsPanel.reviewed.pickerLabel')}
                  className="rounded-md border bg-background px-2 py-1.5 text-sm"
                >
                  <option value="">{t('longTail.remediation.RemediationSuggestionsPanel.reviewed.asWritten')}</option>
                  {(reviewed ?? []).map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
                </select>
                <button
                  type="button"
                  disabled={busy.markingDoneId === suggestion.id}
                  onClick={() => void onMarkDone(suggestion)}
                  className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                  data-testid={`suggestion-done-${suggestion.id}`}
                >
                  <CheckCheck className="h-4 w-4" />
                  {t('longTail.remediation.RemediationSuggestionsPanel.done.button')}
                </button>
              </>
            )}
            {suggestion.targetType === 'manual_steps' && suggestion.evidence?.aiWritten === true && canManagePartnerWide !== false && (
              <button
                type="button"
                data-testid={`suggestion-save-reviewed-${suggestion.id}`}
                onClick={() => setSavingReviewed({
                  id: suggestion.id,
                  title: suggestion.title,
                  steps: Array.isArray(suggestion.parameters?.steps) ? (suggestion.parameters.steps as unknown[]).map(String).join('\n') : '',
                })}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
              >
                <ShieldCheck className="h-4 w-4" />
                {t('longTail.remediation.RemediationSuggestionsPanel.reviewed.save')}
              </button>
            )}
            {suggestion.targetType === 'script_draft' && (
              <button
                type="button"
                onClick={() => void onDraftScript(suggestion)}
                data-testid={`suggestion-draft-${suggestion.id}`}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
              >
                <PencilLine className="h-4 w-4" />
                {t('longTail.remediation.RemediationSuggestionsPanel.draftScript')}
              </button>
            )}
            {canQueueSuggestion(suggestion) && requiresExecutionApproval(suggestion) && !suggestion.elevationRequestId && (
              <button
                type="button"
                disabled={busy.requestingApprovalId === suggestion.id || busy.updatingId === suggestion.id || busy.executingId === suggestion.id}
                onClick={() => void onRequestApproval(suggestion)}
                title={t('longTail.remediation.RemediationSuggestionsPanel.requestApprovalTitle')}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                <ShieldAlert className="h-4 w-4" />
                {busy.requestingApprovalId === suggestion.id
                  ? t('longTail.remediation.RemediationSuggestionsPanel.requesting')
                  : t('longTail.remediation.RemediationSuggestionsPanel.requestApproval')}
              </button>
            )}
            {approvalPending && (
              <button
                type="button"
                disabled
                title={t('longTail.remediation.RemediationSuggestionsPanel.waitingApprovalTitle')}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium text-muted-foreground disabled:cursor-not-allowed disabled:opacity-70"
              >
                <ShieldAlert className="h-4 w-4" />
                {t('longTail.remediation.RemediationSuggestionsPanel.approvalPending')}
              </button>
            )}
            </div>
          </div>
        )}
        {savingReviewed && (
          <div className="mt-3 space-y-2 rounded-md border bg-muted/30 p-3">
            <label className="grid gap-1 text-sm font-medium">
              {t('longTail.remediation.RemediationSuggestionsPanel.fields.title')}
              <input
                data-testid={`suggestion-reviewed-title-${suggestion.id}`}
                value={savingReviewed.title}
                onChange={(event) => setSavingReviewed({ ...savingReviewed, title: event.currentTarget.value })}
                className="rounded-md border bg-background px-3 py-2 text-sm font-normal"
              />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              {t('longTail.remediation.RemediationSuggestionsPanel.reviewed.stepsLabel')}
              <textarea
                data-testid={`suggestion-reviewed-steps-${suggestion.id}`}
                value={savingReviewed.steps}
                onChange={(event) => setSavingReviewed({ ...savingReviewed, steps: event.currentTarget.value })}
                rows={5}
                className="rounded-md border bg-background px-3 py-2 text-sm font-normal"
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                data-testid={`suggestion-reviewed-save-${suggestion.id}`}
                disabled={savingReviewedBusy || !savingReviewed.title.trim() || !savingReviewed.steps.trim()}
                onClick={() => void onSaveReviewed(suggestion)}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <CheckCircle className="h-4 w-4" />
                {t('longTail.remediation.RemediationSuggestionsPanel.saveEdits')}
              </button>
              <button
                type="button"
                disabled={savingReviewedBusy}
                onClick={() => setSavingReviewed(null)}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
              >
                <XCircle className="h-4 w-4" />
                {t('common:actions.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    );
}
