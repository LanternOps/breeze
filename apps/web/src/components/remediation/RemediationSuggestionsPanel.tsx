import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Sparkles } from 'lucide-react';

import { ActionError, handleActionError, runAction } from '../../lib/runAction';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { useMlFeatureFlags } from '../../hooks/useMlFeatureFlags';
import ResearchControls from './ResearchControls';
import SuggestionRow from './SuggestionRow';
import {
  canExecuteSuggestion,
  canMarkDone,
  canQueueSuggestion,
  requiresExecutionApproval,
  type EditDraft,
  type RemediationSuggestion,
  type ReviewedInstructions,
  type SuggestionOutcome,
} from './suggestionRowModel';
import { useResearchStatus, type ResearchOutcome } from './useResearchStatus';
import {
  groupSuggestions,
  researchPanelState,
  trackRecordText,
  type ResearchStatusDto,
  type TrackRecordLite,
} from './suggestionGroups';

type RemediationSuggestionsPanelProps = {
  sourceType: 'alert' | 'anomaly' | 'correlation' | 'rca';
  sourceId: string;
  orgId?: string;
  deviceId?: string;
};

export default function RemediationSuggestionsPanel({ sourceType, sourceId, orgId, deviceId }: RemediationSuggestionsPanelProps) {
  const { t } = useTranslation('common');
  const mlFlags = useMlFeatureFlags();
  const [suggestions, setSuggestions] = useState<RemediationSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [requestingApprovalId, setRequestingApprovalId] = useState<string | null>(null);
  const [approvalStatuses, setApprovalStatuses] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [error, setError] = useState<string>();
  const [votingId, setVotingId] = useState<string | null>(null);
  const [markingDoneId, setMarkingDoneId] = useState<string | null>(null);
  const [memory, setMemory] = useState<{ proven: TrackRecordLite[]; similar: TrackRecordLite[] }>({ proven: [], similar: [] });
  const [researchBusy, setResearchBusy] = useState(false);
  const [reviewed, setReviewed] = useState<ReviewedInstructions[] | null>(null);
  const [reviewedChoice, setReviewedChoice] = useState<Record<string, string>>({});
  const [savingReviewed, setSavingReviewed] = useState<{ id: string; title: string; steps: string } | null>(null);
  const [savingReviewedBusy, setSavingReviewedBusy] = useState(false);
  const canManagePartnerWide = useAuthStore((state) => state.user?.canManagePartnerWide);
  const sourceQuery = new URLSearchParams({ sourceType, sourceId, ...(orgId ? { orgId } : {}) }).toString();
  const sourceQueryRef = useRef(sourceQuery);
  sourceQueryRef.current = sourceQuery;
  const onResearchTerminal = useCallback(() => { void fetchSuggestionsRef.current(true); }, []);
  const research = useResearchStatus(sourceQuery, onResearchTerminal);
  const fetchSuggestionsRef = useRef<(silent?: boolean, includeList?: boolean) => Promise<void>>(async () => undefined);

  const fetchSuggestions = useCallback(async (silent = false, includeList = true) => {
    if (!silent) setLoading(true);
    setError(undefined);
    const query = sourceQueryRef.current;
    // Memory and research are best-effort: a failure of either must never blank the list.
    const loadMemory = fetchWithAuth(`/remediation-suggestions/memory?${query}`)
      .then(async (r) => (r.ok ? (await r.json())?.data : null))
      .catch(() => null);
    const loadResearch = fetchWithAuth(`/remediation-suggestions/research?${query}`)
      .then(async (r) => (r.ok ? (await r.json())?.data : null))
      .catch(() => null);
    try {
      if (!includeList) return;
      const params = new URLSearchParams({ sourceType, sourceId, limit: '5' });
      const response = await fetchWithAuth(`/remediation-suggestions?${params.toString()}`);
      if (!response.ok) throw new Error(t('longTail.remediation.RemediationSuggestionsPanel.errors.loadFailed'));
      const json = await response.json();
      setSuggestions(Array.isArray(json?.data) ? json.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.remediation.RemediationSuggestionsPanel.errors.loadFailed'));
    } finally {
      const [mem, researchLoaded] = await Promise.all([loadMemory, loadResearch]);
      setMemory({
        proven: Array.isArray(mem?.proven) ? mem.proven : [],
        similar: Array.isArray(mem?.similar) ? mem.similar : [],
      });
      // Only a non-null read overwrites the research state: a failed read never erases what is on screen.
      research.applyLoaded(researchLoaded as ResearchStatusDto | null);
      setLoading(false);
    }
  }, [sourceId, sourceType]);
  fetchSuggestionsRef.current = fetchSuggestions;

  useEffect(() => {
    void fetchSuggestions();
  }, [fetchSuggestions]);

  const remediationSuggestionsDisabled = mlFlags.isDisabled('ml.remediation_suggestions.enabled');

  async function generateSuggestions() {
    if (remediationSuggestionsDisabled) return;
    setGenerating(true);
    research.clearDenial();
    try {
      const body = {
        sourceType,
        sourceId,
        limit: 3,
        ...(orgId ? { orgId } : {}),
        ...(deviceId ? { deviceId } : {}),
      };
      const result = await runAction<{ data?: RemediationSuggestion[]; skipped?: boolean; research?: ResearchOutcome | null }>({
        request: () => fetchWithAuth('/remediation-suggestions/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        errorFallback: t('longTail.remediation.RemediationSuggestionsPanel.errors.generateFailed'),
        successMessage: (data) => data.skipped
          ? t('longTail.remediation.RemediationSuggestionsPanel.messages.disabled')
          : t('longTail.remediation.RemediationSuggestionsPanel.messages.generated'),
      });
      setSuggestions(Array.isArray(result.data) ? result.data : []);
      research.noteOutcome(result.research);
      // The response already carries the list; only memory needs a re-read (Generate may have attached rows).
      void fetchSuggestions(true, false);
    } catch (err) {
      handleActionError(err, t('longTail.remediation.RemediationSuggestionsPanel.errors.generateFailed'));
    } finally {
      setGenerating(false);
    }
  }

  async function requestResearch(depth: 'quick' | 'deep') {
    if (remediationSuggestionsDisabled) return;
    setResearchBusy(true);
    research.clearDenial();
    try {
      const result = await runAction<{ data?: ResearchOutcome }>({
        request: () => fetchWithAuth('/remediation-suggestions/research', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceType, sourceId, depth, ...(orgId ? { orgId } : {}) }),
        }),
        errorFallback: t('longTail.remediation.RemediationSuggestionsPanel.errors.researchFailed'),
      });
      research.noteOutcome(result.data);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (err instanceof ActionError) {
        // runAction already toasted; the panel keeps the reason on screen too.
        if (err.code) research.denyFromError(err.code, err.message);
        return;
      }
      showToast({ type: 'error', message: t('longTail.remediation.RemediationSuggestionsPanel.errors.researchFailed') });
    } finally {
      setResearchBusy(false);
    }
  }

  async function updateSuggestion(suggestion: RemediationSuggestion, status: 'accepted' | 'edited' | 'rejected') {
    setUpdatingId(suggestion.id);
    try {
      const result = await runAction<{ data?: RemediationSuggestion }>({
        request: () => fetchWithAuth(`/remediation-suggestions/${suggestion.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        }),
        errorFallback: t('longTail.remediation.RemediationSuggestionsPanel.errors.updateFailed'),
        successMessage: status === 'accepted'
          ? t('longTail.remediation.RemediationSuggestionsPanel.messages.accepted')
          : status === 'edited'
            ? t('longTail.remediation.RemediationSuggestionsPanel.messages.markedEdited')
            : t('longTail.remediation.RemediationSuggestionsPanel.messages.rejected'),
      });
      if (result.data) {
        setSuggestions((current) => current.map((item) => item.id === suggestion.id ? result.data! : item));
      }
    } catch (err) {
      handleActionError(err, t('longTail.remediation.RemediationSuggestionsPanel.errors.updateFailed'));
    } finally {
      setUpdatingId(null);
    }
  }

  function beginEdit(suggestion: RemediationSuggestion) {
    setEditingId(suggestion.id);
    setEditDraft({
      title: suggestion.title,
      rationale: suggestion.rationale,
      expectedAction: suggestion.expectedAction,
      riskTier: suggestion.riskTier,
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft(null);
  }

  async function saveEditedSuggestion(suggestion: RemediationSuggestion) {
    if (!editDraft) return;
    const title = editDraft.title.trim();
    const rationale = editDraft.rationale.trim();
    const expectedAction = editDraft.expectedAction.trim();
    if (!title || !rationale || !expectedAction) return;

    setUpdatingId(suggestion.id);
    try {
      const result = await runAction<{ data?: RemediationSuggestion }>({
        request: () => fetchWithAuth(`/remediation-suggestions/${suggestion.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'edited',
            title,
            rationale,
            expectedAction,
            riskTier: editDraft.riskTier,
          }),
        }),
        errorFallback: t('longTail.remediation.RemediationSuggestionsPanel.errors.updateFailed'),
        successMessage: t('longTail.remediation.RemediationSuggestionsPanel.messages.updated'),
      });
      if (result.data) {
        setSuggestions((current) => current.map((item) => item.id === suggestion.id ? result.data! : item));
      }
      cancelEdit();
    } catch (err) {
      handleActionError(err, t('longTail.remediation.RemediationSuggestionsPanel.errors.updateFailed'));
    } finally {
      setUpdatingId(null);
    }
  }

  async function executeSuggestion(suggestion: RemediationSuggestion) {
    if (!canExecuteSuggestion(suggestion)) return;

    setExecutingId(suggestion.id);
    try {
      const result = await runAction<{ data?: RemediationSuggestion }>({
        request: () => fetchWithAuth(`/remediation-suggestions/${suggestion.id}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
        errorFallback: t('longTail.remediation.RemediationSuggestionsPanel.errors.executeFailed'),
        successMessage: t('longTail.remediation.RemediationSuggestionsPanel.messages.scriptQueued'),
      });
      if (result.data) {
        setSuggestions((current) => current.map((item) => item.id === suggestion.id ? result.data! : item));
      }
    } catch (err) {
      handleActionError(err, t('longTail.remediation.RemediationSuggestionsPanel.errors.executeFailed'));
    } finally {
      setExecutingId(null);
    }
  }

  function applyOutcome(id: string, outcome: SuggestionOutcome | undefined) {
    if (!outcome) return;
    setSuggestions((current) => current.map((item) => (item.id === id ? { ...item, outcome } : item)));
  }

  async function voteOnSuggestion(suggestion: RemediationSuggestion, vote: 'up' | 'down') {
    setVotingId(suggestion.id);
    try {
      const result = await runAction<{ data?: { outcome?: SuggestionOutcome } }>({
        request: () => fetchWithAuth(`/remediation-suggestions/${suggestion.id}/vote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vote }),
        }),
        errorFallback: t('longTail.remediation.RemediationSuggestionsPanel.feedback.failed'),
        successMessage: t('longTail.remediation.RemediationSuggestionsPanel.feedback.recorded'),
      });
      applyOutcome(suggestion.id, result.data?.outcome);
    } catch (err) {
      handleActionError(err, t('longTail.remediation.RemediationSuggestionsPanel.feedback.failed'));
    } finally {
      setVotingId(null);
    }
  }

  async function markDone(suggestion: RemediationSuggestion) {
    if (!canMarkDone(suggestion)) return;
    setMarkingDoneId(suggestion.id);
    try {
      const result = await runAction<{ data?: { outcome?: SuggestionOutcome } }>({
        request: () => fetchWithAuth(`/remediation-suggestions/${suggestion.id}/done`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reviewedChoice[suggestion.id] ? { instructionsId: reviewedChoice[suggestion.id] } : {}),
        }),
        errorFallback: t('longTail.remediation.RemediationSuggestionsPanel.done.failed'),
        successMessage: t('longTail.remediation.RemediationSuggestionsPanel.done.recorded'),
      });
      applyOutcome(suggestion.id, result.data?.outcome);
    } catch (err) {
      handleActionError(err, t('longTail.remediation.RemediationSuggestionsPanel.done.failed'));
    } finally {
      setMarkingDoneId(null);
    }
  }

  const loadReviewed = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/fix-memory/instructions');
      const json = response.ok ? await response.json() : null;
      setReviewed(Array.isArray(json?.data) ? json.data : []);
    } catch {
      setReviewed([]);
    }
  }, []);

  const needsReviewedList = suggestions.some(canMarkDone);
  useEffect(() => {
    if (needsReviewedList && reviewed === null) void loadReviewed();
  }, [needsReviewedList, reviewed, loadReviewed]);

  async function saveReviewedSteps(suggestion: RemediationSuggestion) {
    if (!savingReviewed || savingReviewed.id !== suggestion.id) return;
    const title = savingReviewed.title.trim();
    const steps = savingReviewed.steps.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!title || steps.length === 0) return;
    setSavingReviewedBusy(true);
    try {
      const result = await runAction<{ data?: ReviewedInstructions }>({
        request: () => fetchWithAuth('/fix-memory/instructions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, steps, osType: null, fromSuggestionId: suggestion.id }),
        }),
        errorFallback: t('longTail.remediation.RemediationSuggestionsPanel.reviewed.failed'),
        successMessage: t('longTail.remediation.RemediationSuggestionsPanel.reviewed.saved'),
      });
      if (result.data) {
        const saved = result.data;
        setReviewed((current) => [saved, ...(current ?? [])]);
        setReviewedChoice((current) => ({ ...current, [suggestion.id]: saved.id }));
      }
      setSavingReviewed(null);
    } catch (err) {
      handleActionError(err, t('longTail.remediation.RemediationSuggestionsPanel.reviewed.failed'));
    } finally {
      setSavingReviewedBusy(false);
    }
  }

  async function requestApproval(suggestion: RemediationSuggestion) {
    if (!canQueueSuggestion(suggestion) || !requiresExecutionApproval(suggestion) || suggestion.elevationRequestId) return;

    setRequestingApprovalId(suggestion.id);
    try {
      const result = await runAction<{
        data?: RemediationSuggestion;
        elevationRequest?: { id: string; status: string; expiresAt: string | null };
      }>({
        request: () => fetchWithAuth(`/remediation-suggestions/${suggestion.id}/elevation-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
        errorFallback: t('longTail.remediation.RemediationSuggestionsPanel.errors.approvalFailed'),
        successMessage: t('longTail.remediation.RemediationSuggestionsPanel.messages.approvalRequested'),
      });
      if (result.data) {
        setSuggestions((current) => current.map((item) => item.id === suggestion.id ? result.data! : item));
      }
      if (result.elevationRequest?.status) {
        setApprovalStatuses((current) => ({
          ...current,
          [suggestion.id]: result.elevationRequest!.status,
        }));
      }
    } catch (err) {
      handleActionError(err, t('longTail.remediation.RemediationSuggestionsPanel.errors.approvalFailed'));
    } finally {
      setRequestingApprovalId(null);
    }
  }

  const renderSuggestion = (suggestion: RemediationSuggestion) => (
    <SuggestionRow
      key={suggestion.id}
      suggestion={suggestion}
      approvalStatus={approvalStatuses[suggestion.id]}
      editDraft={editingId === suggestion.id ? editDraft : null}
      setEditDraft={setEditDraft}
      busy={{ updatingId, executingId, requestingApprovalId, votingId, markingDoneId }}
      reviewed={reviewed}
      reviewedChoice={reviewedChoice[suggestion.id] ?? ''}
      onReviewedChoice={(value) => setReviewedChoice((current) => ({ ...current, [suggestion.id]: value }))}
      savingReviewed={savingReviewed?.id === suggestion.id ? savingReviewed : null}
      setSavingReviewed={setSavingReviewed}
      savingReviewedBusy={savingReviewedBusy}
      canManagePartnerWide={canManagePartnerWide}
      onUpdate={updateSuggestion}
      onBeginEdit={beginEdit}
      onCancelEdit={cancelEdit}
      onSaveEdit={saveEditedSuggestion}
      onExecute={executeSuggestion}
      onVote={voteOnSuggestion}
      onMarkDone={markDone}
      onRequestApproval={requestApproval}
      onSaveReviewed={saveReviewedSteps}
    />
  );

  const renderRecord = (record: TrackRecordLite, muted: boolean) => {
    const text = trackRecordText(record);
    const name = record.scriptName ?? record.instructionsTitle ?? record.builtinAction ?? record.fixKind;
    return (
      <div key={record.memoryId} data-testid={`suggestion-record-${record.memoryId}`} className={`rounded-md border p-3 ${muted ? 'opacity-70' : ''}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{name}</span>
          <span className="text-xs text-muted-foreground">
            {text.scope === 'this_client'
              ? t('longTail.remediation.RemediationSuggestionsPanel.proven.trackThisClient', { verified: record.verified, attempts: record.attempts })
              : t('longTail.remediation.RemediationSuggestionsPanel.proven.trackAllClients', { verified: record.verified, attempts: record.attempts })}
          </span>
          <span className="text-xs text-muted-foreground">
            {text.lastVerifiedDays === null
              ? t('longTail.remediation.RemediationSuggestionsPanel.track.neverVerified')
              : t('longTail.remediation.RemediationSuggestionsPanel.track.lastVerified', { days: text.lastVerifiedDays })}
          </span>
        </div>
      </div>
    );
  };

  const groups = groupSuggestions(suggestions, memory);
  const panelState = researchPanelState(research.status, research.denial);
  const everyGroupEmpty = groups.proven.length === 0 && groups.provenRecordsOnly.length === 0 && groups.ai.length === 0
    && groups.similar.length === 0 && groups.legacy.length === 0;

  const section = (id: string, heading: string, children: ReactNode) => (
    <section data-testid={`suggestions-group-${id}`} className="mt-3 space-y-2">
      <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{heading}</h5>
      {children}
    </section>
  );

  if (loading) {
    return (
      <div className="mt-4 rounded-md border border-dashed p-4">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-md border border-dashed p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold">{t('longTail.remediation.RemediationSuggestionsPanel.title')}</h4>
        </div>
        <button
          type="button"
          onClick={() => { research.restartPolling(); void fetchSuggestions(); }}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground"
          title={t('longTail.remediation.RemediationSuggestionsPanel.refresh')}
          aria-label={t('longTail.remediation.RemediationSuggestionsPanel.refresh')}
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3">
        <ResearchControls
          state={panelState}
          disabled={remediationSuggestionsDisabled}
          disabledTitle={t('longTail.remediation.RemediationSuggestionsPanel.disabledTitle')}
          generateLabel={remediationSuggestionsDisabled ? t('longTail.remediation.RemediationSuggestionsPanel.suggestionsDisabled') : t('longTail.remediation.RemediationSuggestionsPanel.generate')}
          busy={generating || researchBusy}
          stalled={research.stalled}
          onRefresh={() => { research.restartPolling(); void fetchSuggestions(true); }}
          onGenerate={() => void generateSuggestions()}
          onResearchDeeper={() => void requestResearch('deep')}
          onRetry={() => void requestResearch(research.status?.depth ?? 'quick')}
        />
      </div>

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      {everyGroupEmpty && (panelState.kind === 'idle' || panelState.kind === 'done') && (
        <div data-testid="suggestions-empty" className="mt-3 text-sm text-muted-foreground">
          <p>{t('longTail.remediation.RemediationSuggestionsPanel.empty')}</p>
          <p>{t('longTail.remediation.RemediationSuggestionsPanel.emptyHint')}</p>
        </div>
      )}

      {(groups.proven.length > 0 || groups.provenRecordsOnly.length > 0) && section('proven', t('longTail.remediation.RemediationSuggestionsPanel.groups.proven'), (
        <>
          {groups.proven.map(renderSuggestion)}
          {groups.provenRecordsOnly.map((record) => renderRecord(record, false))}
        </>
      ))}
      {groups.ai.length > 0 && section('ai', t('longTail.remediation.RemediationSuggestionsPanel.groups.ai'), groups.ai.map(renderSuggestion))}
      {groups.similar.length > 0 && section('similar', t('longTail.remediation.RemediationSuggestionsPanel.groups.similar'), groups.similar.map((record) => renderRecord(record, true)))}
      {groups.legacy.length > 0 && (
        <details data-testid="suggestions-group-legacy" className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('longTail.remediation.RemediationSuggestionsPanel.groups.legacy')}</summary>
          <div className="mt-2 space-y-2">{groups.legacy.map(renderSuggestion)}</div>
        </details>
      )}
    </div>
  );
}
