import { useCallback, useEffect, useState } from 'react';

import { Drawer } from '../shared/Drawer';
import { SeverityBadge } from './SeverityBadge';
import { VulnBulkActionModal } from './VulnBulkActionModal';
import { CreateVulnTicketModal } from './CreateVulnTicketModal';
import { usePermissions } from '../../lib/permissions';
import { handleActionError } from '../../lib/runAction';
import {
  bulkAcceptVulnRisk,
  bulkMitigateVulns,
  createVulnTicket,
  fetchSoftwareGroupDetail,
  remediateVuln,
  type SoftwareGroupDetail,
} from '../../lib/api/vulnerabilities';

const ACTION_BTN =
  'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';

function fmtEpss(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

export function SoftwareGroupDrawer({
  groupKey,
  onClose,
  onActionComplete,
  onSelectCve,
}: {
  groupKey: string;
  onClose: () => void;
  onActionComplete: () => void;
  onSelectCve: (cveId: string) => void;
}) {
  const [detail, setDetail] = useState<SoftwareGroupDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'remediate' | 'accept' | 'mitigate' | 'ticket' | null>(null);
  const [modal, setModal] = useState<'accept' | 'mitigate' | null>(null);
  const [ticketModal, setTicketModal] = useState(false);

  const { can } = usePermissions();
  const canRemediate = can('devices', 'execute');
  const canAcceptRisk = can('vulnerabilities', 'accept_risk');
  const canMitigate = can('devices', 'write');
  const canCreateTicket = can('tickets', 'write');

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await fetchSoftwareGroupDetail(groupKey);
      setDetail(d);
      // Open findings are the actionable ones — pre-select them (spec: all selected by default).
      setSelected(new Set(d.findings.filter((f) => f.status === 'open').map((f) => f.deviceVulnerabilityId)));
    } catch (err) {
      setDetail(null);
      setError(err instanceof Error ? err.message : 'Failed to load software group');
    }
  }, [groupKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedIds = [...selected];

  const runBulk = useCallback(
    async (kind: 'remediate' | 'accept' | 'mitigate' | 'ticket', action: () => Promise<unknown>, fallback: string) => {
      if (busy || selectedIds.length === 0) return;
      setBusy(kind);
      try {
        await action();
        setModal(null);
        await load();
        onActionComplete();
      } catch (err) {
        handleActionError(err, fallback);
      } finally {
        setBusy(null);
      }
    },
    // selectedIds is derived from `selected`; depend on the source set.
    [busy, selected, load, onActionComplete],
  );

  const title = detail ? (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{detail.group.name}</span>
      <SeverityBadge severity={detail.group.worstSeverity} />
      {detail.group.kevCveCount > 0 && (
        <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
          KEV
        </span>
      )}
    </span>
  ) : (
    'Software group'
  );

  return (
    <Drawer open onClose={onClose} title={title} width="max-w-xl" dataTestId="vuln-software-drawer" closeDisabled={busy !== null}>
      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {error && (
          <div
            data-testid="vuln-drawer-error"
            className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300"
          >
            <p>{error}</p>
            <button type="button" data-testid="vuln-drawer-retry" className="mt-2 text-sm font-medium underline" onClick={() => void load()}>
              Retry
            </button>
          </div>
        )}

        {detail && (
          <>
            <div className="text-sm text-muted-foreground">
              {[detail.group.vendor, `${detail.group.deviceCount} devices`, `max risk ${detail.group.maxRiskScore ?? '—'}`]
                .filter(Boolean)
                .join(' · ')}
            </div>

            {detail.group.ticketIds.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {detail.group.ticketIds.map((tid) => (
                  <a
                    key={tid}
                    href={`/tickets#${tid}`}
                    data-testid={`vuln-ticket-chip-${tid}`}
                    className="inline-flex items-center rounded-full border bg-muted/40 px-2.5 py-1 text-xs font-medium hover:bg-muted"
                  >
                    Ticket · {tid.slice(0, 8)}
                  </a>
                ))}
              </div>
            )}

            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">CVEs ({detail.cves.length})</h3>
              <ul className="mt-2 divide-y rounded-md border">
                {detail.cves.map((cve) => (
                  <li key={cve.cveId}>
                    <button
                      type="button"
                      data-testid={`vuln-drawer-cve-${cve.cveId}`}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40"
                      onClick={() => onSelectCve(cve.cveId)}
                    >
                      <span className="font-medium">{cve.cveId}</span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        <SeverityBadge severity={cve.severity} />
                        <span className="tabular-nums">CVSS {cve.cvssScore ?? '—'}</span>
                        <span className="tabular-nums">EPSS {fmtEpss(cve.epssScore)}</span>
                        {cve.knownExploited && <span className="font-semibold text-red-600">KEV</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Devices ({detail.findings.length} findings)
              </h3>
              <ul className="mt-2 divide-y rounded-md border">
                {detail.findings.map((f) => (
                  <li key={f.deviceVulnerabilityId} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      data-testid={`vuln-finding-check-${f.deviceVulnerabilityId}`}
                      checked={selected.has(f.deviceVulnerabilityId)}
                      onChange={() => toggle(f.deviceVulnerabilityId)}
                      className="h-4 w-4 rounded border"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{f.deviceName}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[f.orgName, f.cveId].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="text-xs capitalize text-muted-foreground">{f.status}</span>
                    <span className="text-xs">{f.patchAvailable ? 'Patch' : '—'}</span>
                    {f.ticketId && (
                      <a
                        href={`/tickets#${f.ticketId}`}
                        data-testid={`vuln-finding-ticket-${f.deviceVulnerabilityId}`}
                        className="text-xs underline"
                      >
                        Ticket
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>

      {detail && (
        <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
          <span className="mr-auto text-xs text-muted-foreground">{selectedIds.length} selected</span>
          {canRemediate && (
            <button
              type="button"
              data-testid="vuln-action-remediate"
              className={`${ACTION_BTN} bg-primary text-primary-foreground hover:bg-primary/90`}
              disabled={busy !== null || selectedIds.length === 0}
              onClick={() => void runBulk('remediate', () => remediateVuln(selectedIds), 'Failed to schedule remediation')}
            >
              Remediate
            </button>
          )}
          {canAcceptRisk && (
            <button
              type="button"
              data-testid="vuln-action-accept"
              className={ACTION_BTN}
              disabled={busy !== null || selectedIds.length === 0}
              onClick={() => setModal('accept')}
            >
              Accept risk
            </button>
          )}
          {canMitigate && (
            <button
              type="button"
              data-testid="vuln-action-mitigate"
              className={ACTION_BTN}
              disabled={busy !== null || selectedIds.length === 0}
              onClick={() => setModal('mitigate')}
            >
              Mitigate
            </button>
          )}
          {canCreateTicket && (
            <button
              type="button"
              data-testid="vuln-action-ticket"
              className={ACTION_BTN}
              disabled={busy !== null || selectedIds.length === 0}
              onClick={() => setTicketModal(true)}
            >
              Create ticket
            </button>
          )}
        </div>
      )}

      {modal && (
        <VulnBulkActionModal
          kind={modal}
          count={selectedIds.length}
          busy={busy !== null}
          onCancel={() => setModal(null)}
          onSubmit={(payload) => {
            if (modal === 'accept') {
              void runBulk(
                'accept',
                () => bulkAcceptVulnRisk(selectedIds, { reason: payload.reason ?? '', acceptedUntil: payload.acceptedUntil ?? '' }),
                'Failed to accept risk',
              );
            } else {
              void runBulk('mitigate', () => bulkMitigateVulns(selectedIds, { note: payload.note ?? '' }), 'Failed to mitigate');
            }
          }}
        />
      )}

      {ticketModal && detail && (
        <CreateVulnTicketModal
          findings={detail.findings.filter((f) => selected.has(f.deviceVulnerabilityId))}
          defaultTitle={`Remediate ${detail.group.name}`}
          busy={busy !== null}
          onCancel={() => setTicketModal(false)}
          onSubmit={(payload) => {
            setTicketModal(false);
            void runBulk('ticket', () => createVulnTicket(selectedIds, payload), 'Failed to create ticket');
          }}
        />
      )}
    </Drawer>
  );
}

export default SoftwareGroupDrawer;
