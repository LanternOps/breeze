import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Layers, Loader2, Pencil, Play, Plus } from 'lucide-react';
import { cn, friendlyFetchError } from '@/lib/utils';
import { runAction, ActionError } from '@/lib/runAction';
import { fetchWithAuth } from '@/stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useOrgScope } from '@/hooks/useOrgScope';
import { useDefaultOwnerScope } from '@/hooks/useDefaultOwnerScope';
import CisBaselineForm from './CisBaselineForm';
import type { Baseline } from './types';

const levelBadge: Record<string, string> = {
  l1: 'bg-blue-500/20 text-blue-700 border-blue-500/30',
  l2: 'bg-purple-500/20 text-purple-700 border-purple-500/30',
  custom: 'bg-gray-500/20 text-gray-700 border-gray-500/30',
};

interface CisBaselinesTabProps {
  refreshKey: number;
  onMutate: () => void;
}

export default function CisBaselinesTab({ refreshKey, onMutate }: CisBaselinesTabProps) {
  const { t } = useTranslation(['security', 'common']);
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const orgCount = useOrgStore((s) => s.organizations.length);
  // An ORG-OWNED baseline needs a concrete org. In fleet view the API still
  // auto-resolves the org for a partner that manages exactly one, so only a
  // partner with a real choice to make is blocked — gating on `scope === 'org'`
  // alone would lock single-org partners out of a create the server would have
  // accepted. Since #2135 that is no longer the whole story: a partner-scope
  // user can also create a PARTNER-WIDE baseline (org_id NULL), which needs no
  // org at all, so the multi-org fleet block does not apply to them. The form
  // owns the org-vs-partner choice; this gate only decides whether there is a
  // creatable owner at all.
  const scope = useOrgScope();
  const { isPartnerScope } = useDefaultOwnerScope();
  const canCreate =
    scope.scope === 'org' || (scope.scope === 'all' && (orgCount === 1 || isPartnerScope));
  // Distinct from the not-yet-resolved and zero-org states, where telling the
  // user to "select an organization" is advice they cannot act on.
  const needsOrgChoice = scope.scope === 'all' && orgCount > 1 && !isPartnerScope;
  const [baselines, setBaselines] = useState<Baseline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [editBaseline, setEditBaseline] = useState<Baseline | null | undefined>(undefined);
  const [scanningId, setScanningId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchBaselines = useCallback(async () => {
    setError(undefined);
    setLoading(true);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const params = new URLSearchParams({ limit: '200' });
      if (currentOrgId) params.set('orgId', currentOrgId);

      const response = await fetchWithAuth(`/cis/baselines?${params.toString()}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

      const payload = await response.json();
      setBaselines(Array.isArray(payload.data) ? payload.data : []);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(friendlyFetchError(err));
    } finally {
      // The early return above skips the error banner but cannot skip
      // `finally`, so an aborted request would still clear the spinner while
      // its replacement is in flight — rendering "No baselines configured"
      // over a pending load. Only the newest request may settle the flag.
      if (abortRef.current === controller) setLoading(false);
    }
  }, [currentOrgId]);

  useEffect(() => {
    fetchBaselines();
    return () => abortRef.current?.abort();
  }, [fetchBaselines, refreshKey]);

  const handleTriggerScan = async (baseline: Baseline) => {
    setScanningId(baseline.id);
    setError(undefined);
    try {
      // The scan is queued for the agents to pick up: nothing on this row
      // changes, and the results land minutes later on the Compliance tab. The
      // spinner stopping is therefore indistinguishable from a no-op, so the
      // success toast is the only confirmation the tech ever gets.
      await runAction({
        request: () => fetchWithAuth('/cis/scan', {
          method: 'POST',
          body: JSON.stringify({ baselineId: baseline.id }),
        }),
        errorFallback: t('cisHardeningCisBaselinesTab.messages.triggerScanFailed'),
        successMessage: t('cisHardeningCisBaselinesTab.messages.triggerScanQueued', { name: baseline.name }),
      });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      // runAction already toasted the failure; mirror it in the tab banner so
      // the reason survives the toast timing out.
      setError(err instanceof Error ? err.message : t('cisHardeningCisBaselinesTab.messages.triggerScanFailed'));
    } finally {
      setScanningId(null);
    }
  };

  const handleSaved = () => {
    setEditBaseline(undefined);
    fetchBaselines();
    onMutate();
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {editBaseline !== undefined && (
        <CisBaselineForm
          baseline={editBaseline}
          onClose={() => setEditBaseline(undefined)}
          onSaved={handleSaved}
        />
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">{t('cisHardeningCisBaselinesTab.title')}</h3>
        <button
          type="button"
          onClick={() => setEditBaseline(null)}
          disabled={!canCreate}
          title={needsOrgChoice ? t('common:layout.orgRequired.title') : undefined}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Plus className="h-4 w-4" />
          {t('cisHardeningCisBaselinesTab.actions.newBaseline')}
        </button>
      </div>

      <div className="mt-4 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t('cisHardeningCisBaselinesTab.table.name')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisBaselinesTab.table.os')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisBaselinesTab.table.level')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisBaselinesTab.table.version')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisBaselinesTab.table.schedule')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisBaselinesTab.table.status')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisBaselinesTab.table.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('cisHardeningCisBaselinesTab.loading')}
                  </span>
                </td>
              </tr>
            ) : baselines.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {t('cisHardeningCisBaselinesTab.empty')}
                </td>
              </tr>
            ) : (
              baselines.map((bl) => (
                <tr key={bl.id} className="text-sm">
                  <td className="px-4 py-3 font-medium">
                    <div className="flex items-center gap-2">
                      <span>{bl.name}</span>
                      {/* Partner-wide rows carry no org, so the org column the
                          tech is used to reading says nothing about their reach
                          — the badge is the only signal that editing this one
                          changes every organization. */}
                      {bl.partnerId !== null && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary"
                          title={t('cisHardeningCisBaselinesTab.badges.partnerWideTitle')}
                          data-testid="cis-baseline-partner-wide-badge"
                        >
                          <Layers className="h-3 w-3" />
                          {t('cisHardeningCisBaselinesTab.badges.allOrgs')}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 uppercase text-muted-foreground">{bl.osType}</td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold uppercase',
                        levelBadge[bl.level] ?? levelBadge.custom
                      )}
                    >
                      {t(/* i18n-dynamic */ `cisHardeningCisBaselinesTab.levels.${bl.level}`, { defaultValue: bl.level })}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{bl.benchmarkVersion}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {bl.scanSchedule?.enabled
                      ? t('cisHardeningCisBaselinesTab.schedule.everyHours', { hours: bl.scanSchedule.intervalHours })
                      : t('cisHardeningCisBaselinesTab.schedule.manual')}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold',
                        bl.isActive
                          ? 'bg-emerald-500/20 text-emerald-700 border-emerald-500/30'
                          : 'bg-gray-500/20 text-gray-700 border-gray-500/30'
                      )}
                    >
                      {bl.isActive
                        ? t('cisHardeningCisBaselinesTab.status.active')
                        : t('cisHardeningCisBaselinesTab.status.inactive')}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setEditBaseline(bl)}
                        className="rounded-md p-1.5 hover:bg-muted"
                        title={t('cisHardeningCisBaselinesTab.actions.edit')}
                      >
                        <Pencil className="h-4 w-4 text-muted-foreground" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTriggerScan(bl)}
                        disabled={scanningId === bl.id || !bl.isActive}
                        className="rounded-md p-1.5 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                        title={t('cisHardeningCisBaselinesTab.actions.triggerScan')}
                      >
                        {scanningId === bl.id ? (
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        ) : (
                          <Play className="h-4 w-4 text-muted-foreground" />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
