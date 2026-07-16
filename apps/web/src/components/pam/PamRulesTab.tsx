import '@/lib/i18n';
import { useCallback, useEffect, useState } from 'react';
import { ListChecks, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import PamRuleModal from './PamRuleModal';
import { type PamRule, type PamUnmatchedVerdict, VERDICT_LABELS } from './types';
import {
  EmptyState,
  ErrorAlert,
  Switch,
  TableSkeleton,
  btnOutlineClass,
  btnOutlineDestructiveClass,
  btnPrimaryClass,
  selectClass,
  tableClass,
  tableWrapClass,
  tbodyClass,
  tdClass,
  thClass,
  theadClass,
  theadRowClass,
  rowClass,
} from './ui';

function ruleCriteriaSummary(rule: PamRule, signerGroupNames: Record<string, string> = {}): string {
  const parts: string[] = [];
  if (rule.matchSigner) parts.push(`signer=${rule.matchSigner}`);
  if (rule.matchSignerGroupId)
    parts.push(`signer group=${signerGroupNames[rule.matchSignerGroupId] ?? rule.matchSignerGroupId}`);
  if (rule.matchHash) parts.push(`hash=${rule.matchHash.slice(0, 12)}…`);
  if (rule.matchPathGlob) parts.push(`path=${rule.matchPathGlob}`);
  if (rule.matchParentImage) parts.push(`parent=${rule.matchParentImage}`);
  if (rule.matchCommandLine) parts.push(`cmdline=${rule.matchCommandLine}`);
  if (rule.matchUser) parts.push(`user=${rule.matchUser}`);
  if (rule.matchAdGroup) parts.push(`group=${rule.matchAdGroup}`);
  if (rule.matchToolName) parts.push(`tool=${rule.matchToolName}`);
  if (rule.matchRiskTier !== null && rule.matchRiskTier !== undefined)
    parts.push(`tier=${rule.matchRiskTier}`);
  if (rule.timeWindow) parts.push(`window=${rule.timeWindow.start}-${rule.timeWindow.end}`);
  return parts.join(' · ');
}

export default function PamRulesTab({ liveTick = 0 }: { liveTick?: number }) {
  const { t } = useTranslation('security');
  const [rules, setRules] = useState<PamRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PamRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PamRule | null>(null);
  const [deleting, setDeleting] = useState(false);
  // siteId → name, resolved once for the Scope column (GET /pam/rules returns
  // only siteId; no per-row lookups).
  const [siteNames, setSiteNames] = useState<Record<string, string>>({});
  // signerGroupId → name, resolved once so the Criteria cell can show a group's
  // name instead of a bare uuid (GET /pam/rules returns only the id).
  const [signerGroupNames, setSignerGroupNames] = useState<Record<string, string>>({});
  // Org default verdict for an elevation matching no policy and no rule.
  const [defaultVerdict, setDefaultVerdict] = useState<PamUnmatchedVerdict>('require_approval');
  const [savingDefault, setSavingDefault] = useState(false);

  useEffect(() => {
    fetchWithAuth('/orgs/sites?limit=100')
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json();
        const list = (data.data ?? data.sites ?? data ?? []) as Array<{ id: string; name: string }>;
        setSiteNames(Object.fromEntries(list.map((s) => [s.id, s.name])));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchWithAuth('/pam/signer-groups')
      .then(async (res) => {
        if (!res.ok) return;
        const body = await res.json();
        const list = (body.signerGroups ?? []) as Array<{ id: string; name: string }>;
        setSignerGroupNames(Object.fromEntries(list.map((g) => [g.id, g.name])));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchWithAuth('/pam/config')
      .then(async (res) => {
        if (!res.ok) return;
        const body = await res.json();
        if (body?.config?.defaultUnmatchedVerdict) {
          setDefaultVerdict(body.config.defaultUnmatchedVerdict as PamUnmatchedVerdict);
        }
      })
      .catch(() => {});
  }, []);

  const changeDefaultVerdict = async (next: PamUnmatchedVerdict) => {
    if (savingDefault) return;
    const prev = defaultVerdict;
    setDefaultVerdict(next);
    setSavingDefault(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth('/pam/config', {
            method: 'PUT',
            body: JSON.stringify({ defaultUnmatchedVerdict: next }),
          }),
        errorFallback: t('pamPamRulesTab.errors.updateDefaultVerdict', {
          defaultValue: 'Failed to update default verdict',
        }),
        successMessage: t('pamPamRulesTab.toasts.defaultVerdictSet', {
          defaultValue: 'Default verdict set to {{verdict}}',
          verdict: VERDICT_LABELS[next],
        }),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
    } catch (err) {
      setDefaultVerdict(prev); // roll back the optimistic change on failure
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({
          type: 'error',
          message: t('pamPamRulesTab.errors.updateDefaultVerdict', {
            defaultValue: 'Failed to update default verdict',
          }),
        });
      }
    } finally {
      setSavingDefault(false);
    }
  };

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
          throw new Error(
            t('pamPamRulesTab.errors.loadWithStatus', {
              defaultValue: 'Failed to load rules (HTTP {{status}})',
              status: res.status,
            }),
          );
      }
      const body = await res.json();
      const list = ((body.rules ?? []) as PamRule[]).slice();
      list.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
      setRules(list);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(
        err instanceof Error
          ? err.message
          : t('pamPamRulesTab.errors.load', { defaultValue: 'Failed to load rules' }),
      );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchRules(controller.signal);
    return () => controller.abort();
  }, [fetchRules, liveTick]);

  const toggleEnabled = async (rule: PamRule) => {
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/pam/rules/${rule.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: !rule.enabled }),
          }),
        errorFallback: t('pamPamRulesTab.errors.updateRule', {
          defaultValue: 'Failed to update rule',
        }),
        successMessage: t('pamPamRulesTab.toasts.ruleToggled', {
          defaultValue: 'Rule "{{name}}" {{state}}',
          name: rule.name,
          state: rule.enabled
            ? t('pamPamRulesTab.states.disabled', { defaultValue: 'disabled' })
            : t('pamPamRulesTab.states.enabled', { defaultValue: 'enabled' }),
        }),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      void fetchRules();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({
          type: 'error',
          message: t('pamPamRulesTab.errors.updateRule', { defaultValue: 'Failed to update rule' }),
        });
      }
    }
  };

  const confirmDeleteRule = async () => {
    if (!deleteTarget || deleting) return;
    const rule = deleteTarget;
    setDeleting(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/pam/rules/${rule.id}`, { method: 'DELETE' }),
        errorFallback: t('pamPamRulesTab.errors.deleteRule', {
          defaultValue: 'Failed to delete rule',
        }),
        successMessage: t('pamPamRulesTab.toasts.ruleDeleted', {
          defaultValue: 'Rule "{{name}}" deleted',
          name: rule.name,
        }),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      void fetchRules();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({
          type: 'error',
          message: t('pamPamRulesTab.errors.deleteRule', { defaultValue: 'Failed to delete rule' }),
        });
      }
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t('pamPamRulesTab.description', {
            defaultValue:
              'Software policies are evaluated first — an allowlist/blocklist match decides before these rules. Rules then run in priority order (lowest first); the first match decides.',
          })}
        </p>
        <button
          type="button"
          onClick={() => setCreating(true)}
          data-testid="pam-add-rule-btn"
          className={btnPrimaryClass}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('pamPamRulesTab.actions.addRule', { defaultValue: 'Add rule' })}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-4 py-3 shadow-xs">
        <label htmlFor="pam-default-unmatched-verdict" className="text-sm font-medium">
          {t('pamPamRulesTab.defaultVerdict.label', { defaultValue: 'Default verdict' })}
        </label>
        <select
          id="pam-default-unmatched-verdict"
          value={defaultVerdict}
          onChange={(e) => void changeDefaultVerdict(e.target.value as PamUnmatchedVerdict)}
          disabled={savingDefault}
          data-testid="pam-default-unmatched-verdict"
          className={`${selectClass} disabled:opacity-50`}
        >
          <option value="require_approval">
            {t('pamPamRulesTab.defaultVerdict.requireApproval', { defaultValue: 'Require approval' })}
          </option>
          <option value="auto_deny">
            {t('pamPamRulesTab.defaultVerdict.autoDeny', { defaultValue: 'Auto-deny' })}
          </option>
        </select>
        <span className="text-xs text-muted-foreground">
          {t('pamPamRulesTab.defaultVerdict.help', {
            defaultValue: 'Verdict when an elevation matches no policy or rule.',
          })}
        </span>
      </div>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {loading ? (
        <TableSkeleton label={t('pamPamRulesTab.loading', { defaultValue: 'Loading rules…' })} />
      ) : rules.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title={t('pamPamRulesTab.empty.title', { defaultValue: 'No PAM rules yet' })}
          description={t('pamPamRulesTab.empty.description', {
            defaultValue: 'Without rules, every elevation request waits for a manual decision.',
          })}
        />
      ) : (
        <div className={tableWrapClass}>
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr className={theadRowClass}>
                <th className={thClass}>{t('pamPamRulesTab.table.priority', { defaultValue: 'Priority' })}</th>
                <th className={thClass}>{t('pamPamRulesTab.table.name', { defaultValue: 'Name' })}</th>
                <th className={thClass}>{t('pamPamRulesTab.table.criteria', { defaultValue: 'Criteria' })}</th>
                <th className={thClass}>{t('pamPamRulesTab.table.scope', { defaultValue: 'Scope' })}</th>
                <th className={thClass}>{t('pamPamRulesTab.table.verdict', { defaultValue: 'Verdict' })}</th>
                <th className={thClass}>{t('pamPamRulesTab.table.enabled', { defaultValue: 'Enabled' })}</th>
                <th className={thClass} />
              </tr>
            </thead>
            <tbody className={tbodyClass}>
              {rules.map((rule) => (
                <tr key={rule.id} className={rowClass} data-testid={`pam-rule-row-${rule.id}`}>
                  <td className={`${tdClass} tabular-nums text-muted-foreground`}>{rule.priority}</td>
                  <td className={tdClass}>
                    <div className="font-medium" data-testid={`pam-rule-name-${rule.id}`}>
                      {rule.name}
                    </div>
                    {rule.description && (
                      <div className="mt-0.5 max-w-[240px] truncate text-xs text-muted-foreground" title={rule.description}>
                        {rule.description}
                      </div>
                    )}
                  </td>
                  <td className={`${tdClass} max-w-[320px] truncate text-xs text-muted-foreground`} title={ruleCriteriaSummary(rule, signerGroupNames)}>
                    {ruleCriteriaSummary(rule, signerGroupNames) || '—'}
                  </td>
                  <td
                    className={`${tdClass} whitespace-nowrap text-xs text-muted-foreground`}
                    data-testid={`pam-rule-scope-${rule.id}`}
                  >
                    {rule.siteId
                      ? siteNames[rule.siteId] ?? rule.siteId
                      : t('pamPamRulesTab.table.orgWide', { defaultValue: 'Org-wide' })}
                  </td>
                  <td className={`${tdClass} whitespace-nowrap`}>{VERDICT_LABELS[rule.verdict]}</td>
                  <td className={tdClass}>
                    <Switch
                      checked={rule.enabled}
                      onToggle={() => void toggleEnabled(rule)}
                      testId={`pam-rule-toggle-${rule.id}`}
                    />
                  </td>
                  <td className={`${tdClass} whitespace-nowrap text-right`}>
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setEditing(rule)}
                        data-testid={`pam-rule-edit-${rule.id}`}
                        className={btnOutlineClass}
                      >
                        {t('common:actions.edit', { defaultValue: 'Edit' })}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(rule)}
                        data-testid={`pam-rule-delete-${rule.id}`}
                        className={btnOutlineDestructiveClass}
                      >
                        {t('common:actions.delete', { defaultValue: 'Delete' })}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDeleteRule()}
        title={t('pamPamRulesTab.deleteDialog.title', { defaultValue: 'Delete PAM rule' })}
        message={t('pamPamRulesTab.deleteDialog.message', {
          defaultValue: 'Delete rule "{{name}}"? Elevation requests will no longer match it.',
          name: deleteTarget?.name ?? '',
        })}
        confirmLabel={t('pamPamRulesTab.deleteDialog.confirm', { defaultValue: 'Delete rule' })}
        variant="destructive"
        isLoading={deleting}
        confirmTestId="pam-rule-delete-confirm"
      />

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
