import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { SendingDomainDto } from '@breeze/shared';
import DnsRecordsTable from './DnsRecordsTable';
import { failureCopySuffix, firstUnhealthyRecord, isInsideRetryWindow, isProvisioningSlow } from './domainView';
import '@/lib/i18n';

export interface DomainStatusPanelProps {
  domain: SendingDomainDto;
  /** capability.verifiesByDns — false in `static` mode: no records, no Check now. */
  verifiesByDns: boolean;
  busy: boolean;
  /** Clock for the two-minute provisioning notice; the tab advances it per poll. */
  nowMs: number;
  onCheckNow: (domainId: string) => void;
  onRemove: (domain: SendingDomainDto) => void;
  children?: ReactNode;
}

const STATUS_SUFFIX: Record<SendingDomainDto['status'], string> = {
  provisioning: 'statusProvisioning',
  pending: 'statusPending',
  verified: 'statusVerified',
  at_risk: 'statusAtRisk',
  failed: 'statusFailed',
  suspended: 'statusSuspended',
  removing: 'statusRemoving',
};

const STATUS_CLASS: Record<SendingDomainDto['status'], string> = {
  provisioning: 'border-muted text-muted-foreground',
  pending: 'border-muted text-muted-foreground',
  verified: 'border-emerald-500/40 text-emerald-600',
  at_risk: 'border-amber-500/40 text-amber-600',
  failed: 'border-destructive/40 text-destructive',
  suspended: 'border-destructive/40 text-destructive',
  removing: 'border-muted text-muted-foreground',
};

/**
 * One domain, every state of spec §10.
 *
 * Two deliberate supersets of that table, both additive (see the plan
 * amendments): the records table is shown whenever the provider published
 * records — a verified domain can still show what it published, all rows green,
 * minus the 72-hour wait note — and "Check now" is offered on `verified` and
 * `at_risk` as well as `pending`, which is what a partner reaches for right
 * after re-publishing a record.
 */
export default function DomainStatusPanel({
  domain, verifiesByDns, busy, nowMs, onCheckNow, onRemove, children,
}: DomainStatusPanelProps) {
  const { t } = useTranslation('settings');

  const removing = domain.status === 'removing';
  const suspended = domain.status === 'suspended';
  const sendable = domain.status === 'verified' || domain.status === 'at_risk';
  const canCheck = verifiesByDns && (domain.status === 'pending' || sendable);
  // Spec §10: Retry only INSIDE the 72 h window, which is the window in which a
  // retry keeps the same DNS records. Past it the row is about to be expired by
  // the worker and Remove is the only thing left worth offering.
  const canRetry = isInsideRetryWindow(domain, nowMs);
  const canRemove = !suspended && !removing;
  const unhealthy = firstUnhealthyRecord(domain);

  return (
    <section
      className={`rounded-lg border p-4 ${removing ? 'opacity-60' : ''}`}
      aria-busy={removing || undefined}
      data-testid={`sending-domain-row-${domain.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-sm font-medium break-all" data-testid={`sending-domain-${domain.id}-name`}>
          {domain.domain}
        </p>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_CLASS[domain.status]}`}
          data-testid={`sending-domain-${domain.id}-status`}
        >
          {t(/* i18n-dynamic */ `partnerSendingDomains.${STATUS_SUFFIX[domain.status]}`)}
        </span>
      </div>

      {domain.status === 'provisioning' && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid={`sending-domain-${domain.id}-provisioning`}>
          {t('partnerSendingDomains.statusProvisioning')}
        </p>
      )}
      {isProvisioningSlow(domain, nowMs) && (
        <p className="mt-1.5 text-xs text-amber-600" data-testid={`sending-domain-${domain.id}-provisioning-slow`}>
          {t('partnerSendingDomains.provisioningSlow')}
        </p>
      )}

      {!verifiesByDns && domain.status === 'pending' && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid={`sending-domain-${domain.id}-static-hint`}>
          {t('partnerSendingDomains.staticVerifyHint')}
        </p>
      )}

      {verifiesByDns && (
        <DnsRecordsTable records={domain.dnsRecords} showPendingNote={domain.status === 'pending'} />
      )}

      {domain.status === 'at_risk' && (
        <p
          className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid={`sending-domain-${domain.id}-at-risk`}
        >
          {t('partnerSendingDomains.atRiskBanner', {
            type: unhealthy?.type ?? '',
            fqdn: unhealthy?.fqdn ?? domain.domain,
          })}
        </p>
      )}

      {domain.status === 'failed' && (
        <p className="mt-3 text-xs text-destructive" data-testid={`sending-domain-${domain.id}-failed`}>
          {t(/* i18n-dynamic */ `partnerSendingDomains.${failureCopySuffix(domain)}`)}
        </p>
      )}

      {suspended && (
        <p className="mt-3 text-xs text-destructive" data-testid={`sending-domain-${domain.id}-suspended`}>
          {t('partnerSendingDomains.suspendedNotice')}
        </p>
      )}

      {domain.lastSendError && (
        <p className="mt-2 text-xs text-amber-600" data-testid={`sending-domain-${domain.id}-send-error`}>
          {t('partnerSendingDomains.lastSendError', { error: domain.lastSendError })}
        </p>
      )}

      {sendable && children}

      {(canCheck || canRetry || canRemove) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canCheck && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onCheckNow(domain.id)}
              className="rounded-md border px-2.5 py-1.5 text-sm disabled:opacity-50"
              data-testid={`sending-domain-${domain.id}-check`}
            >
              {t('partnerSendingDomains.checkNow')}
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onCheckNow(domain.id)}
              className="rounded-md border px-2.5 py-1.5 text-sm disabled:opacity-50"
              data-testid={`sending-domain-${domain.id}-retry`}
            >
              {t('partnerSendingDomains.retry')}
            </button>
          )}
          {canRemove && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onRemove(domain)}
              className="rounded-md border px-2.5 py-1.5 text-sm text-destructive disabled:opacity-50"
              data-testid={`sending-domain-${domain.id}-remove`}
            >
              {t('common:actions.remove')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
