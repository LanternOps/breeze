import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Drawer } from '../shared/Drawer';
import '@/lib/i18n';
import { SeverityBadge } from './SeverityBadge';
import { KevBadge } from './KevBadge';
import { CVSS_EXPLANATION, EPSS_EXPLANATION } from './vulnExplanations';
import { FindingStatus } from './FindingStatus';
import { VulnBulkActionModal } from './VulnBulkActionModal';
import { CreateVulnTicketModal } from './CreateVulnTicketModal';
import { usePermissions } from '../../lib/permissions';
import { handleActionError } from '../../lib/runAction';
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

type Finding = SoftwareGroupDetail['findings'][number];

type DeviceGroup = {
  deviceId: string;
  deviceName: string;
  orgName: string | null;
  findings: Finding[];
  /** deviceVulnerabilityIds of this device's OPEN findings — the selectable ones. */
  openIds: string[];
};

/** Groups the flat per-(device, CVE) finding rows by device, preserving the API's deviceName/cveId sort order. */
function groupByDevice(findings: Finding[]): DeviceGroup[] {
  const byId = new Map<string, DeviceGroup>();
  const groups: DeviceGroup[] = [];
  for (const f of findings) {
    let g = byId.get(f.deviceId);
    if (!g) {
      g = { deviceId: f.deviceId, deviceName: f.deviceName, orgName: f.orgName, findings: [], openIds: [] };
      byId.set(f.deviceId, g);
      groups.push(g);
    }
    g.findings.push(f);
    if (f.status === 'open') g.openIds.push(f.deviceVulnerabilityId);
  }
  return groups;
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
  const { t } = useTranslation('vulnerabilities');
  const [detail, setDetail] = useState<SoftwareGroupDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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
      setError(err instanceof Error ? err.message : t('softwareGroupDrawer.errors.load'));
    }
  }, [groupKey, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Collapse the device rows when switching groups — but NOT on in-place reloads
  // (e.g. after Reopen), which would yank the row the user is working in shut.
  useEffect(() => {
    setExpanded(new Set());
  }, [groupKey]);

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

  const deviceGroups = useMemo(() => groupByDevice(detail?.findings ?? []), [detail]);
  // Only OPEN findings are selectable — accepted/mitigated/patched rows go
  // through their own flows (Reopen), never the bulk actions.
  const openIds = useMemo(() => deviceGroups.flatMap((g) => g.openIds), [deviceGroups]);

  // All/none toggle for the pre-checked findings list — deselecting a large
  // pre-selection one checkbox at a time is unreasonable. Only open findings
  // participate, matching the pre-selection on load.
  const allSelected = openIds.length > 0 && openIds.every((id) => selected.has(id));
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(openIds));
  };

  const toggleDevice = (g: DeviceGroup) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const deviceAllSelected = g.openIds.every((id) => next.has(id));
      for (const id of g.openIds) {
        if (deviceAllSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const toggleExpanded = (deviceId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
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
        handleActionError(err, t('softwareGroupDrawer.errors.reopen'));
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [busy, load, onActionComplete, t],
  );

  const title = detail ? (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{detail.group.name}</span>
      <SeverityBadge severity={detail.group.worstSeverity} />
      {detail.group.kevCveCount > 0 && <KevBadge />}
    </span>
  ) : (
    t('softwareGroupDrawer.titleFallback')
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
              {t('common:actions.retry')}
            </button>
          </div>
        )}

        {detail && (
          <>
            <div className="text-sm text-muted-foreground">
              {/* Round the risk score the same way the tables do, so the same
                  number never shows two different values. */}
              {[detail.group.vendor, t('softwareGroupDrawer.summary.devices', { count: detail.group.deviceCount }), t('softwareGroupDrawer.summary.maxRisk', { risk: detail.group.maxRiskScore === null ? '—' : Math.round(detail.group.maxRiskScore) })]
                .filter(Boolean)
                .join(' · ')}
            </div>

            {detail.group.tickets.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {detail.group.tickets.map((ticket) => (
                  <a
                    key={ticket.id}
                    // TicketsPage resolves the hash by internalNumber or id.
                    href={`/tickets#${ticket.number ?? ticket.id}`}
                    data-testid={`vuln-ticket-chip-${ticket.id}`}
                    className="inline-flex items-center rounded-full border bg-muted/40 px-2.5 py-1 text-xs font-medium hover:bg-muted"
                  >
                    {ticket.number ? t('softwareGroupDrawer.tickets.number', { number: ticket.number }) : t('softwareGroupDrawer.tickets.view')}
                  </a>
                ))}
              </div>
            )}

            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('softwareGroupDrawer.sections.cves', { count: detail.cves.length })}
              </h3>
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
                        <span className="tabular-nums" title={CVSS_EXPLANATION}>
                          {t('softwareGroupDrawer.cveMeta.cvss', { score: cve.cvssScore ?? '—' })}
                        </span>
                        <span className="tabular-nums" title={EPSS_EXPLANATION}>
                          {t('softwareGroupDrawer.cveMeta.epss', { score: fmtEpss(cve.epssScore) })}
                        </span>
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
                  {t('softwareGroupDrawer.sections.devices', { deviceCount: deviceGroups.length, count: detail.findings.length })}
                </h3>
                {openIds.length > 0 && (
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                    <input
                      type="checkbox"
                      data-testid="vuln-select-all"
                      aria-label={allSelected ? t('softwareGroupDrawer.selection.deselectAllAria') : t('softwareGroupDrawer.selection.selectAllAria')}
                      checked={allSelected}
                      // Native indeterminate has no attribute form — set it via ref.
                      ref={(el) => {
                        if (el) el.indeterminate = !allSelected && selected.size > 0;
                      }}
                      onChange={toggleAll}
                      className="h-4 w-4 rounded border"
                    />
                    {t('softwareGroupDrawer.selection.selectAll', { count: openIds.length })}
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
                  {t('softwareGroupDrawer.empty.noFindings')}
                </p>
              ) : (
              <ul className="mt-2 divide-y rounded-md border">
                {deviceGroups.map((g) => {
                  const isExpanded = expanded.has(g.deviceId);
                  const deviceSelectedCount = g.openIds.filter((id) => selected.has(id)).length;
                  const deviceAllSelected = g.openIds.length > 0 && deviceSelectedCount === g.openIds.length;
                  const counts = [
                    t('softwareGroupDrawer.deviceRow.findings', { count: g.findings.length }),
                    // Only call out the open count when some findings are NOT open —
                    // "94 findings · 94 open" is noise.
                    g.openIds.length < g.findings.length
                      ? t('softwareGroupDrawer.deviceRow.open', { count: g.openIds.length })
                      : null,
                  ].filter(Boolean);
                  return (
                    <li key={g.deviceId} data-testid={`vuln-device-row-${g.deviceId}`}>
                      <div className="flex items-center gap-3 px-3 py-2 text-sm">
                        <input
                          type="checkbox"
                          data-testid={`vuln-device-check-${g.deviceId}`}
                          aria-label={t('softwareGroupDrawer.selection.selectDeviceAria', { deviceName: g.deviceName })}
                          // No open findings — nothing selectable on this device.
                          disabled={g.openIds.length === 0}
                          checked={deviceAllSelected}
                          // Native indeterminate has no attribute form — set it via ref.
                          ref={(el) => {
                            if (el) el.indeterminate = !deviceAllSelected && deviceSelectedCount > 0;
                          }}
                          onChange={() => toggleDevice(g)}
                          className="h-4 w-4 rounded border"
                        />
                        <button
                          type="button"
                          data-testid={`vuln-device-toggle-${g.deviceId}`}
                          aria-expanded={isExpanded}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          onClick={() => toggleExpanded(g.deviceId)}
                        >
                          <svg
                            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                            viewBox="0 0 20 20"
                            fill="currentColor"
                            aria-hidden="true"
                          >
                            <path
                              fillRule="evenodd"
                              d="M7.21 14.77a.75.75 0 01.02-1.06L10.94 10 7.23 6.29a.75.75 0 111.06-1.06l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-.02z"
                              clipRule="evenodd"
                            />
                          </svg>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{g.deviceName}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {[g.orgName, counts.join(' · ')].filter(Boolean).join(' · ')}
                            </span>
                          </span>
                        </button>
                      </div>
                      {isExpanded && (
                        <ul className="divide-y border-t bg-muted/20">
                          {g.findings.map((f) => (
                            <li key={f.deviceVulnerabilityId} className="flex items-center gap-3 py-2 pl-10 pr-3 text-sm">
                              {f.status === 'open' ? (
                                <input
                                  type="checkbox"
                                  data-testid={`vuln-finding-check-${f.deviceVulnerabilityId}`}
                                  aria-label={t('softwareGroupDrawer.selection.selectFindingAria', { cveId: f.cveId, deviceName: f.deviceName })}
                                  checked={selected.has(f.deviceVulnerabilityId)}
                                  onChange={() => toggle(f.deviceVulnerabilityId)}
                                  className="h-4 w-4 rounded border"
                                />
                              ) : (
                                // Spacer keeps CVE ids aligned with selectable rows.
                                <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                              )}
                              <span className="min-w-0 flex-1 truncate font-medium">{f.cveId}</span>
                              <FindingStatus status={f.status} acceptedUntil={f.acceptedUntil} />
                              <span className="text-xs">{f.patchAvailable ? t('softwareGroupDrawer.findings.patch') : '—'}</span>
                              {f.ticketId && (
                                <a
                                  href={`/tickets#${f.ticketNumber ?? f.ticketId}`}
                                  data-testid={`vuln-finding-ticket-${f.deviceVulnerabilityId}`}
                                  className="text-xs underline"
                                >
                                  {f.ticketNumber ?? t('softwareGroupDrawer.findings.ticket')}
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
                                  {t('softwareGroupDrawer.actions.reopen')}
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
              )}
            </section>
          </>
        )}
      </div>

      {detail && (
        <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
          <span className="mr-auto text-xs text-muted-foreground">{t('softwareGroupDrawer.selection.selected', { count: selectedIds.length })}</span>
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
              {t('softwareGroupDrawer.actions.remediate')}
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
              {t('softwareGroupDrawer.actions.acceptRisk')}
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
              {t('softwareGroupDrawer.actions.mitigate')}
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
              {t('softwareGroupDrawer.actions.createTicket')}
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
              void runBulk('remediate', () => remediateVuln(selectedIds), t('softwareGroupDrawer.errors.scheduleRemediation'));
            } else if (modal === 'accept') {
              void runBulk(
                'accept',
                () => bulkAcceptVulnRisk(selectedIds, { reason: payload.reason ?? '', acceptedUntil: payload.acceptedUntil ?? '' }),
                t('softwareGroupDrawer.errors.acceptRisk'),
              );
            } else {
              void runBulk('mitigate', () => bulkMitigateVulns(selectedIds, { note: payload.note ?? '' }), t('softwareGroupDrawer.errors.mitigate'));
            }
          }}
        />
      )}

      {ticketModal && detail && (
        <CreateVulnTicketModal
          findings={detail.findings.filter((f) => selected.has(f.deviceVulnerabilityId))}
          defaultTitle={t('softwareGroupDrawer.ticket.defaultTitle', { name: detail.group.name })}
          busy={busy !== null}
          onCancel={() => setTicketModal(false)}
          onSubmit={(payload) => {
            setTicketModal(false);
            void runBulk('ticket', () => createVulnTicket(selectedIds, payload), t('softwareGroupDrawer.errors.createTicket'));
          }}
        />
      )}
    </Drawer>
  );
}

export default SoftwareGroupDrawer;
