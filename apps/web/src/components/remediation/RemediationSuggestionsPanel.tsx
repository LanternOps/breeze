import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, PencilLine, PlayCircle, RefreshCw, ShieldAlert, Sparkles, XCircle } from 'lucide-react';

import { handleActionError, runAction } from '../../lib/runAction';
import { fetchWithAuth } from '../../stores/auth';
import { useMlFeatureFlags } from '../../hooks/useMlFeatureFlags';

type SuggestionStatus = 'suggested' | 'accepted' | 'edited' | 'rejected' | 'executed' | 'failed';

type RemediationSuggestion = {
  id: string;
  sourceType: string;
  sourceId: string;
  deviceId: string | null;
  targetType: 'script' | 'script_template' | 'playbook' | 'diagnostic';
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
};

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
  if (suggestion.targetType === 'script') return t('longTail.remediation.RemediationSuggestionsPanel.targets.script');
  if (suggestion.targetType === 'script_template') return t('longTail.remediation.RemediationSuggestionsPanel.targets.template');
  if (suggestion.targetType === 'playbook') return t('longTail.remediation.RemediationSuggestionsPanel.targets.playbook');
  return t('longTail.remediation.RemediationSuggestionsPanel.targets.diagnostic');
}

function targetIdentifier(suggestion: RemediationSuggestion, t: (key: string, options?: Record<string, unknown>) => string): string {
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

function canQueueScriptSuggestion(suggestion: RemediationSuggestion): boolean {
  return (
    suggestion.targetType === 'script' &&
    Boolean(suggestion.scriptId) &&
    Boolean(singleTargetDeviceId(suggestion)) &&
    (suggestion.status === 'accepted' || suggestion.status === 'edited') &&
    !suggestion.scriptExecutionId
  );
}

function requiresExecutionApproval(suggestion: RemediationSuggestion): boolean {
  return suggestion.riskTier === 'high' || suggestion.riskTier === 'critical';
}

function canExecuteScriptSuggestion(suggestion: RemediationSuggestion): boolean {
  return canQueueScriptSuggestion(suggestion) && (!requiresExecutionApproval(suggestion) || Boolean(suggestion.elevationRequestId));
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

  const fetchSuggestions = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({ sourceType, sourceId, limit: '5' });
      const response = await fetchWithAuth(`/remediation-suggestions?${params.toString()}`);
      if (!response.ok) throw new Error(t('longTail.remediation.RemediationSuggestionsPanel.errors.loadFailed'));
      const json = await response.json();
      setSuggestions(Array.isArray(json?.data) ? json.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.remediation.RemediationSuggestionsPanel.errors.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [sourceId, sourceType]);

  useEffect(() => {
    void fetchSuggestions();
  }, [fetchSuggestions]);

  const remediationSuggestionsDisabled = mlFlags.isDisabled('ml.remediation_suggestions.enabled');

  async function generateSuggestions() {
    if (remediationSuggestionsDisabled) return;
    setGenerating(true);
    try {
      const body = {
        sourceType,
        sourceId,
        limit: 3,
        ...(orgId ? { orgId } : {}),
        ...(deviceId ? { deviceId } : {}),
      };
      const result = await runAction<{ data?: RemediationSuggestion[]; skipped?: boolean }>({
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
    } catch (err) {
      handleActionError(err, t('longTail.remediation.RemediationSuggestionsPanel.errors.generateFailed'));
    } finally {
      setGenerating(false);
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
    if (!canExecuteScriptSuggestion(suggestion)) return;

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

  async function requestApproval(suggestion: RemediationSuggestion) {
    if (!canQueueScriptSuggestion(suggestion) || !requiresExecutionApproval(suggestion) || suggestion.elevationRequestId) return;

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
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void fetchSuggestions()}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground"
            title={t('longTail.remediation.RemediationSuggestionsPanel.refresh')}
            aria-label={t('longTail.remediation.RemediationSuggestionsPanel.refresh')}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={generating || remediationSuggestionsDisabled}
            onClick={() => void generateSuggestions()}
            title={remediationSuggestionsDisabled ? t('longTail.remediation.RemediationSuggestionsPanel.disabledTitle') : undefined}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Sparkles className="h-4 w-4" />
            {remediationSuggestionsDisabled
              ? t('longTail.remediation.RemediationSuggestionsPanel.suggestionsDisabled')
              : t('longTail.remediation.RemediationSuggestionsPanel.generate')}
          </button>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      {suggestions.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('longTail.remediation.RemediationSuggestionsPanel.empty')}</p>
      ) : (
        <div className="mt-3 space-y-3">
          {suggestions.map((suggestion) => {
            const approvalStatus = approvalStatuses[suggestion.id];
            const approvalPending = requiresExecutionApproval(suggestion) && suggestion.elevationRequestId && approvalStatus === 'pending';
            const editing = editingId === suggestion.id && editDraft;
            const executionPreview = suggestion.status === 'accepted' || suggestion.status === 'edited';
            const parameterJson = parametersPreview(suggestion);
            return (
              <div key={suggestion.id} className="rounded-md border p-3">
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
                          {t(`longTail.remediation.RemediationSuggestionsPanel.risk.${suggestion.riskTier}`)}
                        </span>
                        {suggestion.confidence != null && (
                          <span className="text-xs text-muted-foreground">{Math.round(suggestion.confidence * 100)}%</span>
                        )}
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">{suggestion.rationale}</p>
                      <p className="mt-2 text-sm">{suggestion.expectedAction}</p>
                      {suggestion.status !== 'suggested' && (
                        <p className="mt-2 text-xs font-medium text-muted-foreground">
                          {t('longTail.remediation.RemediationSuggestionsPanel.statusLine', {
                            status: t(`longTail.remediation.RemediationSuggestionsPanel.status.${suggestion.status}`),
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
                              <dd className="wrap-break-word text-foreground">{t(`longTail.remediation.RemediationSuggestionsPanel.risk.${suggestion.riskTier}`)}</dd>
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
                    {canExecuteScriptSuggestion(suggestion) && !approvalPending && (
                      <button
                        type="button"
                        disabled={executingId === suggestion.id || requestingApprovalId === suggestion.id}
                        onClick={() => void executeSuggestion(suggestion)}
                        className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <PlayCircle className="h-4 w-4" />
                        {t('longTail.remediation.RemediationSuggestionsPanel.execute')}
                      </button>
                    )}
                    {canQueueScriptSuggestion(suggestion) && requiresExecutionApproval(suggestion) && !suggestion.elevationRequestId && (
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
