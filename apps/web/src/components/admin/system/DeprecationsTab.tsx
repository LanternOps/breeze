import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, History, Lock, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';
// Initializes the shared i18next singleton before any island renders translated text.
import '../../../lib/i18n';
import { useStableT } from '@/lib/i18n/useStableT';

/**
 * System → Deprecations tab (#6605 wave 2; moved from Settings by the
 * system page W02, 2026-09-23-system-connections-page-design.md §4).
 * Strings stay in the `settings` namespace (`systemDeprecations.*`).
 *
 * A read-only report, not a setting: every API retirement the image's
 * breaking-change manifest describes, with its status for this deployment,
 * plus the versions this deployment has recorded. Platform admins only — the
 * data is deployment-wide (GET /admin/deprecations sits behind
 * platformAdminMiddleware). Configured in 0 places before and after.
 */

type EntryStatus = 'crossed' | 'possibly_crossed' | 'in_effect' | 'upcoming';

interface DeprecationEntry {
  id: string;
  title: string;
  surfaces: Array<{ endpoint: string; fields: string[] }>;
  replacement: string;
  deprecatedIn: string;
  earliestRemovalDate: string;
  removedIn: string | null;
  references: string[];
  status: EntryStatus;
  milestone: 'deprecation' | 'removal' | null;
}

interface DeprecationsReport {
  currentVersion: string | null;
  rawCurrentVersion: string | null;
  lastRecordedVersion: string | null;
  historyKnown: boolean;
  historyNote: string | null;
  manifestError: string | null;
  ledger: { status: 'ok'; appliedCount: number; pendingCount: number } | { status: 'missing'; reason: string };
  history:
    | { status: 'ok'; versions: Array<{ version: string; firstSeenAt: string }> }
    | { status: 'missing'; reason: string };
  entries: DeprecationEntry[];
}

const STATUS_CLASSES: Record<EntryStatus, string> = {
  crossed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  possibly_crossed: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  in_effect: 'bg-muted text-foreground',
  upcoming: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
};

export default function DeprecationsTab() {
  const { t } = useTranslation('settings');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const [report, setReport] = useState<DeprecationsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth('/admin/deprecations');
      if (response.status === 403) {
        setForbidden(true);
        setReport(null);
        return;
      }
      if (!response.ok) throw new Error(stableT('systemDeprecations.errors.load'));
      const body = await response.json();
      setForbidden(false);
      setReport(body.data as DeprecationsReport);
    } catch (err) {
      setReport(null);
      setError(err instanceof Error ? err.message : stableT('systemDeprecations.errors.load'));
    } finally {
      setLoading(false);
    }
  }, [stableT]);

  useEffect(() => {
    void load();
  }, [load]);

  const statusLabel = (entry: DeprecationEntry) => {
    const status = t(/* i18n-dynamic */ `systemDeprecations.status.${entry.status}`);
    if (!entry.milestone || entry.status === 'in_effect') return status;
    return `${status} (${t(/* i18n-dynamic */ `systemDeprecations.milestone.${entry.milestone}`)})`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{t('systemDeprecations.title')}</h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">{t('systemDeprecations.description')}</p>
        </div>
        {!forbidden && (
          <button
            type="button"
            data-testid="deprecations-refresh"
            onClick={() => void load()}
            className="px-3 py-2 text-sm border rounded-md hover:bg-muted flex items-center gap-1 shrink-0"
          >
            <RefreshCw className="w-4 h-4" /> {t('systemDeprecations.refresh')}
          </button>
        )}
      </div>

      {forbidden ? (
        <div
          data-testid="deprecations-requires-platform-admin"
          className="border rounded-md px-6 py-8 flex items-start gap-4 bg-muted/40"
        >
          <Lock className="w-6 h-6 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold mb-1">{t('systemDeprecations.platformAdmin.title')}</div>
            <div className="text-sm text-muted-foreground">{t('systemDeprecations.platformAdmin.description')}</div>
          </div>
        </div>
      ) : loading ? (
        <div className="text-center py-12 text-muted-foreground">{t('systemDeprecations.loading')}</div>
      ) : error ? (
        <div data-testid="deprecations-error" role="alert" className="bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-200 px-4 py-3 rounded-md">
          {error}
        </div>
      ) : report ? (
        <>
          {report.manifestError && (
            <div role="alert" data-testid="deprecations-manifest-error" className="border border-red-300 bg-red-50 text-red-900 dark:bg-red-900/30 dark:text-red-100 px-4 py-3 rounded-md text-sm">
              {t('systemDeprecations.manifestError', { error: report.manifestError })}
            </div>
          )}

          {!report.historyKnown && (
            <div
              role="status"
              data-testid="deprecations-history-missing"
              className="border border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100 px-4 py-3 rounded-md text-sm flex gap-3"
            >
              <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium">
                  {report.currentVersion === null
                    ? t('systemDeprecations.noReleaseVersion')
                    : t('systemDeprecations.historyMissing')}
                </div>
                {report.historyNote && (
                  <div className="mt-1 text-xs">{t('systemDeprecations.historyReason', { reason: report.historyNote })}</div>
                )}
              </div>
            </div>
          )}

          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div className="border rounded-md p-3">
              <dt className="text-muted-foreground">{t('systemDeprecations.summary.imageVersion')}</dt>
              <dd className="font-mono mt-1" data-testid="deprecations-current-version">
                {report.currentVersion ?? t('systemDeprecations.summary.unknownVersion', { raw: report.rawCurrentVersion ?? '' })}
              </dd>
            </div>
            <div className="border rounded-md p-3">
              <dt className="text-muted-foreground">{t('systemDeprecations.summary.lastRecorded')}</dt>
              <dd className="font-mono mt-1">{report.lastRecordedVersion ?? t('systemDeprecations.summary.noneRecorded')}</dd>
            </div>
            <div className="border rounded-md p-3">
              <dt className="text-muted-foreground">{t('systemDeprecations.summary.migrations')}</dt>
              <dd className="mt-1" data-testid="deprecations-ledger">
                {report.ledger.status === 'ok'
                  ? t('systemDeprecations.summary.migrationCounts', {
                      applied: report.ledger.appliedCount,
                      pending: report.ledger.pendingCount,
                    })
                  : t('systemDeprecations.summary.ledgerMissing', { reason: report.ledger.reason })}
              </dd>
            </div>
          </dl>

          <section>
            <h2 className="text-lg font-semibold mb-2">{t('systemDeprecations.table.heading')}</h2>
            <div className="border rounded-md overflow-x-auto">
              <table data-testid="deprecations-table" className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2">{t('systemDeprecations.table.entry')}</th>
                    <th className="px-4 py-2">{t('systemDeprecations.table.affected')}</th>
                    <th className="px-4 py-2">{t('systemDeprecations.table.replacement')}</th>
                    <th className="px-4 py-2 whitespace-nowrap">{t('systemDeprecations.table.deprecatedIn')}</th>
                    <th className="px-4 py-2 whitespace-nowrap">{t('systemDeprecations.table.removal')}</th>
                    <th className="px-4 py-2">{t('systemDeprecations.table.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.entries.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                        {t('systemDeprecations.table.empty')}
                      </td>
                    </tr>
                  ) : (
                    report.entries.map((entry) => (
                      <tr key={entry.id} data-testid={`deprecation-row-${entry.id}`} className="border-t align-top">
                        <td className="px-4 py-3">
                          <div className="font-medium">{entry.title}</div>
                          <div className="text-xs text-muted-foreground font-mono mt-0.5">{entry.id}</div>
                          {entry.references.length > 0 && (
                            <div className="text-xs text-muted-foreground mt-0.5">{entry.references.join(' ')}</div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <ul className="space-y-1">
                            {entry.surfaces.map((surface) => (
                              <li key={surface.endpoint}>
                                <code className="text-xs">{surface.endpoint}</code>
                                <div className="text-xs text-muted-foreground">
                                  {surface.fields.length > 0
                                    ? surface.fields.join(', ')
                                    : t('systemDeprecations.table.wholeEndpoint')}
                                </div>
                              </li>
                            ))}
                          </ul>
                        </td>
                        <td className="px-4 py-3 max-w-md">{entry.replacement}</td>
                        <td className="px-4 py-3 font-mono">{entry.deprecatedIn}</td>
                        <td className="px-4 py-3">
                          {entry.removedIn ? (
                            <span className="font-mono">{entry.removedIn}</span>
                          ) : (
                            <span>{t('systemDeprecations.table.notBefore', { date: entry.earliestRemovalDate })}</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            data-testid="deprecation-status"
                            className={`inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${STATUS_CLASSES[entry.status]}`}
                          >
                            {statusLabel(entry)}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
              <History className="w-5 h-5" /> {t('systemDeprecations.history.heading')}
            </h2>
            {report.history.status === 'ok' && report.history.versions.length > 0 ? (
              <ul data-testid="deprecations-version-history" className="border rounded-md divide-y text-sm">
                {report.history.versions.map((v) => (
                  <li key={v.version} className="px-4 py-2 flex justify-between gap-4">
                    <span className="font-mono">{v.version}</span>
                    <span className="text-muted-foreground">
                      {t('systemDeprecations.history.firstSeen', { date: new Date(v.firstSeenAt).toLocaleString() })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t('systemDeprecations.history.none')}</p>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
