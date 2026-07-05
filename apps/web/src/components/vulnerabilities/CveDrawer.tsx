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
  fetchCveDevices,
  remediateVuln,
  reopenVuln,
  type CveDevicesPayload,
} from '../../lib/api/vulnerabilities';

const ACTION_BTN =
  'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';

function fmtEpss(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
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
  const [payload, setPayload] = useState<CveDevicesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'remediate' | 'accept' | 'mitigate' | 'ticket' | 'reopen' | null>(null);
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
      const p = await fetchCveDevices(cveId);
      setPayload(p);
      // Open findings are the actionable ones — pre-select them (spec: all selected by default).
      setSelected(new Set(p.findings.filter((f) => f.status === 'open').map((f) => f.deviceVulnerabilityId)));
    } catch (err) {
      setPayload(null);
      setError(err instanceof Error ? err.message : 'Failed to load CVE');
    }
  }, [cveId]);

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

  const onReopen = useCallback(
    async (id: string) => {
      if (busy) return;
      setBusy('reopen');
      try {
        await reopenVuln(id);
        await load();
        onActionComplete();
      } catch (err) {
        handleActionError(err, 'Failed to reopen finding');
      } finally {
        setBusy(null);
      }
    },
    [busy, load, onActionComplete],
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
              Retry
            </button>
          </div>
        )}

        {payload && (
          <>
            <section data-testid="vuln-cve-meta" className="space-y-2 text-sm">
              <p>{payload.cve.description}</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <dt className="text-muted-foreground">CVSS {payload.cve.cvssVersion ?? ''}</dt>
                <dd className="tabular-nums">{payload.cve.cvssScore ?? '—'}</dd>
                <dt className="text-muted-foreground">Vector</dt>
                <dd className="break-all">{payload.cve.cvssVector ?? '—'}</dd>
                <dt className="text-muted-foreground">EPSS</dt>
                <dd className="tabular-nums">{fmtEpss(payload.cve.epssScore)}</dd>
                <dt className="text-muted-foreground">Known exploited</dt>
                <dd>{payload.cve.knownExploited ? 'KEV' : 'No'}</dd>
                <dt className="text-muted-foreground">Published</dt>
                <dd>{payload.cve.publishedAt ? new Date(payload.cve.publishedAt).toLocaleDateString() : '—'}</dd>
                <dt className="text-muted-foreground">Modified</dt>
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
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Devices ({payload.findings.length} findings)
              </h3>
              <ul className="mt-2 divide-y rounded-md border">
                {payload.findings.map((f) => (
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
                      <span className="block truncate text-xs text-muted-foreground">{f.orgName ?? ''}</span>
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
            </section>
          </>
        )}
      </div>

      {payload && (
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
          onSubmit={(bulkPayload) => {
            if (modal === 'accept') {
              void runBulk(
                'accept',
                () => bulkAcceptVulnRisk(selectedIds, { reason: bulkPayload.reason ?? '', acceptedUntil: bulkPayload.acceptedUntil ?? '' }),
                'Failed to accept risk',
              );
            } else {
              void runBulk('mitigate', () => bulkMitigateVulns(selectedIds, { note: bulkPayload.note ?? '' }), 'Failed to mitigate');
            }
          }}
        />
      )}

      {ticketModal && payload && (
        <CreateVulnTicketModal
          findings={payload.findings.filter((f) => selected.has(f.deviceVulnerabilityId))}
          defaultTitle={`Remediate ${cveId}`}
          busy={busy !== null}
          onCancel={() => setTicketModal(false)}
          onSubmit={(ticketPayload) => {
            setTicketModal(false);
            void runBulk('ticket', () => createVulnTicket(selectedIds, ticketPayload), 'Failed to create ticket');
          }}
        />
      )}
    </Drawer>
  );
}

export default CveDrawer;
