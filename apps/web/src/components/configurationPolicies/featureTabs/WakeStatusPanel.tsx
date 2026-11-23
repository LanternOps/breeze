import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '@/stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import { useFeatureReadOnly } from './featureEditing';

// Per-policy Wake-on-LAN status (#10838 W02). Reads GET
// /configuration-policies/:id/wake-status. "Send test wake" deliberately reuses
// the device command route so there is one authorization path; "Allow wake
// again" clears the repeated-timeout block for a device this policy governs.

const PAGE_SIZE = 25;
const BLOCK_THRESHOLD = 3; // mirrors WAKE_BLOCK_THRESHOLD on the API
const PREFIX = 'configurationPolicies.featureTabs.wakeOnLanTab.panel';

interface WakeRow {
  deviceId: string;
  hostname: string;
  osType: string;
  status: string;
  state: string;
  reasonCodes: string[];
  vendor: string | null;
  model: string | null;
  lastAttempt: { outcome: string; refusalCode: string | null; at: string } | null;
  consecutiveTimeouts: number;
  testWakeAllowed: boolean;
  show: boolean;
  mode: 'none' | 'verified' | 'always' | 'unknown';
  /** Vendor firmware observation summary (observe-first amendment); absent from older APIs. */
  observation?: { vendor: string; interface: string; errorCode: string | null } | null;
}

/** Brand names for the observed vendor lanes; brands are not translated. */
const OBSERVE_VENDOR_NAMES: Record<string, string> = { hp: 'HP', lenovo: 'Lenovo', microsoft: 'Surface' };

interface WakePage {
  data: WakeRow[];
  counts: Record<string, number>;
  total: number;
  page: number;
  limit: number;
  scanned: number;
  capped: boolean;
}

export default function WakeStatusPanel({ policyId }: { policyId: string }) {
  const { t } = useTranslation('policies');
  const readOnly = useFeatureReadOnly();
  const [state, setState] = useState<string>('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<WakePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (state) qs.set('state', state);
      const res = await fetchWithAuth(`/configuration-policies/${policyId}/wake-status?${qs.toString()}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      setResult((await res.json()) as WakePage);
    } catch (err) {
      console.error('[WakeStatusPanel] failed to load wake status', err);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [policyId, page, state]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (key: string, request: () => Promise<Response>, successMessage: string) => {
    setBusy(key);
    try {
      await runAction({ request, errorFallback: t('configurationPolicies.featureTabs.wakeOnLanTab.panel.actionFailed'), successMessage });
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ message: t('configurationPolicies.featureTabs.wakeOnLanTab.panel.actionFailed'), type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const allowAgain = (row: WakeRow) =>
    mutate(
      `allow-${row.deviceId}`,
      () => fetchWithAuth(`/configuration-policies/${policyId}/wake-status/${row.deviceId}/allow`, { method: 'POST' }),
      t('configurationPolicies.featureTabs.wakeOnLanTab.panel.allowedAgain', { host: row.hostname }),
    );

  const testWake = (row: WakeRow) =>
    mutate(
      `test-${row.deviceId}`,
      () =>
        fetchWithAuth(`/devices/${row.deviceId}/commands`, {
          method: 'POST',
          body: JSON.stringify({ type: 'wake', payload: { testWake: true } }),
        }),
      t('configurationPolicies.featureTabs.wakeOnLanTab.panel.testWakeSent', { host: row.hostname }),
    );

  const counts = result?.counts ?? {};
  const totalCount = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const pages = result ? Math.max(1, Math.ceil(result.total / result.limit)) : 1;

  const stateLabel = (s: string) => t(/* i18n-dynamic */ `${PREFIX}.states.${s}`, { defaultValue: s });
  const reasonLabel = (code: string) => t(/* i18n-dynamic */ `${PREFIX}.reasons.${code}`, { defaultValue: code });
  const observingLabel = (o: NonNullable<WakeRow['observation']>) => {
    const vendor = OBSERVE_VENDOR_NAMES[o.vendor] ?? o.vendor;
    const iface = t(/* i18n-dynamic */ `${PREFIX}.observeInterfaces.${o.interface}`, { defaultValue: o.interface });
    if (o.errorCode) {
      return t('configurationPolicies.featureTabs.wakeOnLanTab.panel.observingWithCode', { vendor, interface: iface, code: o.errorCode });
    }
    return t('configurationPolicies.featureTabs.wakeOnLanTab.panel.observing', { vendor, interface: iface });
  };
  const attemptLabel = (a: NonNullable<WakeRow['lastAttempt']>) => {
    const base = t(/* i18n-dynamic */ `${PREFIX}.attempts.${a.outcome}`, { defaultValue: a.outcome });
    const withCode = a.refusalCode ? `${base} (${a.refusalCode})` : base;
    return `${withCode} · ${new Date(a.at).toLocaleString()}`;
  };

  return (
    <section data-testid="wake-status-panel" className="space-y-4 rounded-md border bg-background p-4">
      <div>
        <h3 className="text-sm font-semibold">{t('configurationPolicies.featureTabs.wakeOnLanTab.panel.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('configurationPolicies.featureTabs.wakeOnLanTab.panel.description')}</p>
      </div>

      <div
        data-testid="wake-advisory"
        className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs"
      >
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p>{t('configurationPolicies.featureTabs.wakeOnLanTab.panel.advisory')}</p>
      </div>

      {result?.capped && (
        <p data-testid="wake-capped-note" className="text-xs text-amber-700">
          {t('configurationPolicies.featureTabs.wakeOnLanTab.panel.cappedNote', { scanned: result.scanned })}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="wake-chip-all"
          onClick={() => { setState(''); setPage(1); }}
          className={`rounded-full border px-3 py-1 text-xs ${state === '' ? 'bg-primary text-primary-foreground' : 'bg-background'}`}
        >
          {t('configurationPolicies.featureTabs.wakeOnLanTab.panel.chipAll', { count: totalCount })}
        </button>
        {Object.entries(counts).map(([key, n]) => (
          <button
            key={key}
            type="button"
            data-testid={`wake-chip-${key}`}
            onClick={() => { setState(key); setPage(1); }}
            className={`rounded-full border px-3 py-1 text-xs ${state === key ? 'bg-primary text-primary-foreground' : 'bg-background'}`}
          >
            {stateLabel(key)} ({n})
          </button>
        ))}
      </div>

      {failed && <p className="text-sm text-destructive">{t('configurationPolicies.featureTabs.wakeOnLanTab.panel.loadFailed')}</p>}
      {!failed && loading && !result && <p className="text-sm text-muted-foreground">{t('configurationPolicies.featureTabs.wakeOnLanTab.panel.loading')}</p>}
      {!failed && result && result.data.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('configurationPolicies.featureTabs.wakeOnLanTab.panel.empty')}</p>
      )}

      {result && result.data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-3">{t('configurationPolicies.featureTabs.wakeOnLanTab.panel.columns.device')}</th>
                <th className="py-2 pr-3">{t('configurationPolicies.featureTabs.wakeOnLanTab.panel.columns.state')}</th>
                <th className="py-2 pr-3">{t('configurationPolicies.featureTabs.wakeOnLanTab.panel.columns.reasons')}</th>
                <th className="py-2 pr-3">{t('configurationPolicies.featureTabs.wakeOnLanTab.panel.columns.hardware')}</th>
                <th className="py-2 pr-3">{t('configurationPolicies.featureTabs.wakeOnLanTab.panel.columns.lastAttempt')}</th>
                <th className="py-2 pr-3">{t('configurationPolicies.featureTabs.wakeOnLanTab.panel.columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {result.data.map((row) => {
                const flagged = row.consecutiveTimeouts >= BLOCK_THRESHOLD;
                return (
                  <tr key={row.deviceId} className="border-t align-top">
                    <td className="py-2 pr-3 font-medium">{row.hostname}</td>
                    <td className="py-2 pr-3">{stateLabel(row.state)}</td>
                    <td className="py-2 pr-3 text-xs">
                      {row.reasonCodes.length === 0 ? '-' : row.reasonCodes.map(reasonLabel).join('; ')}
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      {[row.vendor, row.model].filter(Boolean).join(' ') || '-'}
                      {row.observation && (
                        <span data-testid={`wake-observing-${row.deviceId}`} className="mt-1 block text-muted-foreground">
                          {observingLabel(row.observation)}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      {row.lastAttempt ? attemptLabel(row.lastAttempt) : t('configurationPolicies.featureTabs.wakeOnLanTab.panel.noAttempts')}
                      {flagged && (
                        <span
                          data-testid={`wake-flagged-${row.deviceId}`}
                          className="mt-1 flex items-center gap-1 text-amber-700"
                        >
                          <AlertTriangle className="h-3 w-3" />
                          {t('configurationPolicies.featureTabs.wakeOnLanTab.panel.flagged', { count: row.consecutiveTimeouts })}
                        </span>
                      )}
                    </td>
                    <td className="space-x-2 py-2 pr-3">
                      {!readOnly && row.testWakeAllowed && (
                        <button
                          type="button"
                          data-testid={`wake-test-${row.deviceId}`}
                          disabled={busy !== null}
                          onClick={() => void testWake(row)}
                          className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                        >
                          {t('configurationPolicies.featureTabs.wakeOnLanTab.panel.testWake')}
                        </button>
                      )}
                      {!readOnly && flagged && (
                        <button
                          type="button"
                          data-testid={`wake-allow-${row.deviceId}`}
                          disabled={busy !== null}
                          onClick={() => void allowAgain(row)}
                          className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                        >
                          {t('configurationPolicies.featureTabs.wakeOnLanTab.panel.allowAgain')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {result && pages > 1 && (
        <div className="flex items-center justify-between text-xs">
          <button
            type="button"
            data-testid="wake-page-prev"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded-md border px-2 py-1 disabled:opacity-50"
          >
            {t('configurationPolicies.featureTabs.wakeOnLanTab.panel.previous')}
          </button>
          <span>{t('configurationPolicies.featureTabs.wakeOnLanTab.panel.pageOf', { page, pages })}</span>
          <button
            type="button"
            data-testid="wake-page-next"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-md border px-2 py-1 disabled:opacity-50"
          >
            {t('configurationPolicies.featureTabs.wakeOnLanTab.panel.next')}
          </button>
        </div>
      )}
    </section>
  );
}
