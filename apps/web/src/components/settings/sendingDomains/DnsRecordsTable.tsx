import { useTranslation } from 'react-i18next';
import type { SendingDomainDnsRecordDto } from '@breeze/shared';
import { showToast } from '../../shared/Toast';
import '@/lib/i18n';

export interface DnsRecordsTableProps {
  records: SendingDomainDnsRecordDto[];
  /** Spec §10: the "DNS can take up to 72 hours" note belongs to the wait. */
  showPendingNote: boolean;
}

const RECORD_STATUS_CLASS: Record<SendingDomainDnsRecordDto['status'], string> = {
  verified: 'text-emerald-600',
  pending: 'text-muted-foreground',
  failed: 'text-amber-600',
};

/**
 * What the partner must publish. `fqdn` is computed by the adapter, so the table
 * shows both the provider's relative label (what most DNS panels want) and the
 * full name that has to resolve — copying the wrong one is the usual reason a
 * domain never verifies.
 */
export default function DnsRecordsTable({ records, showPendingNote }: DnsRecordsTableProps) {
  const { t } = useTranslation('settings');
  if (records.length === 0) return null;

  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value);
    showToast({ type: 'success', message: t('partnerSendingDomains.recordsCopied') });
  };

  return (
    <div className="mt-3">
      <p className="text-xs font-medium">{t('partnerSendingDomains.recordsTitle')}</p>
      <div className="mt-1.5 overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left text-xs" data-testid="sending-domains-records">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">{t('partnerSendingDomains.recordsType')}</th>
              <th className="py-1 pr-3 font-medium">{t('partnerSendingDomains.recordsHost')}</th>
              <th className="py-1 pr-3 font-medium">{t('partnerSendingDomains.recordsFqdn')}</th>
              <th className="py-1 pr-3 font-medium">{t('partnerSendingDomains.recordsValue')}</th>
              <th className="py-1 pr-3 font-medium">{t('partnerSendingDomains.recordsPriority')}</th>
              <th className="py-1 pr-3 font-medium">{t('common:labels.status')}</th>
              <th className="py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {records.map((record, index) => (
              <tr key={`${record.type}-${record.fqdn}-${index}`} className="border-t align-top" data-testid={`sending-domain-record-${index}`}>
                <td className="py-1.5 pr-3 font-mono">{record.type}</td>
                <td className="py-1.5 pr-3 font-mono break-all">{record.host}</td>
                <td className="py-1.5 pr-3 font-mono break-all">{record.fqdn}</td>
                <td className="py-1.5 pr-3 font-mono break-all">{record.value}</td>
                <td className="py-1.5 pr-3 font-mono">{record.priority ?? ''}</td>
                <td className={`py-1.5 pr-3 ${RECORD_STATUS_CLASS[record.status]}`} data-testid={`sending-domain-record-${index}-status`}>
                  {record.status === 'verified'
                    ? t('partnerSendingDomains.statusVerified')
                    : record.status === 'failed'
                      ? t('partnerSendingDomains.statusFailed')
                      : t('common:states.pending')}
                </td>
                <td className="py-1.5">
                  <button
                    type="button"
                    onClick={() => copy(record.value)}
                    className="rounded-md border px-2 py-1 text-xs"
                    data-testid={`sending-domain-record-${index}-copy`}
                  >
                    {t('common:actions.copy')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showPendingNote && (
        <p className="mt-1.5 text-xs text-muted-foreground" data-testid="sending-domains-records-note">
          {t('partnerSendingDomains.recordsNote')}
        </p>
      )}
    </div>
  );
}
