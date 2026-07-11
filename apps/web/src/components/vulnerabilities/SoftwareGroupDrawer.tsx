import { useCallback, useEffect, useRef, useState } from 'react';

import { Drawer } from '../shared/Drawer';
import { SeverityBadge } from './SeverityBadge';
import { KevBadge } from './KevBadge';
import { CVSS_EXPLANATION, EPSS_EXPLANATION } from './vulnExplanations';
import { FindingStatus } from './FindingStatus';
import { VulnBulkActionModal } from './VulnBulkActionModal';
import { CreateVulnTicketModal } from './CreateVulnTicketModal';
import { usePermissions } from '../../lib/permissions';
import { handleActionError } from '../../lib/runAction';
import { plural } from '../../lib/utils';
import { formatPercent } from '@/lib/i18n/format';
import {
  bulkAcceptVulnRisk,
  bulkMitigateVulns,
  createVulnTicket,
  fetchSoftwareGroupDetail,
  remediateVuln,
  reopenVuln,
  type SoftwareGroupDetail,
} from '../../lib/api/vulnerabilities';

const ACTION_BTN =
  'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';

function fmtEpss(value: number | null): string {
  return value === null ? '—' : formatPercent(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
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
  const [busy, setBusy] = useState<'remediate' | 'accept' | 'mitigate' | 'ticket' | 'reopen' | null>(null);
  const [modal, setModal] = useState<'remediate' | 'accept' | 'mitigate' | null>(null);
  // Inline failure message for the bulk-action modal (in addition to the
  // toast, which is easy to miss while the modal stays open).
  const [modalError, setModalError] = useState<string | null>(null);
  const [ticketModal, setTicketModal] = useState(false);
  // Synchronous double-submission guard: `busy` state lags one render behind,
  // so a rapid double-activation could fire the mutation twice without this.
  const busyRef = useRef(false);

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
      // Pre-select only OPEN findings — they're the actionable ones; accepted/mitigated/patched rows start unchecked.
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
  const selectedFindings = detail ? detail.findings.filter((f) => selected.has(f.deviceVulnerabilityId)) : [];
  const selectedDeviceCount = new Set(selectedFindings.map((f) => f.deviceId)).size;

  // All/none toggle for the pre-checked findings list — deselecting a large
  // pre-selection one checkbox at a time is unreasonable.
  const allSelected = detail !== null && detail.findings.length > 0 && detail.findings.every((f) => selected.has(f.deviceVulnerabilityId));
  const toggleAll = () => {
    if (!detail) return;
    setSelected(allSelected ? new Set() : new Set(detail.findings.map((f) => f.deviceVulnerabilityId)));
  };

  const runBulk = useCallback(
    async (kind: 'remediate' | 'accept' | 'mitigate' | 'ticket', action: () => Promise<unknown>, fallback: string) => {
      if (busy || busyRef.current || selectedIds.length === 0) return;
      busyRef.current = true;
      setBusy(kind);
      try {
        await action();
        setModal(null);
        await load();
        onActionComplete();
      } catch (err) {
        handleActionError(err, fallback);
        setModalError(err instanceof Error && err.message ? err.message : fallback);
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    // selectedIds is derived from `selected`; depend on the source set.
    [busy, selected, load, onActionComplete],
  );

  // Per-finding Reopen for accepted/mitigated rows — same behavior as the CVE
  // drawer, so a tech reviewing a waiver in the software view doesn't have to
  // re-find the finding under By CVE.
  const onReopen = useCallback(
    async (id: string) => {
      if (busy || busyRef.current) return;
      busyRef.current = true;
      setBusy('reopen');
      try {
        await reopenVuln(id);
        await load();
        onActionComplete();
      } catch (err) {
        handleActionError(err, 'Failed to reopen finding');
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [busy, load, onActionComplete],
  );

  const title = detail ? (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{detail.group.name}</span>
      <SeverityBadge severity={detail.group.worstSeverity} />
      {detail.group.kevCveCount > 0 && <KevBadge />}
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
              {/* Round the risk score the same way the tables do, so the same
                  number never shows two different values. */}
              {[detail.group.vendor, plural(detail.group.deviceCount, 'device'), `max risk ${detail.group.maxRiskScore === null ? '—' : Math.round(detail.group.maxRiskScore)}`]
                .filter(Boolean)
                .join(' · ')}
            </div>

            {detail.group.tickets.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {detail.group.tickets.map((t) => (
                  <a
                    key={t.id}
                    // TicketsPage resolves the hash by internalNumber or id.
                    href={`/tickets#${t.number ?? t.id}`}
                    data-testid={`vuln-ticket-chip-${t.id}`}
                    className="inline-flex items-center rounded-full border bg-muted/40 px-2.5 py-1 text-xs font-medium hover:bg-muted"
                  >
                    {t.number ? `Ticket ${t.number}` : 'View ticket'}
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
                      onClick={() => {
                        // Cross-nav to the CVE drawer unmounts this drawer AND the
                        // By-software tab content, so the new drawer would capture a
                        // soon-to-be-detached element as its focus-restore target and
                        // Escape would strand focus. Hand focus to the persistent
                        // "By CVE" tab first so Escape restores somewhere real. No-op
                        // when this drawer is rendered outside the fleet page.
                        document.querySelector<HTMLElement>('[data-testid="vuln-tab-cves"]')?.focus();
                        onSelectCve(cve.cveId);
                      }}
                    >
                      <span className="font-medium">{cve.cveId}</span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        <SeverityBadge severity={cve.severity} />
                        <span className="tabular-nums" title={CVSS_EXPLANATION}>CVSS {cve.cvssScore ?? '—'}</span>
                        <span className="tabular-nums" title={EPSS_EXPLANATION}>EPSS {fmtEpss(cve.epssScore)}</span>
                        {cve.knownExploited && <KevBadge />}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Devices ({plural(detail.findings.length, 'finding')})
                </h3>
                {detail.findings.length > 0 && (
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                    <input
                      type="checkbox"
                      data-testid="vuln-select-all"
                      aria-label={allSelected ? 'Deselect all findings' : 'Select all findings'}
                      checked={allSelected}
                      // Native indeterminate has no attribute form — set it via ref.
                      ref={(el) => {
                        if (el) el.indeterminate = !allSelected && selected.size > 0;
                      }}
                      onChange={toggleAll}
                      className="h-4 w-4 rounded border"
                    />
                    Select all
                  </label>
                )}
              </div>
              {detail.findings.length === 0 ? (
                // Reachable when every finding was resolved (or moved out of the
                // caller's scope) between the list loading and the drawer opening.
                <p
                  data-testid="vuln-drawer-no-findings"
                  className="mt-2 rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground"
                >
                  No device findings remain in this group — nothing to act on.
                </p>
              ) : (
              <ul className="mt-2 divide-y rounded-md border">
                {detail.findings.map((f) => (
                  <li key={f.deviceVulnerabilityId} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      data-testid={`vuln-finding-check-${f.deviceVulnerabilityId}`}
                      aria-label={`Select ${f.cveId} finding on ${f.deviceName}`}
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
                    <FindingStatus status={f.status} acceptedUntil={f.acceptedUntil} />
                    <span className="text-xs">{f.patchAvailable ? 'Patch' : '—'}</span>
                    {f.ticketId && (
                      <a
                        href={`/tickets#${f.ticketNumber ?? f.ticketId}`}
                        data-testid={`vuln-finding-ticket-${f.deviceVulnerabilityId}`}
                        className="text-xs underline"
                      >
                        {f.ticketNumber ?? 'Ticket'}
                      </a>
                    )}
                    {canAcceptRisk && (f.status === 'accepted' || f.status === 'mitigated') && (
                      <button
                        type="button"
                        data-testid={`vuln-reopen-${f.deviceVulnerabilityId}`}
                        className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
                        disabled={busy !== null}
                        onClick={() => void onReopen(f.deviceVulnerabilityId)}
                      >
                        Reopen
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              )}
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
              onClick={() => {
                setModalError(null);
                setModal('remediate');
              }}
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
              onClick={() => {
                setModalError(null);
                setModal('accept');
              }}
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
              onClick={() => {
                setModalError(null);
                setModal('mitigate');
              }}
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
          deviceCount={selectedDeviceCount}
          // Software groups span CVEs — include the CVE id per device so the
          // summary says which finding, not just which machine.
          selection={selectedFindings.map((f) => ({ deviceName: f.deviceName, cveId: f.cveId }))}
          busy={busy !== null}
          errorMessage={modalError}
          onCancel={() => {
            setModal(null);
            setModalError(null);
          }}
          onSubmit={(payload) => {
            setModalError(null);
            if (modal === 'remediate') {
              void runBulk('remediate', () => remediateVuln(selectedIds), 'Failed to schedule remediation');
            } else if (modal === 'accept') {
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
