import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Lock, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';
// Initializes the shared i18next singleton before any island renders translated text.
import '../../../lib/i18n';
import {
  CONNECTION_STATUSES,
  displayableValue,
  filterGroups,
  isConnectionsReport,
  safeDocsUrl,
  type ConnectionEntryView,
  type ConnectionStatus,
  type ConnectionsReport,
} from './connectionsTypes';

/**
 * System → Connections (spec 2026-09-23-system-connections-page-design.md §4).
 *
 * Read-only (D1) view of which integrations the API container is configured
 * for. "Enabled" means configured, not reachable (D4). Secret vars render
 * only as a set / not set pill, never a value (D2/D8) — enforced here by
 * `displayableValue`, independent of what the API sends. Platform admins
 * only: the route sits behind platformAdminMiddleware (D6); a 403 renders
 * the platform-admin panel.
 */

const STATUS_CLASSES: Record<ConnectionStatus, string> = {
  enabled: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  disabled: 'bg-muted text-muted-foreground',
  misconfigured: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  required_missing: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

function ConnectionCard({ entry }: { entry: ConnectionEntryView }) {
  const { t } = useTranslation('admin');
  const docsUrl = safeDocsUrl(entry.docsUrl);
  return (
    <article data-testid={`connection-card-${entry.id}`} className="border rounded-md p-4 space-y-3">
      <header className="flex items-start justify-between gap-3">
        <h3 className="font-medium">{entry.label}</h3>
        <span
          data-testid="connection-status"
          className={`inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${STATUS_CLASSES[entry.status]}`}
        >
          {t(/* i18n-dynamic */ `admin.systemPage.connections.status.${entry.status}`)}
        </span>
      </header>
      {entry.reason && (
        <p data-testid="connection-reason" className="text-sm text-amber-900 dark:text-amber-200">
          {entry.reason}
        </p>
      )}
      {entry.vars.length > 0 && (
        <dl className="text-sm border rounded divide-y">
          {entry.vars.map((v) => {
            const value = displayableValue(v);
            return (
              <div
                key={v.name}
                data-testid={`connection-var-${v.name}`}
                className="flex items-center justify-between gap-3 px-3 py-1.5"
              >
                <dt className="font-mono text-xs break-all">{v.name}</dt>
                <dd className="text-right">
                  {value !== null ? (
                    <code data-testid="connection-var-value" className="text-xs break-all">
                      {value}
                    </code>
                  ) : (
                    <span
                      data-testid="connection-var-pill"
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${
                        v.set
                          ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {v.secret !== false && (
                        <>
                          <Lock className="w-3 h-3" aria-hidden="true" />
                          <span className="sr-only">{t('admin.systemPage.connections.var.secret')}</span>
                        </>
                      )}
                      {v.set === true
                        ? t('admin.systemPage.connections.var.set')
                        : t('admin.systemPage.connections.var.notSet')}
                    </span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {docsUrl && (
        <a
          href={docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="connection-docs"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          {t('admin.systemPage.connections.docs')}
          <ExternalLink className="w-3 h-3" aria-hidden="true" />
        </a>
      )}
    </article>
  );
}

export default function ConnectionsTab() {
  const { t } = useTranslation('admin');
  const [report, setReport] = useState<ConnectionsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string>();
  const [problemsOnly, setProblemsOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth('/admin/system/connections');
      if (response.status === 403) {
        setForbidden(true);
        setReport(null);
        return;
      }
      if (!response.ok) throw new Error(`GET /admin/system/connections returned ${response.status}`);
      const body = (await response.json()) as { data?: unknown } | null;
      // A 200 with a missing or malformed report must take the error path,
      // not render a blank tab that reads as "nothing to show".
      if (!isConnectionsReport(body?.data)) {
        throw new Error('GET /admin/system/connections returned a malformed report');
      }
      setForbidden(false);
      setReport(body.data);
    } catch (err) {
      // Always the localized message: a raw network/JSON error text is not
      // useful to an admin and should not leak implementation detail.
      console.error('[ConnectionsTab] failed to load connection status', err);
      setReport(null);
      setError(t('admin.systemPage.connections.errors.load'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => (report ? filterGroups(report.groups, problemsOnly) : []), [report, problemsOnly]);

  const statusLabel = (status: ConnectionStatus) =>
    t(/* i18n-dynamic */ `admin.systemPage.connections.status.${status}`);

  if (forbidden) {
    return (
      <div
        data-testid="connections-requires-platform-admin"
        className="border rounded-md px-6 py-8 flex items-start gap-4 bg-muted/40"
      >
        <Lock className="w-6 h-6 shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <div className="font-semibold mb-1">{t('admin.systemPage.connections.platformAdmin.title')}</div>
          <div className="text-sm text-muted-foreground">{t('admin.systemPage.connections.platformAdmin.description')}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 text-sm text-muted-foreground max-w-3xl">
          {report && (
            <p data-testid="connections-meta" className="font-mono text-foreground">
              {t('admin.systemPage.connections.meta', {
                version: report.version,
                mode: t(/* i18n-dynamic */ `admin.systemPage.connections.deployMode.${report.deployMode}`),
              })}
            </p>
          )}
          <p data-testid="connections-enabled-meaning">{t('admin.systemPage.connections.enabledMeaning')}</p>
        </div>
        <button
          type="button"
          data-testid="connections-refresh"
          onClick={() => void load()}
          className="px-3 py-2 text-sm border rounded-md hover:bg-muted flex items-center gap-1 shrink-0"
        >
          <RefreshCw className="w-4 h-4" aria-hidden="true" /> {t('admin.systemPage.connections.refresh')}
        </button>
      </div>

      {loading ? (
        <div className="text-center py-12 text-muted-foreground">{t('admin.systemPage.connections.loading')}</div>
      ) : error ? (
        <div
          data-testid="connections-error"
          role="alert"
          className="bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-200 px-4 py-3 rounded-md"
        >
          {error}
        </div>
      ) : report ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ul
              data-testid="connections-summary"
              aria-label={t('admin.systemPage.connections.summaryLabel')}
              className="flex flex-wrap gap-2 text-sm"
            >
              {CONNECTION_STATUSES.filter(
                (s) => s === 'enabled' || s === 'disabled' || (report.summary[s] ?? 0) > 0,
              ).map((s) => (
                <li
                  key={s}
                  data-testid={`connections-summary-${s}`}
                  className={`px-3 py-1 rounded-full ${STATUS_CLASSES[s]}`}
                >
                  <span className="font-semibold">{report.summary[s] ?? 0}</span> {statusLabel(s)}
                </li>
              ))}
            </ul>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="connections-problems-only"
                checked={problemsOnly}
                onChange={(e) => setProblemsOnly(e.target.checked)}
              />
              {t('admin.systemPage.connections.problemsOnly')}
            </label>
          </div>

          {groups.length === 0 ? (
            problemsOnly ? (
              <p data-testid="connections-no-problems" className="text-sm text-muted-foreground">
                {t('admin.systemPage.connections.noProblems')}
              </p>
            ) : (
              <p data-testid="connections-empty" className="text-sm text-muted-foreground">
                {t('admin.systemPage.connections.empty')}
              </p>
            )
          ) : (
            groups.map((g) => (
              <section key={g.group} data-testid={`connections-group-${g.group}`} className="space-y-3">
                <h2 className="text-lg font-semibold">
                  {t(/* i18n-dynamic */ `admin.systemPage.connections.groups.${g.group}`, { defaultValue: g.group })}
                </h2>
                <div className="grid gap-3 md:grid-cols-2">
                  {g.entries.map((entry) => (
                    <ConnectionCard key={entry.id} entry={entry} />
                  ))}
                </div>
              </section>
            ))
          )}
        </>
      ) : null}

      <p data-testid="connections-footnote" className="text-xs text-muted-foreground">
        {t('admin.systemPage.connections.footnote')}
      </p>
    </div>
  );
}
