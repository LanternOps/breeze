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
  fetchCveDevices,
  remediateVuln,
  reopenVuln,
  type CveDevicesPayload,
} from '../../lib/api/vulnerabilities';

const ACTION_BTN =
  'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';

function fmtEpss(value: number | null): string {
  return value === null ? '—' : formatPercent(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// The catalog stores `references` as source-dependent jsonb — normalize defensively.
function referenceUrls(references: unknown): string[] {
  if (!Array.isArray(references)) return [];
  return references
    .map((r) =>
      typeof r === 'string'
        ? r
        : typeof r === 'object' && r !== null && 'url' in r
          ? String((r as { url: unknown }).url)
          : null,
    )
    .filter((u): u is string => typeof u === 'string' && u.startsWith('http'))
    .slice(0, 10);
}

export function CveDrawer({
  cveId,
  onClose,
  onActionComplete,
}: {
  cveId: string;
  onClose: () => void;
  onActionComplete: () => void;
}) {
  const { t } = useTranslation('vulnerabilities');
  const [payload, setPayload] = useState<CveDevicesPayload | null>(null);
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
      const p = await fetchCveDevices(cveId);
      setPayload(p);
      // Pre-select only OPEN findings — they're the actionable ones; accepted/mitigated/patched rows start unchecked.
      setSelected(new Set(p.findings.filter((f) => f.status === 'open').map((f) => f.deviceVulnerabilityId)));
    } catch (err) {
      setPayload(null);
      setError(err instanceof Error ? err.message : t('cveDrawer.errors.load'));
    }
  }, [cveId, t]);

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
  const selectedFindings = payload ? payload.findings.filter((f) => selected.has(f.deviceVulnerabilityId)) : [];
  const selectedDeviceCount = new Set(selectedFindings.map((f) => f.deviceId)).size;

  // All/none toggle for the pre-checked findings list — deselecting a large
  // pre-selection one checkbox at a time is unreasonable.
  const allSelected = payload !== null && payload.findings.length > 0 && payload.findings.every((f) => selected.has(f.deviceVulnerabilityId));
  const toggleAll = () => {
    if (!payload) return;
    setSelected(allSelected ? new Set() : new Set(payload.findings.map((f) => f.deviceVulnerabilityId)));
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
        handleActionError(err, t('cveDrawer.errors.reopen'));
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [busy, load, onActionComplete, t],
  );

  const title = payload ? (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{cveId}</span>
      <SeverityBadge severity={payload.cve.severity} />
    </span>
  ) : (
    cveId
  );

  return (
    <Drawer open onClose={onClose} title={title} width="max-w-xl" dataTestId="vuln-cve-drawer" closeDisabled={busy !== null}>
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

        {payload && (
          <>
            <section data-testid="vuln-cve-meta" className="space-y-2 text-sm">
              <p>{payload.cve.description}</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <dt className="text-muted-foreground" title={CVSS_EXPLANATION}>
                  {t('cveDrawer.meta.cvss', { version: payload.cve.cvssVersion ?? '' })}
                </dt>
                <dd className="tabular-nums">{payload.cve.cvssScore ?? '—'}</dd>
                <dt className="text-muted-foreground">{t('cveDrawer.meta.vector')}</dt>
                <dd className="break-all">{payload.cve.cvssVector ?? '—'}</dd>
                <dt className="text-muted-foreground" title={EPSS_EXPLANATION}>{t('cveDrawer.meta.epss')}</dt>
                <dd className="tabular-nums">{fmtEpss(payload.cve.epssScore)}</dd>
                <dt className="text-muted-foreground">{t('cveDrawer.meta.knownExploited')}</dt>
                <dd>{payload.cve.knownExploited ? <KevBadge /> : t('common:labels.no')}</dd>
                <dt className="text-muted-foreground">{t('cveDrawer.meta.published')}</dt>
                <dd>{payload.cve.publishedAt ? new Date(payload.cve.publishedAt).toLocaleDateString() : '—'}</dd>
                <dt className="text-muted-foreground">{t('cveDrawer.meta.modified')}</dt>
                <dd>{payload.cve.modifiedAt ? new Date(payload.cve.modifiedAt).toLocaleDateString() : '—'}</dd>
              </dl>
              {referenceUrls(payload.cve.references).length > 0 && (
                <ul className="space-y-1 text-xs">
                  {referenceUrls(payload.cve.references).map((url, i) => (
                    <li key={url}>
                      <a
                        data-testid={`vuln-cve-reference-${i}`}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="break-all text-primary hover:underline"
                      >
                        {url}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('cveDrawer.sections.devices', { count: payload.findings.length })}
                </h3>
                {payload.findings.length > 0 && (
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                    <input
                      type="checkbox"
                      data-testid="vuln-select-all"
                      aria-label={allSelected ? t('cveDrawer.selection.deselectAllAria') : t('cveDrawer.selection.selectAllAria')}
                      checked={allSelected}
                      // Native indeterminate has no attribute form — set it via ref.
                      ref={(el) => {
                        if (el) el.indeterminate = !allSelected && selected.size > 0;
                      }}
                      onChange={toggleAll}
                      className="h-4 w-4 rounded border"
                    />
                    {t('cveDrawer.selection.selectAll')}
                  </label>
                )}
              </div>
              {payload.findings.length === 0 ? (
                // Reachable when every finding was resolved (or moved out of the
                // caller's scope) between the list loading and the drawer opening.
                <p
                  data-testid="vuln-drawer-no-findings"
                  className="mt-2 rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground"
                >
                  {t('cveDrawer.empty.noFindings')}
                </p>
              ) : (
              <ul className="mt-2 divide-y rounded-md border">
                {payload.findings.map((f) => (
                  <li key={f.deviceVulnerabilityId} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      data-testid={`vuln-finding-check-${f.deviceVulnerabilityId}`}
                      aria-label={t('cveDrawer.selection.selectFindingAria', { deviceName: f.deviceName })}
                      checked={selected.has(f.deviceVulnerabilityId)}
                      onChange={() => toggle(f.deviceVulnerabilityId)}
                      className="h-4 w-4 rounded border"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{f.deviceName}</span>
                      <span className="block truncate text-xs text-muted-foreground">{f.orgName ?? ''}</span>
                    </span>
                    <FindingStatus status={f.status} acceptedUntil={f.acceptedUntil} />
                    <span className="text-xs">{f.patchAvailable ? t('cveDrawer.findings.patch') : '—'}</span>
                    {f.ticketId && (
                      <a
                        href={`/tickets#${f.ticketNumber ?? f.ticketId}`}
                        data-testid={`vuln-finding-ticket-${f.deviceVulnerabilityId}`}
                        className="text-xs underline"
                      >
                        {f.ticketNumber ?? t('cveDrawer.findings.ticket')}
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
                        {t('cveDrawer.actions.reopen')}
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

      {payload && (
        <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
          <span className="mr-auto text-xs text-muted-foreground">{t('cveDrawer.selection.selected', { count: selectedIds.length })}</span>
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
              {t('cveDrawer.actions.remediate')}
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
              {t('cveDrawer.actions.acceptRisk')}
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
              {t('cveDrawer.actions.mitigate')}
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
              {t('cveDrawer.actions.createTicket')}
            </button>
          )}
        </div>
      )}

      {modal && (
        <VulnBulkActionModal
          kind={modal}
          count={selectedIds.length}
          deviceCount={selectedDeviceCount}
          // Every finding here is the same CVE (it's in the drawer title), so
          // the summary lists device names only.
          selection={selectedFindings.map((f) => ({ deviceName: f.deviceName }))}
          busy={busy !== null}
          errorMessage={modalError}
          onCancel={() => {
            setModal(null);
            setModalError(null);
          }}
          onSubmit={(bulkPayload) => {
            setModalError(null);
            if (modal === 'remediate') {
              void runBulk('remediate', () => remediateVuln(selectedIds), t('cveDrawer.errors.scheduleRemediation'));
            } else if (modal === 'accept') {
              void runBulk(
                'accept',
                () => bulkAcceptVulnRisk(selectedIds, { reason: bulkPayload.reason ?? '', acceptedUntil: bulkPayload.acceptedUntil ?? '' }),
                t('cveDrawer.errors.acceptRisk'),
              );
            } else {
              void runBulk('mitigate', () => bulkMitigateVulns(selectedIds, { note: bulkPayload.note ?? '' }), t('cveDrawer.errors.mitigate'));
            }
          }}
        />
      )}

      {ticketModal && payload && (
        <CreateVulnTicketModal
          findings={payload.findings.filter((f) => selected.has(f.deviceVulnerabilityId))}
          defaultTitle={t('cveDrawer.ticket.defaultTitle', { cveId })}
          busy={busy !== null}
          onCancel={() => setTicketModal(false)}
          onSubmit={(ticketPayload) => {
            setTicketModal(false);
            void runBulk('ticket', () => createVulnTicket(selectedIds, ticketPayload), t('cveDrawer.errors.createTicket'));
          }}
        />
      )}
    </Drawer>
  );
}

export default CveDrawer;
