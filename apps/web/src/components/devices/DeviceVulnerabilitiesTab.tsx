import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ResponsiveTable, DataCard, CardField, CardActions } from '../shared/ResponsiveTable';
import { handleActionError } from '../../lib/runAction';
import { usePermissions } from '../../lib/permissions';
import {
  fetchDeviceSoftwareGroups,
  remediateVuln,
  acceptVulnRisk,
  mitigateVuln,
  reopenVuln,
  type DeviceVulnFinding,
  type DeviceVulnStats,
  type SoftwareGroup,
} from '../../lib/api/vulnerabilities';
import { formatNumber } from '@/lib/i18n/format';

const SEVERITY_BADGES: Record<string, { label: string; className: string }> = {
  critical: { label: 'critical', className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  high: { label: 'high', className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300' },
  medium: { label: 'medium', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  low: { label: 'low', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
};

/**
 * `stats.openTotal` is really "count of findings in the CURRENT status
 * filter" — the API computes it from the already-status-filtered rows, not
 * strictly open findings. Label the total tile to match the active filter
 * instead of hardcoding "Open" so switching filters doesn't mislabel it.
 */
const STATUS_TOTAL_LABELS: Record<string, string> = {
  open: 'open',
  all: 'total',
  accepted: 'accepted',
  mitigated: 'mitigated',
  patched: 'patched',
};

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  open: { label: 'open', className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  accepted: { label: 'accepted', className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
  mitigated: { label: 'mitigated', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
  patched: { label: 'patched', className: 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300' },
};

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('devices');
  const badge = STATUS_BADGES[status?.toLowerCase()] ?? {
    label: status ?? 'unknown',
    className: 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${badge.className}`}>
      {t(/* i18n-dynamic */ `deviceVulnerabilitiesTab.status.${badge.label}`, { defaultValue: badge.label })}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string | null }) {
  const { t } = useTranslation('devices');
  const badge = SEVERITY_BADGES[severity?.toLowerCase() ?? ''] ?? {
    label: severity ?? 'unknown',
    className: 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${badge.className}`}>
      {t(/* i18n-dynamic */ `deviceVulnerabilitiesTab.severity.${badge.label}`, { defaultValue: badge.label })}
    </span>
  );
}

const ACTION_BTN = 'rounded-md border px-2 py-1 text-xs font-medium transition hover:bg-muted/60 disabled:opacity-50';

type ModalState =
  | { kind: 'accept'; id: string; cveId: string }
  | { kind: 'mitigate'; id: string; cveId: string }
  | null;

type DeviceVulnerabilitiesTabProps = {
  deviceId: string;
  timezone?: string;
};

const EMPTY_STATS: DeviceVulnStats = {
  openTotal: 0,
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  unscored: 0,
  kevFindingCount: 0,
  patchReadyFindingCount: 0,
};

/** Group a flat array by a derived key, preserving insertion order within each group. */
function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key);
    if (list) {
      list.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

export function DeviceVulnerabilitiesTab({ deviceId }: DeviceVulnerabilitiesTabProps) {
  const { t } = useTranslation('devices');
  const [groups, setGroups] = useState<SoftwareGroup[]>([]);
  const [findings, setFindings] = useState<DeviceVulnFinding[]>([]);
  const [stats, setStats] = useState<DeviceVulnStats>(EMPTY_STATS);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [statusFilter, setStatusFilter] = useState<string>('open');
  const [bulkBusy, setBulkBusy] = useState(false);

  const { can } = usePermissions();
  const canAcceptRisk = can('vulnerabilities', 'accept_risk');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchDeviceSoftwareGroups(deviceId, { status: statusFilter });
      setGroups(res.groups);
      setFindings(res.findings);
      setStats(res.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deviceVulnerabilitiesTab.errors.load'));
    } finally {
      setLoading(false);
    }
  }, [deviceId, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const findingsByGroup = useMemo(() => groupBy(findings, (f) => f.groupKey), [findings]);

  const toggleExpanded = useCallback((groupKey: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }, []);

  const onRemediate = useCallback(async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    try {
      await remediateVuln([id]);
      await load();
    } catch (err) {
      handleActionError(err, t('deviceVulnerabilitiesTab.errors.scheduleRemediation'));
    } finally {
      setBusyId(null);
    }
  }, [busyId, load]);

  const groupPatchReadyIds = useCallback(
    (groupKey: string) =>
      (findingsByGroup.get(groupKey) ?? [])
        .filter((f) => f.status === 'open' && f.patchAvailable)
        .map((f) => f.id),
    [findingsByGroup],
  );

  const onRemediateGroup = useCallback(async (groupKey: string) => {
    const ids = groupPatchReadyIds(groupKey);
    if (ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      await remediateVuln(ids);
      await load();
    } catch (err) {
      handleActionError(err, t('deviceVulnerabilitiesTab.errors.scheduleRemediation'));
    } finally {
      setBulkBusy(false);
    }
  }, [groupPatchReadyIds, bulkBusy, load]);

  const onReopen = useCallback(async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    try {
      await reopenVuln(id);
      await load();
    } catch (err) {
      handleActionError(err, t('deviceVulnerabilitiesTab.errors.reopen'));
    } finally {
      setBusyId(null);
    }
  }, [busyId, load]);

  const onSubmitModal = useCallback(async (payload: { reason?: string; acceptedUntil?: string; note?: string }) => {
    if (!modal) return;
    setBusyId(modal.id);
    try {
      if (modal.kind === 'accept') {
        await acceptVulnRisk(modal.id, { reason: payload.reason ?? '', acceptedUntil: payload.acceptedUntil ?? '' });
      } else {
        await mitigateVuln(modal.id, { note: payload.note ?? '' });
      }
      setModal(null);
      await load();
    } catch (err) {
      handleActionError(err, modal.kind === 'accept'
        ? t('deviceVulnerabilitiesTab.errors.acceptRisk')
        : t('deviceVulnerabilitiesTab.errors.mitigate'));
    } finally {
      setBusyId(null);
    }
  }, [modal, load]);

  const rowActions = useCallback(
    (v: DeviceVulnFinding) => {
      const status = v.status?.toLowerCase();
      if (status === 'accepted' || status === 'mitigated') {
        return (
          <div className="flex flex-wrap justify-end gap-2">
            {canAcceptRisk && (
              <button
                type="button"
                data-testid={`reopen-${v.id}`}
                className={ACTION_BTN}
                disabled={busyId === v.id}
                onClick={() => void onReopen(v.id)}
              >
                {t('deviceVulnerabilitiesTab.actions.reopen')}
              </button>
            )}
          </div>
        );
      }
      if (status === 'patched') {
        return <div className="flex flex-wrap justify-end gap-2" />;
      }
      return (
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            data-testid={`remediate-${v.id}`}
            className={ACTION_BTN}
            disabled={busyId === v.id || !v.patchAvailable}
            title={v.patchAvailable ? undefined : t('deviceVulnerabilitiesTab.noPatchAvailable')}
            onClick={() => void onRemediate(v.id)}
          >
            {t('deviceVulnerabilitiesTab.actions.remediate')}
          </button>
          {canAcceptRisk && (
            <button
              type="button"
              data-testid={`accept-${v.id}`}
              className={ACTION_BTN}
              disabled={busyId === v.id}
              onClick={() => setModal({ kind: 'accept', id: v.id, cveId: v.cveId })}
            >
              {t('deviceVulnerabilitiesTab.actions.acceptRisk')}
            </button>
          )}
          <button
            type="button"
            data-testid={`mitigate-${v.id}`}
            className={ACTION_BTN}
            disabled={busyId === v.id}
            onClick={() => setModal({ kind: 'mitigate', id: v.id, cveId: v.cveId })}
          >
            {t('deviceVulnerabilitiesTab.actions.mitigate')}
          </button>
        </div>
      );
    },
    [busyId, onRemediate, onReopen, canAcceptRisk, t],
  );

  const isOpenFilter = statusFilter === 'open';

  /**
   * Desktop table for a single group's drill-down findings. Rendered inside
   * `ResponsiveTable` alongside `renderGroupCards` so the 7-column layout
   * (CVE / Severity / Status / CVSS / Risk / KEV / Actions) never silently
   * clips on a phone the way a bare `<table>` does — see the fleet-wide
   * `ResponsiveTable` doc comment. Defined as a plain function (not memoized)
   * since it's invoked once per expanded group during render, not stored.
   */
  const renderGroupTable = useCallback(
    (list: DeviceVulnFinding[]) => (
      <table className="min-w-full divide-y">
        <thead className="bg-muted/40">
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-3">{t('deviceVulnerabilitiesTab.table.cve')}</th>
            <th className="px-4 py-3">{t('deviceVulnerabilitiesTab.table.severity')}</th>
            <th className="px-4 py-3">{t('deviceVulnerabilitiesTab.table.status')}</th>
            <th className="px-4 py-3">{t('deviceVulnerabilitiesTab.table.cvss')}</th>
            <th className="px-4 py-3">{t('deviceVulnerabilitiesTab.table.risk')}</th>
            <th className="px-4 py-3">{t('deviceVulnerabilitiesTab.table.kev')}</th>
            <th className="px-4 py-3 text-right">{t('deviceVulnerabilitiesTab.table.actions')}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {list.map((v) => {
            const openFilterAndPatchable = isOpenFilter && v.patchAvailable;
            return (
              <tr key={v.id} data-testid={`vulnerability-row-${v.id}`} className="transition hover:bg-muted/40">
                <td className="px-4 py-3 text-sm font-medium">
                  {v.cveId}
                  {openFilterAndPatchable && (
                    <span
                      data-testid={`patch-available-${v.id}`}
                      className="ml-2 inline-flex items-center rounded-full bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-300"
                    >
                      {t('deviceVulnerabilitiesTab.patchAvailable')}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-sm"><SeverityBadge severity={v.severity} /></td>
                <td className="px-4 py-3 text-sm"><StatusBadge status={v.status} /></td>
                <td className="px-4 py-3 text-sm tabular-nums">{v.cvssScore === null ? '—' : formatNumber(v.cvssScore, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</td>
                <td className="px-4 py-3 text-sm tabular-nums">{v.riskScore === null ? '—' : Math.round(v.riskScore)}</td>
                <td className="px-4 py-3 text-sm">{v.knownExploited ? t('common:labels.yes') : '—'}</td>
                <td className="px-4 py-3 text-right">{rowActions(v)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    ),
    [isOpenFilter, rowActions, t],
  );

  /** Mobile card fallback for a single group's drill-down findings — mirrors `renderGroupTable`. */
  const renderGroupCards = useCallback(
    (list: DeviceVulnFinding[]) =>
      list.map((v) => {
        const openFilterAndPatchable = isOpenFilter && v.patchAvailable;
        return (
          <DataCard key={v.id}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">{v.cveId}</span>
              <SeverityBadge severity={v.severity} />
            </div>
            <div className="mt-3 space-y-2 border-t pt-3">
              <CardField label={t('deviceVulnerabilitiesTab.table.status')}><StatusBadge status={v.status} /></CardField>
              <CardField label={t('deviceVulnerabilitiesTab.table.cvss')}><span className="text-sm tabular-nums">{v.cvssScore === null ? '—' : formatNumber(v.cvssScore, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span></CardField>
              <CardField label={t('deviceVulnerabilitiesTab.table.risk')}><span className="text-sm tabular-nums">{v.riskScore === null ? '—' : Math.round(v.riskScore)}</span></CardField>
              <CardField label={t('deviceVulnerabilitiesTab.knownExploited')}><span className="text-sm">{v.knownExploited ? t('common:labels.yes') : t('common:labels.no')}</span></CardField>
              {openFilterAndPatchable && (
                <CardField label={t('deviceVulnerabilitiesTab.patch')}><span className="text-sm text-green-700 dark:text-green-300">{t('deviceVulnerabilitiesTab.available')}</span></CardField>
              )}
            </div>
            <CardActions className="flex flex-wrap justify-end gap-2">{rowActions(v)}</CardActions>
          </DataCard>
        );
      }),
    [isOpenFilter, rowActions, t],
  );

  if (error) {
    return (
      <div data-testid="device-vulnerabilities-error" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
        {error}
      </div>
    );
  }

  const statTiles: Array<{ key: keyof DeviceVulnStats; label: string }> = [
    { key: 'openTotal', label: t(/* i18n-dynamic */ `deviceVulnerabilitiesTab.stats.${STATUS_TOTAL_LABELS[statusFilter] ?? 'total'}`) },
    { key: 'critical', label: t('deviceVulnerabilitiesTab.severity.critical') },
    { key: 'high', label: t('deviceVulnerabilitiesTab.severity.high') },
    { key: 'medium', label: t('deviceVulnerabilitiesTab.severity.medium') },
    { key: 'low', label: t('deviceVulnerabilitiesTab.severity.low') },
    { key: 'unscored', label: t('deviceVulnerabilitiesTab.stats.unscored') },
    { key: 'kevFindingCount', label: t('deviceVulnerabilitiesTab.stats.kev') },
    { key: 'patchReadyFindingCount', label: t('deviceVulnerabilitiesTab.stats.patchReady') },
  ];

  return (
    <div className="space-y-4">
      <div data-testid="device-vuln-stats" className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        {statTiles.map((tile) => (
          <div key={tile.key} className="rounded-md border bg-card px-3 py-2 text-center">
            <div className="text-lg font-semibold tabular-nums">{stats[tile.key]}</div>
            <div className="text-xs text-muted-foreground">{tile.label}</div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="vulnerability-device-status-filter" className="text-sm text-muted-foreground">
          {t('deviceVulnerabilitiesTab.statusLabel')}
        </label>
        <select
          id="vulnerability-device-status-filter"
          data-testid="vulnerability-device-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        >
          <option value="open">{t('deviceVulnerabilitiesTab.status.open')}</option>
          <option value="accepted">{t('deviceVulnerabilitiesTab.status.accepted')}</option>
          <option value="mitigated">{t('deviceVulnerabilitiesTab.status.mitigated')}</option>
          <option value="patched">{t('deviceVulnerabilitiesTab.status.patched')}</option>
          <option value="all">{t('common:labels.all')}</option>
        </select>
      </div>

      {!loading && groups.length === 0 ? (
        <div data-testid="device-vulnerabilities-empty" className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
          {statusFilter === 'open'
            ? t('deviceVulnerabilitiesTab.emptyOpen')
            : statusFilter === 'all'
              ? t('deviceVulnerabilitiesTab.emptyAll')
              : t('deviceVulnerabilitiesTab.emptyStatus', {
                  status: t(/* i18n-dynamic */ `deviceVulnerabilitiesTab.status.${statusFilter}`, { defaultValue: statusFilter }),
                })}
        </div>
      ) : (
        <div className="space-y-2">
          {groups.map((g) => {
            const groupFindings = findingsByGroup.get(g.groupKey) ?? [];
            const isExpanded = expanded.has(g.groupKey);
            const patchReadyIds = groupPatchReadyIds(g.groupKey);
            return (
              <div key={g.groupKey} data-testid={`vuln-group-${g.groupKey}`} className="rounded-md border bg-card">
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <button
                      type="button"
                      data-testid={`vuln-group-toggle-${g.groupKey}`}
                      aria-expanded={isExpanded}
                      className="rounded-md border px-2 py-1 text-xs font-medium transition hover:bg-muted/60"
                      onClick={() => toggleExpanded(g.groupKey)}
                    >
                      {isExpanded
                        ? t('deviceVulnerabilitiesTab.hideFindings')
                        : t('deviceVulnerabilitiesTab.showFindings')}
                    </button>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{g.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {t('deviceVulnerabilitiesTab.groupSummary', {
                          cves: g.cveCount,
                          findings: groupFindings.length,
                          patchReady: g.patchReadyFindingCount,
                        })}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <SeverityBadge severity={g.worstSeverity} />
                    <button
                      type="button"
                      data-testid={`vuln-group-remediate-${g.groupKey}`}
                      className={`${ACTION_BTN} bg-primary text-primary-foreground hover:bg-primary/90`}
                      disabled={patchReadyIds.length === 0 || bulkBusy}
                      title={patchReadyIds.length === 0 ? t('deviceVulnerabilitiesTab.noPatchAvailable') : undefined}
                      onClick={() => void onRemediateGroup(g.groupKey)}
                    >
                      {t('deviceVulnerabilitiesTab.actions.remediateAll')}
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t p-3">
                    <ResponsiveTable
                      table={renderGroupTable(groupFindings)}
                      cards={renderGroupCards(groupFindings)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {modal && (
        <VulnActionModal
          modal={modal}
          busy={busyId === modal.id}
          onCancel={() => setModal(null)}
          onSubmit={onSubmitModal}
        />
      )}
    </div>
  );
}

function VulnActionModal({
  modal,
  busy,
  onCancel,
  onSubmit,
}: {
  modal: NonNullable<ModalState>;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: { reason?: string; acceptedUntil?: string; note?: string }) => void;
}) {
  const { t } = useTranslation('devices');
  const [text, setText] = useState('');
  const [until, setUntil] = useState('');
  const isAccept = modal.kind === 'accept';
  const canSubmit = isAccept ? text.trim().length > 0 && until.length > 0 : text.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-lg border bg-card p-5 shadow-lg" data-testid="vuln-action-modal">
        <h3 className="text-base font-semibold">
          {isAccept
            ? t('deviceVulnerabilitiesTab.modal.acceptTitle', { cve: modal.cveId })
            : t('deviceVulnerabilitiesTab.modal.mitigateTitle', { cve: modal.cveId })}
        </h3>
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-muted-foreground">
              {isAccept ? t('deviceVulnerabilitiesTab.modal.reason') : t('deviceVulnerabilitiesTab.modal.mitigationNote')}
            </span>
            <textarea
              data-testid="vuln-action-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
            />
          </label>
          {isAccept && (
            <label className="block text-sm">
              <span className="text-muted-foreground">{t('deviceVulnerabilitiesTab.modal.acceptedUntil')}</span>
              <input
                type="date"
                data-testid="vuln-action-until"
                value={until}
                min={(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })()}
                onChange={(e) => setUntil(e.target.value)}
                className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
              />
            </label>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={ACTION_BTN} onClick={onCancel} disabled={busy}>
            {t('common:actions.cancel')}
          </button>
          <button
            type="button"
            data-testid="vuln-action-submit"
            className={`${ACTION_BTN} bg-primary text-primary-foreground hover:bg-primary/90`}
            disabled={!canSubmit || busy}
            onClick={() =>
              onSubmit(
                isAccept
                  ? { reason: text.trim(), acceptedUntil: new Date(`${until}T00:00:00Z`).toISOString() }
                  : { note: text.trim() },
              )
            }
          >
            {isAccept ? t('deviceVulnerabilitiesTab.actions.acceptRisk') : t('deviceVulnerabilitiesTab.actions.markMitigated')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default DeviceVulnerabilitiesTab;
