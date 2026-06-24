import { useCallback, useEffect, useMemo, useState } from 'react';

import { ResponsiveTable, DataCard, CardField, CardActions } from '../shared/ResponsiveTable';
import { handleActionError } from '../../lib/runAction';
import { usePermissions } from '../../lib/permissions';
import {
  fetchDeviceVulnerabilities,
  remediateVuln,
  acceptVulnRisk,
  mitigateVuln,
  reopenVuln,
  type DeviceVulnerabilityItem,
} from '../../lib/api/vulnerabilities';

const SEVERITY_BADGES: Record<string, { label: string; className: string }> = {
  critical: { label: 'Critical', className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  high: { label: 'High', className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300' },
  medium: { label: 'Medium', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  low: { label: 'Low', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
};

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  open: { label: 'Open', className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  accepted: { label: 'Accepted', className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
  mitigated: { label: 'Mitigated', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
  patched: { label: 'Patched', className: 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300' },
};

function StatusBadge({ status }: { status: string }) {
  const badge = STATUS_BADGES[status?.toLowerCase()] ?? {
    label: status ?? 'Unknown',
    className: 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${badge.className}`}>
      {badge.label}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string | null }) {
  const badge = SEVERITY_BADGES[severity?.toLowerCase() ?? ''] ?? {
    label: severity ?? 'Unknown',
    className: 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${badge.className}`}>
      {badge.label}
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

export function DeviceVulnerabilitiesTab({ deviceId }: DeviceVulnerabilitiesTabProps) {
  const [items, setItems] = useState<DeviceVulnerabilityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [statusFilter, setStatusFilter] = useState<string>('open');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const { can } = usePermissions();
  const canAcceptRisk = can('vulnerabilities', 'accept_risk');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchDeviceVulnerabilities(deviceId, { status: statusFilter });
      setItems(res.items);
      setSelectedIds(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load vulnerabilities');
    } finally {
      setLoading(false);
    }
  }, [deviceId, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRemediate = useCallback(async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    try {
      await remediateVuln([id]);
      await load();
    } catch (err) {
      handleActionError(err, 'Failed to schedule remediation');
    } finally {
      setBusyId(null);
    }
  }, [busyId, load]);

  const onBulkRemediate = useCallback(async () => {
    if (bulkBusy || selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      await remediateVuln([...selectedIds]);
      setSelectedIds(new Set());
      await load();
    } catch (err) {
      handleActionError(err, 'Failed to schedule remediation');
    } finally {
      setBulkBusy(false);
    }
  }, [bulkBusy, selectedIds, load]);

  const onReopen = useCallback(async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    try {
      await reopenVuln(id);
      await load();
    } catch (err) {
      handleActionError(err, 'Failed to reopen finding');
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
      handleActionError(err, modal.kind === 'accept' ? 'Failed to accept risk' : 'Failed to mitigate');
    } finally {
      setBusyId(null);
    }
  }, [modal, load]);

  const toggleSelect = useCallback((id: string, canSelect: boolean) => {
    if (!canSelect) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const rowActions = useCallback(
    (v: DeviceVulnerabilityItem) => {
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
                Reopen
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
            title={v.patchAvailable ? undefined : 'No patch available'}
            onClick={() => void onRemediate(v.id)}
          >
            Remediate
          </button>
          {canAcceptRisk && (
            <button
              type="button"
              data-testid={`accept-${v.id}`}
              className={ACTION_BTN}
              disabled={busyId === v.id}
              onClick={() => setModal({ kind: 'accept', id: v.id, cveId: v.cveId })}
            >
              Accept risk
            </button>
          )}
          <button
            type="button"
            data-testid={`mitigate-${v.id}`}
            className={ACTION_BTN}
            disabled={busyId === v.id}
            onClick={() => setModal({ kind: 'mitigate', id: v.id, cveId: v.cveId })}
          >
            Mitigate
          </button>
        </div>
      );
    },
    [busyId, onRemediate, onReopen, canAcceptRisk],
  );

  const isOpenFilter = statusFilter === 'open';

  const table = useMemo(
    () => (
      <table className="min-w-full divide-y">
        <thead className="bg-muted/40">
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {isOpenFilter && <th className="px-4 py-3" />}
            <th className="px-4 py-3">CVE</th>
            <th className="px-4 py-3">Severity</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">CVSS</th>
            <th className="px-4 py-3">Risk</th>
            <th className="px-4 py-3">KEV</th>
            <th className="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((v) => {
            const canSelect = isOpenFilter && v.patchAvailable;
            return (
              <tr key={v.id} data-testid={`vulnerability-row-${v.id}`} className="transition hover:bg-muted/40">
                {isOpenFilter && (
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      data-testid={`vuln-select-${v.id}`}
                      checked={selectedIds.has(v.id)}
                      disabled={!canSelect}
                      onChange={() => toggleSelect(v.id, canSelect)}
                      aria-label={`Select ${v.cveId}`}
                    />
                  </td>
                )}
                <td className="px-4 py-3 text-sm font-medium">
                  {v.cveId}
                  {isOpenFilter && v.patchAvailable && (
                    <span
                      data-testid={`patch-available-${v.id}`}
                      className="ml-2 inline-flex items-center rounded-full bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-300"
                    >
                      Patch available
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-sm"><SeverityBadge severity={v.severity} /></td>
                <td className="px-4 py-3 text-sm"><StatusBadge status={v.status} /></td>
                <td className="px-4 py-3 text-sm tabular-nums">{v.cvssScore === null ? '—' : v.cvssScore.toFixed(1)}</td>
                <td className="px-4 py-3 text-sm tabular-nums">{v.riskScore === null ? '—' : Math.round(v.riskScore)}</td>
                <td className="px-4 py-3 text-sm">{v.knownExploited ? 'Yes' : '—'}</td>
                <td className="px-4 py-3 text-right">{rowActions(v)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    ),
    [items, rowActions, selectedIds, toggleSelect, isOpenFilter],
  );

  const cards = useMemo(
    () =>
      items.map((v) => (
        <DataCard key={v.id}>
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">{v.cveId}</span>
            <SeverityBadge severity={v.severity} />
          </div>
          <div className="mt-3 space-y-2 border-t pt-3">
            <CardField label="Status"><StatusBadge status={v.status} /></CardField>
            <CardField label="CVSS"><span className="text-sm tabular-nums">{v.cvssScore === null ? '—' : v.cvssScore.toFixed(1)}</span></CardField>
            <CardField label="Risk"><span className="text-sm tabular-nums">{v.riskScore === null ? '—' : Math.round(v.riskScore)}</span></CardField>
            <CardField label="Known exploited"><span className="text-sm">{v.knownExploited ? 'Yes' : 'No'}</span></CardField>
            {isOpenFilter && v.patchAvailable && (
              <CardField label="Patch"><span className="text-sm text-green-700 dark:text-green-300">Available</span></CardField>
            )}
          </div>
          <CardActions className="flex flex-wrap justify-end gap-2">{rowActions(v)}</CardActions>
        </DataCard>
      )),
    [items, rowActions, isOpenFilter],
  );

  if (error) {
    return (
      <div data-testid="device-vulnerabilities-error" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <label htmlFor="vulnerability-device-status-filter" className="text-sm text-muted-foreground">
          Status
        </label>
        <select
          id="vulnerability-device-status-filter"
          data-testid="vulnerability-device-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        >
          <option value="open">Open</option>
          <option value="accepted">Accepted</option>
          <option value="mitigated">Mitigated</option>
          <option value="patched">Patched</option>
          <option value="all">All</option>
        </select>
      </div>

      {isOpenFilter && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="vuln-bulk-remediate"
            className={`${ACTION_BTN} bg-primary text-primary-foreground hover:bg-primary/90`}
            disabled={selectedIds.size === 0 || bulkBusy}
            onClick={() => void onBulkRemediate()}
          >
            Remediate selected ({selectedIds.size})
          </button>
        </div>
      )}

      {!loading && items.length === 0 ? (
        <div data-testid="device-vulnerabilities-empty" className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
          {statusFilter === 'open'
            ? 'No open vulnerabilities detected on this device.'
            : statusFilter === 'all'
              ? 'No vulnerabilities detected on this device.'
              : `No ${statusFilter} vulnerabilities on this device.`}
        </div>
      ) : (
        <ResponsiveTable table={table} cards={cards} />
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
  const [text, setText] = useState('');
  const [until, setUntil] = useState('');
  const isAccept = modal.kind === 'accept';
  const canSubmit = isAccept ? text.trim().length > 0 && until.length > 0 : text.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-lg border bg-card p-5 shadow-lg" data-testid="vuln-action-modal">
        <h3 className="text-base font-semibold">
          {isAccept ? 'Accept risk' : 'Mark mitigated'} — {modal.cveId}
        </h3>
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-muted-foreground">{isAccept ? 'Reason' : 'Mitigation note'}</span>
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
              <span className="text-muted-foreground">Accepted until</span>
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
            Cancel
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
            {isAccept ? 'Accept risk' : 'Mark mitigated'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default DeviceVulnerabilitiesTab;
