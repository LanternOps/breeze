import { useCallback, useEffect, useState } from 'react';
import { CheckCircle, PencilLine, PlayCircle, RefreshCw, Sparkles, XCircle } from 'lucide-react';

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
  scriptExecutionId: string | null;
};

type RemediationSuggestionsPanelProps = {
  sourceType: 'alert' | 'anomaly' | 'correlation' | 'rca';
  sourceId: string;
};

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

function singleTargetDeviceId(suggestion: RemediationSuggestion): string | null {
  if (suggestion.targetDeviceIds.length === 1) return suggestion.targetDeviceIds[0] ?? null;
  if (suggestion.targetDeviceIds.length === 0) return suggestion.deviceId;
  return null;
}

function canExecuteScriptSuggestion(suggestion: RemediationSuggestion): boolean {
  return (
    suggestion.targetType === 'script' &&
    Boolean(suggestion.scriptId) &&
    Boolean(singleTargetDeviceId(suggestion)) &&
    (suggestion.status === 'accepted' || suggestion.status === 'edited') &&
    !suggestion.scriptExecutionId
  );
}

export default function RemediationSuggestionsPanel({ sourceType, sourceId }: RemediationSuggestionsPanelProps) {
  const mlFlags = useMlFeatureFlags();
  const [suggestions, setSuggestions] = useState<RemediationSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
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
      const result = await runAction<{ data?: RemediationSuggestion[]; skipped?: boolean }>({
        request: () => fetchWithAuth('/remediation-suggestions/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceType, sourceId, limit: 3 }),
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
          {suggestions.map((suggestion) => (
            <div key={suggestion.id} className="rounded-md border p-3">
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
                      suggestion.status === 'edited' ||
                      suggestion.status === 'rejected' ||
                      suggestion.status === 'executed' ||
                      suggestion.status === 'failed'
                    }
                    onClick={() => void updateSuggestion(suggestion, 'edited')}
                    className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <PencilLine className="h-4 w-4" />
                    Mark edited
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
                  {canExecuteScriptSuggestion(suggestion) && (
                    <button
                      type="button"
                      disabled={executingId === suggestion.id}
                      onClick={() => void executeSuggestion(suggestion)}
                      className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <PlayCircle className="h-4 w-4" />
                      Execute
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
