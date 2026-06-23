import { useCallback, useEffect, useMemo, useState } from 'react';

import { ResponsiveTable, DataCard, CardField, CardActions } from '../shared/ResponsiveTable';
import { handleActionError } from '../../lib/runAction';
import {
  fetchDeviceVulnerabilities,
  remediateVuln,
  acceptVulnRisk,
  mitigateVuln,
  type DeviceVulnerabilityItem,
} from '../../lib/api/vulnerabilities';

const SEVERITY_BADGES: Record<string, { label: string; className: string }> = {
  critical: { label: 'Critical', className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  high: { label: 'High', className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300' },
  medium: { label: 'Medium', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  low: { label: 'Low', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
};

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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchDeviceVulnerabilities(deviceId, { status: 'open' });
      setItems(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load vulnerabilities');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

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

  const rowActions = useCallback(
    (v: DeviceVulnerabilityItem) => (
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          data-testid={`remediate-${v.id}`}
          className={ACTION_BTN}
          disabled={busyId === v.id}
          onClick={() => void onRemediate(v.id)}
        >
          Remediate
        </button>
        <button
          type="button"
          data-testid={`accept-${v.id}`}
          className={ACTION_BTN}
          disabled={busyId === v.id}
          onClick={() => setModal({ kind: 'accept', id: v.id, cveId: v.cveId })}
        >
          Accept risk
        </button>
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
    ),
    [busyId, onRemediate],
  );

  const table = useMemo(
    () => (
      <table className="min-w-full divide-y">
        <thead className="bg-muted/40">
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-3">CVE</th>
            <th className="px-4 py-3">Severity</th>
            <th className="px-4 py-3">CVSS</th>
            <th className="px-4 py-3">Risk</th>
            <th className="px-4 py-3">KEV</th>
            <th className="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((v) => (
            <tr key={v.id} data-testid={`vulnerability-row-${v.id}`} className="transition hover:bg-muted/40">
              <td className="px-4 py-3 text-sm font-medium">{v.cveId}</td>
              <td className="px-4 py-3 text-sm"><SeverityBadge severity={v.severity} /></td>
              <td className="px-4 py-3 text-sm tabular-nums">{v.cvssScore === null ? '—' : v.cvssScore.toFixed(1)}</td>
              <td className="px-4 py-3 text-sm tabular-nums">{v.riskScore === null ? '—' : Math.round(v.riskScore)}</td>
              <td className="px-4 py-3 text-sm">{v.knownExploited ? 'Yes' : '—'}</td>
              <td className="px-4 py-3 text-right">{rowActions(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ),
    [items, rowActions],
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
            <CardField label="CVSS"><span className="text-sm tabular-nums">{v.cvssScore === null ? '—' : v.cvssScore.toFixed(1)}</span></CardField>
            <CardField label="Risk"><span className="text-sm tabular-nums">{v.riskScore === null ? '—' : Math.round(v.riskScore)}</span></CardField>
            <CardField label="Known exploited"><span className="text-sm">{v.knownExploited ? 'Yes' : 'No'}</span></CardField>
          </div>
          <CardActions className="flex flex-wrap justify-end gap-2">{rowActions(v)}</CardActions>
        </DataCard>
      )),
    [items, rowActions],
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
      {!loading && items.length === 0 ? (
        <div data-testid="device-vulnerabilities-empty" className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
          No open vulnerabilities detected on this device.
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
