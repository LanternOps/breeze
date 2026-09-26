import { useCallback, useEffect, useRef, useState } from 'react';
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
  fetchSoftwareGroupDeviceFindings,
  remediateVuln,
  reopenVuln,
  type GroupDevice,
  type GroupFinding,
  type SoftwareGroupDetail,
} from '../../lib/api/vulnerabilities';
import { useStableT } from '@/lib/i18n/useStableT';

const ACTION_BTN =
  'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';

const SECTION_HEADING = 'text-xs font-semibold uppercase tracking-wide text-muted-foreground';

function fmtEpss(value: number | null): string {
  return value === null ? '—' : formatPercent(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Per-device drill-down state: findings load lazily the first time a device is expanded. */
type Expansion = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; findings: GroupFinding[] };

/**
 * Software-group drawer (#2262). The remediation unit is the DEVICE: one
 * outdated app on 14 devices is 14 rows, not 14 × N-CVE rows. Each device row
 * carries its open finding ids; bulk actions send exactly those ids for the
 * selected devices (never a server-side re-derivation), so what the operator
 * confirmed is what runs. Per-CVE findings for a device load on expand.
 */
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
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const [detail, setDetail] = useState<SoftwareGroupDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Selection is by DEVICE id; only devices with open findings are selectable.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Record<string, Expansion>>({});
  const [busy, setBusy] = useState<'remediate' | 'accept' | 'mitigate' | 'ticket' | 'reopen' | null>(null);
  const [modal, setModal] = useState<'remediate' | 'accept' | 'mitigate' | null>(null);
  // Inline failure message for the bulk-action modal (in addition to the
  // toast, which is easy to miss while the modal stays open).
  const [modalError, setModalError] = useState<string | null>(null);
  const [ticketModal, setTicketModal] = useState(false);
  // Synchronous double-submission guard: `busy` state lags one render behind,
  // so a rapid double-activation could fire the mutation twice without this.
  const busyRef = useRef(false);
  // Latest expansion map, read by `load` without re-creating it on every toggle.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const { can } = usePermissions();
  const canRemediate = can('devices', 'execute');
  const canAcceptRisk = can('vulnerabilities', 'accept_risk');
  const canMitigate = can('devices', 'write');
  const canCreateTicket = can('tickets', 'write');

  const loadDeviceFindings = useCallback(
    async (deviceId: string) => {
      setExpanded((prev) => ({ ...prev, [deviceId]: { status: 'loading' } }));
      try {
        const findings = await fetchSoftwareGroupDeviceFindings(groupKey, deviceId);
        setExpanded((prev) => (deviceId in prev ? { ...prev, [deviceId]: { status: 'ready', findings } } : prev));
      } catch (err) {
        const message = err instanceof Error && err.message ? err.message : stableT('softwareGroupDrawer.device.loadError');
        setExpanded((prev) => (deviceId in prev ? { ...prev, [deviceId]: { status: 'error', message } } : prev));
      }
    },
    [groupKey, stableT],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await fetchSoftwareGroupDetail(groupKey);
      setDetail(d);
      // Pre-select devices with OPEN findings — they're the actionable ones.
      setSelected(new Set(d.devices.filter((dev) => dev.openFindingIds.length > 0).map((dev) => dev.deviceId)));
      // Refresh any open drill-downs so statuses match the reloaded rollup.
      const stillPresent = new Set(d.devices.map((dev) => dev.deviceId));
      const open = Object.keys(expandedRef.current);
      setExpanded((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => stillPresent.has(id))));
      for (const deviceId of open) {
        if (stillPresent.has(deviceId)) void loadDeviceFindings(deviceId);
      }
    } catch (err) {
      setDetail(null);
      setError(err instanceof Error ? err.message : stableT('softwareGroupDrawer.errors.load'));
    }
  }, [groupKey, stableT, loadDeviceFindings]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleExpanded = (deviceId: string) => {
    if (deviceId in expanded) {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[deviceId];
        return next;
      });
    } else {
      void loadDeviceFindings(deviceId);
    }
  };

  const toggle = (deviceId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  };

  const actionableDevices = detail ? detail.devices.filter((d) => d.openFindingIds.length > 0) : [];
  const selectedDevices = actionableDevices.filter((d) => selected.has(d.deviceId));
  // The exact ids an action will send: the selected devices' open findings as
  // loaded. Never widened server-side.
  const selectedIds = selectedDevices.flatMap((d) => d.openFindingIds);

  const allSelected = actionableDevices.length > 0 && selectedDevices.length === actionableDevices.length;
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(actionableDevices.map((d) => d.deviceId)));
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
    // selectedIds is derived from `selected` + `detail`; depend on the sources.
    [busy, selected, detail, load, onActionComplete],
  );

  // Per-finding Reopen for accepted/mitigated rows in a device drill-down —
  // same behavior as the CVE drawer.
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

  const deviceMeta = (d: GroupDevice): string =>
    [
      d.orgName,
      d.installedVersions.join(', ') || null,
      t('softwareGroupDrawer.device.openOf', { open: d.openFindingCount, count: d.cveCount }),
      d.acceptedFindingCount > 0 ? t('softwareGroupDrawer.device.accepted', { count: d.acceptedFindingCount }) : null,
      d.mitigatedFindingCount > 0 ? t('softwareGroupDrawer.device.mitigated', { count: d.mitigatedFindingCount }) : null,
      d.patchedFindingCount > 0 ? t('softwareGroupDrawer.device.patched', { count: d.patchedFindingCount }) : null,
    ]
      .filter(Boolean)
      .join(' · ');

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
            {/* Lead with the remediation-shaped story (#2262): how many devices
                need the update. The CVE fan-out is context, not the headline. */}
            <div data-testid="vuln-drawer-headline">
              <p className="text-base font-semibold">
                {actionableDevices.length > 0
                  ? t('softwareGroupDrawer.headline.needUpdating', { count: actionableDevices.length })
                  : t('softwareGroupDrawer.headline.nothingOpen')}
              </p>
              <p className="text-sm text-muted-foreground">
                {[
                  detail.group.vendor,
                  detail.group.deviceCount === 1
                    ? t('softwareGroupDrawer.headline.scopeSingleDevice', { count: detail.group.cveCount })
                    : t('softwareGroupDrawer.headline.scope', { count: detail.group.cveCount, devices: detail.group.deviceCount }),
                  // Round the risk score the same way the tables do, so the same
                  // number never shows two different values.
                  t('softwareGroupDrawer.summary.maxRisk', { risk: detail.group.maxRiskScore === null ? '—' : Math.round(detail.group.maxRiskScore) }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
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
              <div className="flex items-center justify-between gap-2">
                <h3 className={SECTION_HEADING}>{t('softwareGroupDrawer.sections.devicesHeading', { count: detail.devices.length })}</h3>
                {actionableDevices.length > 0 && (
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                    <input
                      type="checkbox"
                      data-testid="vuln-select-all"
                      aria-label={allSelected ? t('softwareGroupDrawer.selection.deselectAllAria') : t('softwareGroupDrawer.selection.selectAllAria')}
                      checked={allSelected}
                      // Native indeterminate has no attribute form — set it via ref.
                      ref={(el) => {
                        if (el) el.indeterminate = !allSelected && selectedDevices.length > 0;
                      }}
                      onChange={toggleAll}
                      className="h-4 w-4 rounded border"
                    />
                    {t('softwareGroupDrawer.selection.selectAll')}
                  </label>
                )}
              </div>
              {detail.devices.length === 0 ? (
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
                  {detail.devices.map((d) => {
                    const expansion = expanded[d.deviceId];
                    const actionable = d.openFindingIds.length > 0;
                    return (
                      <li key={d.deviceId} data-testid={`vuln-device-row-${d.deviceId}`} className="px-3 py-2 text-sm">
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            data-testid={`vuln-device-check-${d.deviceId}`}
                            aria-label={t('softwareGroupDrawer.selection.selectDeviceAria', { deviceName: d.deviceName })}
                            checked={actionable && selected.has(d.deviceId)}
                            disabled={!actionable}
                            onChange={() => toggle(d.deviceId)}
                            className="h-4 w-4 rounded border disabled:opacity-40"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{d.deviceName}</span>
                            <span className="block truncate text-xs text-muted-foreground">{deviceMeta(d)}</span>
                          </span>
                          {d.worstOpenSeverity && <SeverityBadge severity={d.worstOpenSeverity} />}
                          {d.patchReadyFindingCount > 0 && (
                            <span className="text-xs">{t('softwareGroupDrawer.device.patchReady', { count: d.patchReadyFindingCount })}</span>
                          )}
                          {d.tickets.map((ticket) => (
                            <a
                              key={ticket.id}
                              href={`/tickets#${ticket.number ?? ticket.id}`}
                              data-testid={`vuln-device-ticket-${d.deviceId}-${ticket.id}`}
                              className="text-xs underline"
                            >
                              {ticket.number ?? t('softwareGroupDrawer.findings.ticket')}
                            </a>
                          ))}
                          <button
                            type="button"
                            data-testid={`vuln-device-expand-${d.deviceId}`}
                            aria-expanded={expansion !== undefined}
                            aria-label={
                              expansion !== undefined
                                ? t('softwareGroupDrawer.device.collapseAria', { deviceName: d.deviceName })
                                : t('softwareGroupDrawer.device.expandAria', { deviceName: d.deviceName })
                            }
                            className="rounded px-1.5 text-xs font-medium text-primary hover:underline"
                            onClick={() => toggleExpanded(d.deviceId)}
                          >
                            {expansion !== undefined ? t('softwareGroupDrawer.device.hide') : t('softwareGroupDrawer.device.show')}
                          </button>
                        </div>
                        {expansion?.status === 'loading' && (
                          <p className="mt-2 pl-7 text-xs text-muted-foreground">{t('softwareGroupDrawer.device.loading')}</p>
                        )}
                        {expansion?.status === 'error' && (
                          <p data-testid={`vuln-device-findings-error-${d.deviceId}`} className="mt-2 pl-7 text-xs text-red-600 dark:text-red-400">
                            {expansion.message}
                          </p>
                        )}
                        {expansion?.status === 'ready' && (
                          <ul data-testid={`vuln-device-findings-${d.deviceId}`} className="mt-2 space-y-1 border-l pl-4 ml-2">
                            {expansion.findings.map((f) => (
                              <li key={f.deviceVulnerabilityId} className="flex items-center gap-3 text-xs">
                                <span className="min-w-0 flex-1 truncate font-medium">{f.cveId}</span>
                                <FindingStatus status={f.status} acceptedUntil={f.acceptedUntil} />
                                <span>{f.patchAvailable ? t('softwareGroupDrawer.findings.patch') : '—'}</span>
                                {f.ticketId && (
                                  <a
                                    href={`/tickets#${f.ticketNumber ?? f.ticketId}`}
                                    data-testid={`vuln-finding-ticket-${f.deviceVulnerabilityId}`}
                                    className="underline"
                                  >
                                    {f.ticketNumber ?? t('softwareGroupDrawer.findings.ticket')}
                                  </a>
                                )}
                                {canAcceptRisk && (f.status === 'accepted' || f.status === 'mitigated') && (
                                  <button
                                    type="button"
                                    data-testid={`vuln-reopen-${f.deviceVulnerabilityId}`}
                                    className="font-medium text-primary hover:underline disabled:opacity-50"
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

            {detail.versions.length > 0 && (
              <section data-testid="vuln-drawer-versions">
                <h3 className={SECTION_HEADING}>{t('softwareGroupDrawer.sections.versions')}</h3>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {detail.versions.map((v) => (
                    <li
                      key={v.version}
                      data-testid={`vuln-version-${v.version}`}
                      className="rounded-md border px-2 py-1 text-xs"
                    >
                      <span className="font-medium tabular-nums">{v.version}</span>
                      <span className="ml-1.5 text-muted-foreground">{t('softwareGroupDrawer.versions.deviceCount', { count: v.deviceCount })}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <h3 className={SECTION_HEADING}>{t('softwareGroupDrawer.sections.cves', { count: detail.cves.length })}</h3>
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
                      <span className="min-w-0">
                        <span className="block font-medium">{cve.cveId}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t('softwareGroupDrawer.cveMeta.devicesOpen', { open: cve.openDeviceCount, count: cve.deviceCount })}
                        </span>
                      </span>
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
          </>
        )}
      </div>

      {detail && (
        <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
          <span className="mr-auto text-xs text-muted-foreground">
            {t('softwareGroupDrawer.selection.selectedDevices', { count: selectedDevices.length, findings: selectedIds.length })}
          </span>
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
          deviceCount={selectedDevices.length}
          selection={selectedDevices.map((d) => ({ deviceName: d.deviceName }))}
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
          findings={selectedDevices.flatMap((d) => d.openFindingIds.map(() => ({ orgId: d.orgId })))}
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
