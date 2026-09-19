import { useTranslation } from 'react-i18next';
import type { SendingDomainDto } from '@breeze/shared';
import { i18n } from '@/lib/i18n';
import '@/lib/i18n';

export interface TestSendControlProps {
  domain: SendingDomainDto;
  busy: boolean;
  onSend: (domainId: string) => void | Promise<void>;
}

/**
 * One real message from this domain to the calling user's own address. In
 * `static` mode an accepted test send is what verifies the domain (spec §5.1),
 * and a relay refusal is shown verbatim so the operator can fix SendAs rights
 * or the relay's allowed senders.
 */
export default function TestSendControl({ domain, busy, onSend }: TestSendControlProps) {
  const { t } = useTranslation('settings');
  const pending = domain.lastTestStatus === 'pending';
  // Resolved-locale formatting, not a hard-coded pattern
  // (apps/web/src/lib/i18n/extractionQuality.test.ts:189).
  const when = domain.lastTestAt ? new Date(domain.lastTestAt).toLocaleString(i18n.language) : '';

  return (
    <div className="mt-3 rounded-md border bg-muted/20 p-3" data-testid={`sending-domain-${domain.id}-test`}>
      <p className="text-xs font-medium">{t('partnerSendingDomains.testTitle')}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{t('partnerSendingDomains.testDescription')}</p>

      <button
        type="button"
        disabled={busy || pending}
        onClick={() => void onSend(domain.id)}
        className="mt-2 rounded-md border px-2.5 py-1.5 text-sm disabled:opacity-50"
        data-testid={`sending-domain-${domain.id}-test-submit`}
      >
        {t('partnerSendingDomains.testSubmit')}
      </button>

      {domain.lastTestStatus && (
        <p
          className={`mt-1.5 text-xs ${domain.lastTestStatus === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
          data-testid={`sending-domain-${domain.id}-test-result`}
        >
          {pending && t('partnerSendingDomains.testPending')}
          {domain.lastTestStatus === 'sent' && t('partnerSendingDomains.testLastSent', { when })}
          {domain.lastTestStatus === 'failed'
            && t('partnerSendingDomains.testLastFailed', { when, error: domain.lastTestError ?? '' })}
        </p>
      )}
    </div>
  );
}
