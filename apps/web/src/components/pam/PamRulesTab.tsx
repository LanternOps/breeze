import { useCallback, useEffect, useState } from 'react';
import { ListChecks, Plus } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';
import PamRuleModal from './PamRuleModal';
import { type PamRule, VERDICT_LABELS } from './types';

function ruleCriteriaSummary(rule: PamRule): string {
  const parts: string[] = [];
  if (rule.matchSigner) parts.push(`signer=${rule.matchSigner}`);
  if (rule.matchHash) parts.push(`hash=${rule.matchHash.slice(0, 12)}…`);
  if (rule.matchPathGlob) parts.push(`path=${rule.matchPathGlob}`);
  if (rule.matchParentImage) parts.push(`parent=${rule.matchParentImage}`);
  if (rule.matchUser) parts.push(`user=${rule.matchUser}`);
  if (rule.matchAdGroup) parts.push(`group=${rule.matchAdGroup}`);
  if (rule.matchToolName) parts.push(`tool=${rule.matchToolName}`);
  if (rule.matchRiskTier !== null && rule.matchRiskTier !== undefined)
    parts.push(`tier=${rule.matchRiskTier}`);
  if (rule.timeWindow) parts.push(`window=${rule.timeWindow.start}-${rule.timeWindow.end}`);
  return parts.join(' · ');
}

export default function PamRulesTab() {
  const [rules, setRules] = useState<PamRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PamRule | null>(null);
  const [creating, setCreating] = useState(false);

  const fetchRules = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/pam/rules', { signal });
      if (!res.ok) {
        if (res.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error(`Failed to load rules (HTTP ${res.status})`);
      }
      const body = await res.json();
      const list = ((body.rules ?? []) as PamRule[]).slice();
      list.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
      setRules(list);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Failed to load rules');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchRules(controller.signal);
    return () => controller.abort();
  }, [fetchRules]);

  const toggleEnabled = async (rule: PamRule) => {
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/pam/rules/${rule.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: !rule.enabled }),
          }),
        errorFallback: 'Failed to update rule',
        successMessage: `Rule "${rule.name}" ${rule.enabled ? 'disabled' : 'enabled'}`,
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      void fetchRules();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: 'Failed to update rule' });
      }
    }
  };

  const deleteRule = async (rule: PamRule) => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/pam/rules/${rule.id}`, { method: 'DELETE' }),
        errorFallback: 'Failed to delete rule',
        successMessage: `Rule "${rule.name}" deleted`,
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      void fetchRules();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: 'Failed to delete rule' });
      }
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Rules are evaluated in priority order (lowest first); the first match decides.
        </p>
        <button
          type="button"
          onClick={() => setCreating(true)}
          data-testid="pam-add-rule-btn"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          Add rule
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 rounded-md border bg-card px-4 py-6 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading rules…
        </div>
      ) : rules.length === 0 ? (
        <div className="rounded-md border border-dashed bg-card px-4 py-8 text-center">
          <ListChecks className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No PAM rules yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Without rules, every elevation request waits for a manual decision.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Priority</th>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Criteria</th>
                <th className="px-3 py-2 font-medium">Verdict</th>
                <th className="px-3 py-2 font-medium">Enabled</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b last:border-0" data-testid={`pam-rule-row-${rule.id}`}>
                  <td className="px-3 py-2 text-muted-foreground">{rule.priority}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{rule.name}</div>
                    {rule.description && (
                      <div className="mt-0.5 max-w-[240px] truncate text-xs text-muted-foreground" title={rule.description}>
                        {rule.description}
                      </div>
                    )}
                  </td>
                  <td className="max-w-[320px] truncate px-3 py-2 text-xs text-muted-foreground" title={ruleCriteriaSummary(rule)}>
                    {ruleCriteriaSummary(rule) || '—'}
                  </td>
                  <td className="px-3 py-2">{VERDICT_LABELS[rule.verdict]}</td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={rule.enabled}
                      onClick={() => void toggleEnabled(rule)}
                      data-testid={`pam-rule-toggle-${rule.id}`}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                        rule.enabled ? 'bg-green-500' : 'bg-muted'
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                          rule.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                        }`}
                      />
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setEditing(rule)}
                      data-testid={`pam-rule-edit-${rule.id}`}
                      className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteRule(rule)}
                      data-testid={`pam-rule-delete-${rule.id}`}
                      className="ml-1.5 rounded-md border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <PamRuleModal
          rule={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            void fetchRules();
          }}
        />
      )}
    </div>
  );
}
