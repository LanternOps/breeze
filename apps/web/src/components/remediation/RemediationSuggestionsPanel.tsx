import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCheck, CheckCircle, PencilLine, PlayCircle, RefreshCw, ShieldAlert, ShieldCheck, Sparkles, ThumbsDown, ThumbsUp, XCircle } from 'lucide-react';

import { ActionError, handleActionError, runAction } from '../../lib/runAction';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { useMlFeatureFlags } from '../../hooks/useMlFeatureFlags';
import ResearchControls from './ResearchControls';
import {
  groupSuggestions,
  isActiveResearch,
  researchPanelState,
  trackRecordText,
  type ResearchStatusDto,
  type TrackRecordLite,
} from './suggestionGroups';

type SuggestionStatus = 'suggested' | 'accepted' | 'edited' | 'rejected' | 'executed' | 'failed';

type OutcomeState = 'pending' | 'awaiting_recovery' | 'holding' | 'verified' | 'failed' | 'recurred' | 'inconclusive' | 'cancelled';
type SuggestionOutcome = { state: OutcomeState; stateReason: string | null; humanVote: 'up' | 'down' | null };

type RemediationSuggestion = {
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

const RESEARCH_POLL_MS = 4_000;
const RESEARCH_POLL_CAP_MS = 5 * 60_000;

type ResearchOutcome =
  | { status: 'started' | 'already_running' | 'already_done'; runId: string; depth: 'quick' | 'deep' }
  | { status: 'denied'; code: string; message: string };

type ReviewedInstructions = { id: string; title: string; steps: string[]; osType: string | null };

// Denial codes whose API message is a raw skip reason rather than copy a technician can act on.
const FRIENDLY_DENIALS: Record<string, string> = {
  compute_credits_exhausted: `longTail.remediation.RemediationSuggestionsPanel.research.denial.credits`,
  agent_daily_budget_exceeded: `longTail.remediation.RemediationSuggestionsPanel.research.denial.dailyBudget`,
  org_budget_exceeded: `longTail.remediation.RemediationSuggestionsPanel.research.denial.orgBudget`,
  auto_cap: `longTail.remediation.RemediationSuggestionsPanel.research.denial.autoCap`,
  research_auto_cap: `longTail.remediation.RemediationSuggestionsPanel.research.denial.autoCap`,
  max_concurrent_research_runs: `longTail.remediation.RemediationSuggestionsPanel.research.denial.busy`,
  research_rate: `longTail.remediation.RemediationSuggestionsPanel.research.denial.busy`,
  permission: `longTail.remediation.RemediationSuggestionsPanel.research.denial.permission`,
  research_unavailable: `longTail.remediation.RemediationSuggestionsPanel.research.denial.unavailable`,
  model_unavailable: `longTail.remediation.RemediationSuggestionsPanel.research.denial.modelUnavailable`,
  research_baseline_not_system_provisioned: `longTail.remediation.RemediationSuggestionsPanel.research.denial.notProvisioned`,
};

function denialMessage(code: string, apiMessage: string, t: (key: string) => string): string {
  const key = FRIENDLY_DENIALS[code];
  return key ? t(/* i18n-dynamic */ key) : apiMessage;
}

const OUTCOME_STATE_KEYS: Record<OutcomeState, string> = {
  pending: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.pending',
  awaiting_recovery: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.awaitingRecovery',
  holding: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.holding',
  verified: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.verified',
  failed: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.failed',
  recurred: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.recurred',
  inconclusive: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.inconclusive',
  cancelled: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.cancelled',
};

function canMarkDone(s: RemediationSuggestion): boolean {
  return s.targetType === 'manual_steps' && (s.status === 'accepted' || s.status === 'edited') && !s.outcome;
}

type RemediationSuggestionsPanelProps = {
  sourceType: 'alert' | 'anomaly' | 'correlation' | 'rca';
  sourceId: string;
  orgId?: string;
  deviceId?: string;
};

type EditDraft = Pick<RemediationSuggestion, 'title' | 'rationale' | 'expectedAction' | 'riskTier'>;

const riskClasses: Record<RemediationSuggestion['riskTier'], string> = {
  low: 'border-success/30 bg-success/10 text-success',
  medium: 'border-warning/30 bg-warning/10 text-warning',
  high: 'border-destructive/40 bg-destructive/10 text-destructive',
  critical: 'border-destructive bg-destructive/15 text-destructive',
};

function targetLabel(suggestion: RemediationSuggestion, t: (key: string) => string): string {
  if (suggestion.targetType === 'builtin_action') return t('longTail.remediation.RemediationSuggestionsPanel.targets.builtin');
  if (suggestion.targetType === 'manual_steps') return t('longTail.remediation.RemediationSuggestionsPanel.targets.manualSteps');
  if (suggestion.targetType === 'script_draft') return t('longTail.remediation.RemediationSuggestionsPanel.targets.scriptDraft');
  if (suggestion.targetType === 'script') return t('longTail.remediation.RemediationSuggestionsPanel.targets.script');
  if (suggestion.targetType === 'script_template') return t('longTail.remediation.RemediationSuggestionsPanel.targets.template');
  if (suggestion.targetType === 'playbook') return t('longTail.remediation.RemediationSuggestionsPanel.targets.playbook');
  return t('longTail.remediation.RemediationSuggestionsPanel.targets.diagnostic');
}

function targetIdentifier(suggestion: RemediationSuggestion, t: (key: string, options?: Record<string, unknown>) => string): string {
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

function targetDeviceLabel(suggestion: RemediationSuggestion, t: (key: string, options?: Record<string, unknown>) => string): string {
  const ids = suggestion.targetDeviceIds.length > 0
    ? suggestion.targetDeviceIds
    : suggestion.deviceId
      ? [suggestion.deviceId]
      : [];

  if (ids.length === 0) return t('longTail.remediation.RemediationSuggestionsPanel.targetDevices.none');
  if (ids.length === 1) return t('longTail.remediation.RemediationSuggestionsPanel.targetDevices.one', { id: ids[0] });
  return t('longTail.remediation.RemediationSuggestionsPanel.targetDevices.many', { count: ids.length, ids: ids.join(', ') });
}

function parametersPreview(suggestion: RemediationSuggestion): string | null {
  if (!suggestion.parameters || Object.keys(suggestion.parameters).length === 0) return null;
  return JSON.stringify(suggestion.parameters, null, 2);
}

function singleTargetDeviceId(suggestion: RemediationSuggestion): string | null {
  if (suggestion.targetDeviceIds.length === 1) return suggestion.targetDeviceIds[0] ?? null;
  if (suggestion.targetDeviceIds.length === 0) return suggestion.deviceId;
  return null;
}

function canQueueSuggestion(suggestion: RemediationSuggestion): boolean {
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

function requiresExecutionApproval(suggestion: RemediationSuggestion): boolean {
  return suggestion.riskTier === 'high' || suggestion.riskTier === 'critical';
}

function canExecuteSuggestion(suggestion: RemediationSuggestion): boolean {
  return canQueueSuggestion(suggestion) && (!requiresExecutionApproval(suggestion) || Boolean(suggestion.elevationRequestId));
}

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
  const [researchStatus, setResearchStatus] = useState<ResearchStatusDto | null>(null);
  const [denial, setDenial] = useState<{ code: string; message: string } | null>(null);
  const [researchBusy, setResearchBusy] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [reviewed, setReviewed] = useState<ReviewedInstructions[] | null>(null);
  const [reviewedChoice, setReviewedChoice] = useState<Record<string, string>>({});
  const [savingReviewed, setSavingReviewed] = useState<{ id: string; title: string; steps: string } | null>(null);
  const [savingReviewedBusy, setSavingReviewedBusy] = useState(false);
  const canManagePartnerWide = useAuthStore((state) => state.user?.canManagePartnerWide);
  const sourceQuery = new URLSearchParams({ sourceType, sourceId, ...(orgId ? { orgId } : {}) }).toString();
  const sourceQueryRef = useRef(sourceQuery);
  sourceQueryRef.current = sourceQuery;

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
      const [mem, research] = await Promise.all([loadMemory, loadResearch]);
      setMemory({
        proven: Array.isArray(mem?.proven) ? mem.proven : [],
        similar: Array.isArray(mem?.similar) ? mem.similar : [],
      });
      // A side-only refresh must not clobber the run Generate just started with a stale null.
      if (research || includeList) setResearchStatus((research as ResearchStatusDto | null) ?? null);
      setLoading(false);
    }
  }, [sourceId, sourceType]);

  useEffect(() => {
    void fetchSuggestions();
  }, [fetchSuggestions]);

  // Poll an active research run every 4s; stop on a terminal status or after 5 minutes.
  const activeRun = isActiveResearch(researchStatus?.status);
  useEffect(() => {
    if (!activeRun) {
      setStalled(false);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt >= RESEARCH_POLL_CAP_MS) {
        clearInterval(timer);
        setStalled(true);
        return;
      }
      void fetchWithAuth(`/remediation-suggestions/research?${sourceQueryRef.current}`)
        .then(async (r) => (r.ok ? (await r.json())?.data as ResearchStatusDto | null : null))
        .then((next) => {
          if (!next) return;
          setResearchStatus(next);
          if (!isActiveResearch(next.status)) void fetchSuggestions(true);
        })
        .catch(() => undefined);
    }, RESEARCH_POLL_MS);
    return () => clearInterval(timer);
  }, [activeRun, fetchSuggestions]);

  const remediationSuggestionsDisabled = mlFlags.isDisabled('ml.remediation_suggestions.enabled');

  function noteResearchOutcome(research: ResearchOutcome | null | undefined) {
    if (!research) return;
    if (research.status === 'denied') {
      setDenial({ code: research.code, message: denialMessage(research.code, research.message, t) });
      return;
    }
    if (research.status === 'started' || research.status === 'already_running') {
      setResearchStatus({ runId: research.runId, depth: research.depth, status: 'queued', errorCode: null, noSafeFix: false, finishedAt: null });
    }
  }

  async function generateSuggestions() {
    if (remediationSuggestionsDisabled) return;
    setGenerating(true);
    setDenial(null);
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
      noteResearchOutcome(result.research);
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
    setDenial(null);
    try {
      const result = await runAction<{ data?: ResearchOutcome }>({
        request: () => fetchWithAuth('/remediation-suggestions/research', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceType, sourceId, depth, ...(orgId ? { orgId } : {}) }),
        }),
        errorFallback: t('longTail.remediation.RemediationSuggestionsPanel.errors.researchFailed'),
      });
      noteResearchOutcome(result.data);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (err instanceof ActionError) {
        // runAction already toasted; the panel keeps the reason on screen too.
        if (err.code) setDenial({ code: err.code, message: denialMessage(err.code, err.message, t) });
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

  function provenTrack(s: RemediationSuggestion): string | null {
    const e = s.evidence ?? {};
    const verified = typeof e.verifiedCount === 'number' ? e.verifiedCount : null;
    const attempts = typeof e.attempts === 'number' ? e.attempts : null;
    if (verified === null || attempts === null) return null;
    return e.scope === 'this_client'
      ? t('longTail.remediation.RemediationSuggestionsPanel.proven.trackThisClient', { verified, attempts })
      : t('longTail.remediation.RemediationSuggestionsPanel.proven.trackAllClients', { verified, attempts });
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

  const renderSuggestion = (suggestion: RemediationSuggestion) => {
            const approvalStatus = approvalStatuses[suggestion.id];
            const approvalPending = requiresExecutionApproval(suggestion) && suggestion.elevationRequestId && approvalStatus === 'pending';
            const editing = editingId === suggestion.id && editDraft;
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
                        disabled={updatingId === suggestion.id || !editDraft.title.trim() || !editDraft.rationale.trim() || !editDraft.expectedAction.trim()}
                        onClick={() => void saveEditedSuggestion(suggestion)}
                        className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <CheckCircle className="h-4 w-4" />
                        {t('longTail.remediation.RemediationSuggestionsPanel.saveEdits')}
                      </button>
                      <button
                        type="button"
                        disabled={updatingId === suggestion.id}
                        onClick={cancelEdit}
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
                          {provenTrack(suggestion) && <span className="font-normal">· {provenTrack(suggestion)}</span>}
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
                      disabled={updatingId === suggestion.id || executingId === suggestion.id || suggestion.status === 'accepted'}
                      onClick={() => void updateSuggestion(suggestion, 'accepted')}
                      className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <CheckCircle className="h-4 w-4" />
                      {t('longTail.remediation.RemediationSuggestionsPanel.accept')}
                    </button>
                    <button
                      type="button"
                      disabled={
                        updatingId === suggestion.id ||
                        executingId === suggestion.id ||
                        suggestion.status === 'rejected' ||
                        suggestion.status === 'executed' ||
                        suggestion.status === 'failed'
                      }
                      onClick={() => beginEdit(suggestion)}
                      className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <PencilLine className="h-4 w-4" />
                      {t('common:actions.edit')}
                    </button>
                    <button
                      type="button"
                      disabled={updatingId === suggestion.id || executingId === suggestion.id || suggestion.status === 'rejected'}
                      onClick={() => void updateSuggestion(suggestion, 'rejected')}
                      className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <XCircle className="h-4 w-4" />
                      {t('longTail.remediation.RemediationSuggestionsPanel.reject')}
                    </button>
                    {canExecuteSuggestion(suggestion) && !approvalPending && (
                      <button
                        type="button"
                        disabled={executingId === suggestion.id || requestingApprovalId === suggestion.id}
                        onClick={() => void executeSuggestion(suggestion)}
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
                          disabled={votingId === suggestion.id}
                          onClick={() => void voteOnSuggestion(suggestion, 'up')}
                          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 aria-pressed:bg-muted"
                          data-testid="remediation-vote-up"
                        >
                          <ThumbsUp className="h-4 w-4" />
                          {t('longTail.remediation.RemediationSuggestionsPanel.feedback.worked')}
                        </button>
                        <button
                          type="button"
                          aria-pressed={suggestion.outcome.humanVote === 'down'}
                          disabled={votingId === suggestion.id}
                          onClick={() => void voteOnSuggestion(suggestion, 'down')}
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
                          value={reviewedChoice[suggestion.id] ?? ''}
                          onChange={(event) => { const value = event.currentTarget.value; setReviewedChoice((current) => ({ ...current, [suggestion.id]: value })); }}
                          aria-label={t('longTail.remediation.RemediationSuggestionsPanel.reviewed.pickerLabel')}
                          className="rounded-md border bg-background px-2 py-1.5 text-sm"
                        >
                          <option value="">{t('longTail.remediation.RemediationSuggestionsPanel.reviewed.asWritten')}</option>
                          {(reviewed ?? []).map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
                        </select>
                        <button
                          type="button"
                          disabled={markingDoneId === suggestion.id}
                          onClick={() => void markDone(suggestion)}
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
                      // Seam for Task 20 part 2: the hand-off handler is wired there.
                      <button
                        type="button"
                        disabled
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
                        disabled={requestingApprovalId === suggestion.id || updatingId === suggestion.id || executingId === suggestion.id}
                        onClick={() => void requestApproval(suggestion)}
                        title={t('longTail.remediation.RemediationSuggestionsPanel.requestApprovalTitle')}
                        className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <ShieldAlert className="h-4 w-4" />
                        {requestingApprovalId === suggestion.id
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
                {savingReviewed?.id === suggestion.id && (
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
                        onClick={() => void saveReviewedSteps(suggestion)}
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
  };

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
  const panelState = researchPanelState(researchStatus, denial);
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
          onClick={() => void fetchSuggestions()}
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
          stalled={stalled}
          onGenerate={() => void generateSuggestions()}
          onResearchDeeper={() => void requestResearch('deep')}
          onRetry={() => void requestResearch(researchStatus?.depth ?? 'quick')}
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
