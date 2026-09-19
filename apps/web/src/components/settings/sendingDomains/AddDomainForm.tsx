import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeSendingDomain } from '@breeze/shared';
import '@/lib/i18n';

export interface AddDomainFormProps {
  disabled: boolean;
  /** The empty state of spec §10: the form plus the subdomain recommendation. */
  showRecommendation: boolean;
  onAdd: (domain: string) => void | Promise<void>;
}

/**
 * Add-domain form. Validation uses the SHARED normaliser (spec §4.1) so the
 * field and the API agree character for character — the same function the route
 * runs through `createSendingDomainSchema`. Policy rejections (platform domains,
 * consumer providers, public suffixes, the operator denylist) are server-side
 * only and arrive as a toast.
 */
export default function AddDomainForm({ disabled, showRecommendation, onAdd }: AddDomainFormProps) {
  const { t } = useTranslation('settings');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = normalizeSendingDomain(value);
    if (!normalized.ok) {
      setError(t('partnerSendingDomains.addInvalid'));
      return;
    }
    setError(null);
    setValue('');
    void onAdd(normalized.domain);
  };

  return (
    <section className="rounded-lg border p-4" data-testid="sending-domains-add">
      <h3 className="mb-1 text-sm font-semibold">{t('partnerSendingDomains.addTitle')}</h3>

      <form className="mt-2 flex flex-wrap items-start gap-2" onSubmit={submit} data-testid="sending-domains-add-form">
        <div className="min-w-0 flex-1">
          <label className="text-xs font-medium" htmlFor="sending-domains-add-input">
            {t('partnerSendingDomains.addLabel')}
          </label>
          <input
            id="sending-domains-add-input"
            type="text"
            value={value}
            disabled={disabled}
            onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
            placeholder={t('partnerSendingDomains.addPlaceholder')}
            className="mt-0.5 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="sending-domains-add-input"
          />
        </div>
        <button
          type="submit"
          disabled={disabled}
          className="mt-5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          data-testid="sending-domains-add-submit"
        >
          {t('partnerSendingDomains.addSubmit')}
        </button>
      </form>

      {error && (
        <p className="mt-1.5 text-xs text-destructive" data-testid="sending-domains-add-error">
          {error}
        </p>
      )}

      {showRecommendation && (
        <div className="mt-4 rounded-md border bg-muted/20 p-3" data-testid="sending-domains-recommendation">
          <p className="text-xs font-medium">{t('partnerSendingDomains.recommendTitle')}</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
            <li>{t('partnerSendingDomains.recommendReason1')}</li>
            <li>{t('partnerSendingDomains.recommendReason2')}</li>
            <li>{t('partnerSendingDomains.recommendReason3')}</li>
          </ul>
        </div>
      )}
    </section>
  );
}
