import { useCallback, useEffect, useState } from 'react';
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

function targetLabel(suggestion: RemediationSuggestion): string {
  if (suggestion.targetType === 'script') return 'Script';
  if (suggestion.targetType === 'script_template') return 'Template';
  if (suggestion.targetType === 'playbook') return 'Playbook';
  return 'Diagnostic';
}

function targetIdentifier(suggestion: RemediationSuggestion): string {
  if (suggestion.targetType === 'script') return suggestion.scriptId ? `script ${suggestion.scriptId}` : 'script without a script ID';
  if (suggestion.targetType === 'script_template') {
    return suggestion.scriptTemplateId ? `template ${suggestion.scriptTemplateId}` : 'template without a template ID';
  }
  if (suggestion.targetType === 'playbook') return suggestion.playbookId ? `playbook ${suggestion.playbookId}` : 'playbook without a playbook ID';
  return 'diagnostic action';
}

function targetDeviceLabel(suggestion: RemediationSuggestion): string {
  const ids = suggestion.targetDeviceIds.length > 0
    ? suggestion.targetDeviceIds
    : suggestion.deviceId
      ? [suggestion.deviceId]
      : [];

  if (ids.length === 0) return 'No target device in this suggestion';
  if (ids.length === 1) return `device ${ids[0]}`;
  return `${ids.length} devices: ${ids.join(', ')}`;
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
      if (!response.ok) throw new Error('Failed to load suggested fixes');
      const json = await response.json();
      setSuggestions(Array.isArray(json?.data) ? json.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load suggested fixes');
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
        errorFallback: 'Could not generate suggested fixes',
        successMessage: (data) => data.skipped ? 'Suggested fixes are disabled' : 'Suggested fixes generated',
      });
      setSuggestions(Array.isArray(result.data) ? result.data : []);
    } catch (err) {
      handleActionError(err, 'Could not generate suggested fixes');
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
        errorFallback: 'Could not update suggested fix',
        successMessage: status === 'accepted'
          ? 'Suggested fix accepted'
          : status === 'edited'
            ? 'Suggested fix marked edited'
            : 'Suggested fix rejected',
      });
      if (result.data) {
        setSuggestions((current) => current.map((item) => item.id === suggestion.id ? result.data! : item));
      }
    } catch (err) {
      handleActionError(err, 'Could not update suggested fix');
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
        errorFallback: 'Could not update suggested fix',
        successMessage: 'Suggested fix updated',
      });
      if (result.data) {
        setSuggestions((current) => current.map((item) => item.id === suggestion.id ? result.data! : item));
      }
      cancelEdit();
    } catch (err) {
      handleActionError(err, 'Could not update suggested fix');
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
        errorFallback: 'Could not execute suggested fix',
        successMessage: 'Script queued and suggested fix updated',
      });
      if (result.data) {
        setSuggestions((current) => current.map((item) => item.id === suggestion.id ? result.data! : item));
      }
    } catch (err) {
      handleActionError(err, 'Could not execute suggested fix');
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
        errorFallback: 'Could not request approval',
        successMessage: 'Approval requested',
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
      handleActionError(err, 'Could not request approval');
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
          <h4 className="text-sm font-semibold">Suggested Fixes</h4>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void fetchSuggestions()}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Refresh suggested fixes"
            aria-label="Refresh suggested fixes"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={generating || remediationSuggestionsDisabled}
            onClick={() => void generateSuggestions()}
            title={remediationSuggestionsDisabled ? 'Suggested fixes are disabled for this organization' : undefined}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Sparkles className="h-4 w-4" />
            {remediationSuggestionsDisabled ? 'Suggestions disabled' : 'Generate'}
          </button>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      {suggestions.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No suggested fixes yet.</p>
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
                        Title
                        <input
                          value={editDraft.title}
                          onChange={(event) => setEditDraft({ ...editDraft, title: event.currentTarget.value })}
                          className="rounded-md border bg-background px-3 py-2 text-sm font-normal"
                        />
                      </label>
                      <label className="grid gap-1 text-sm font-medium">
                        Risk
                        <select
                          value={editDraft.riskTier}
                          onChange={(event) => setEditDraft({ ...editDraft, riskTier: event.currentTarget.value as RemediationSuggestion['riskTier'] })}
                          className="rounded-md border bg-background px-3 py-2 text-sm font-normal"
                        >
                          <option value="low">low</option>
                          <option value="medium">medium</option>
                          <option value="high">high</option>
                          <option value="critical">critical</option>
                        </select>
                      </label>
                    </div>
                    <label className="grid gap-1 text-sm font-medium">
                      Rationale
                      <textarea
                        value={editDraft.rationale}
                        onChange={(event) => setEditDraft({ ...editDraft, rationale: event.currentTarget.value })}
                        rows={3}
                        className="rounded-md border bg-background px-3 py-2 text-sm font-normal"
                      />
                    </label>
                    <label className="grid gap-1 text-sm font-medium">
                      Expected action
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
                        Save edits
                      </button>
                      <button
                        type="button"
                        disabled={updatingId === suggestion.id}
                        onClick={cancelEdit}
                        className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <XCircle className="h-4 w-4" />
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold">{suggestion.title}</span>
                        <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{targetLabel(suggestion)}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${riskClasses[suggestion.riskTier]}`}>
                          {suggestion.riskTier}
                        </span>
                        {suggestion.confidence != null && (
                          <span className="text-xs text-muted-foreground">{Math.round(suggestion.confidence * 100)}%</span>
                        )}
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">{suggestion.rationale}</p>
                      <p className="mt-2 text-sm">{suggestion.expectedAction}</p>
                      {suggestion.status !== 'suggested' && (
                        <p className="mt-2 text-xs font-medium text-muted-foreground">Status: {suggestion.status}</p>
                      )}
                      {executionPreview && (
                        <div className="mt-3 rounded-md border bg-muted/30 p-3">
                          <p className="text-xs font-semibold text-foreground">Execution preview</p>
                          <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                            <div className="min-w-0">
                              <dt className="font-medium text-muted-foreground">Will run</dt>
                              <dd className="break-words text-foreground">{targetLabel(suggestion)}: {targetIdentifier(suggestion)}</dd>
                            </div>
                            <div className="min-w-0">
                              <dt className="font-medium text-muted-foreground">Where</dt>
                              <dd className="break-words text-foreground">{targetDeviceLabel(suggestion)}</dd>
                            </div>
                            <div className="min-w-0">
                              <dt className="font-medium text-muted-foreground">Source</dt>
                              <dd className="break-words text-foreground">{suggestion.sourceType} {suggestion.sourceId}</dd>
                            </div>
                            <div className="min-w-0">
                              <dt className="font-medium text-muted-foreground">Risk</dt>
                              <dd className="break-words text-foreground">{suggestion.riskTier}</dd>
                            </div>
                            <div className="min-w-0 sm:col-span-2">
                              <dt className="font-medium text-muted-foreground">Why</dt>
                              <dd className="break-words text-foreground">{suggestion.rationale}</dd>
                            </div>
                            <div className="min-w-0 sm:col-span-2">
                              <dt className="font-medium text-muted-foreground">Expected action</dt>
                              <dd className="break-words text-foreground">{suggestion.expectedAction}</dd>
                            </div>
                          </dl>
                          {parameterJson && (
                            <div className="mt-2">
                              <p className="text-xs font-medium text-muted-foreground">Parameters</p>
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
                      Accept
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
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={updatingId === suggestion.id || executingId === suggestion.id || suggestion.status === 'rejected'}
                      onClick={() => void updateSuggestion(suggestion, 'rejected')}
                      className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <XCircle className="h-4 w-4" />
                      Reject
                    </button>
                    {canExecuteScriptSuggestion(suggestion) && !approvalPending && (
                      <button
                        type="button"
                        disabled={executingId === suggestion.id || requestingApprovalId === suggestion.id}
                        onClick={() => void executeSuggestion(suggestion)}
                        className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <PlayCircle className="h-4 w-4" />
                        Execute
                      </button>
                    )}
                    {canQueueScriptSuggestion(suggestion) && requiresExecutionApproval(suggestion) && !suggestion.elevationRequestId && (
                      <button
                        type="button"
                        disabled={requestingApprovalId === suggestion.id || updatingId === suggestion.id || executingId === suggestion.id}
                        onClick={() => void requestApproval(suggestion)}
                        title="Request PAM approval before execution"
                        className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <ShieldAlert className="h-4 w-4" />
                        {requestingApprovalId === suggestion.id ? 'Requesting...' : 'Request approval'}
                      </button>
                    )}
                    {approvalPending && (
                      <button
                        type="button"
                        disabled
                        title="Waiting for PAM approval"
                        className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium text-muted-foreground disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        <ShieldAlert className="h-4 w-4" />
                        Approval pending
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
