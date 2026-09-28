import { useEffect, useState } from 'react';
import type { InheritableEventLogSettings } from '@breeze/shared';
import { Trans, useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { MASKED_SECRET, isMaskedSecret } from '@/lib/redactedSecret';

type Props = {
  data: InheritableEventLogSettings;
  onChange: (data: InheritableEventLogSettings) => void;
};

type SecretKey = 'elasticsearchApiKey' | 'elasticsearchPassword';

// The API returns a saved credential only as the masked marker. The field
// stays empty with a "saved" placeholder and the marker stays in `data`, so a
// save keeps the saved value; typing replaces it, and Remove sends an explicit
// empty string, which clears it.
function SecretField({
  field,
  label,
  testId,
  data,
  set,
}: {
  field: SecretKey;
  label: string;
  testId: string;
  data: InheritableEventLogSettings;
  set: (patch: Partial<InheritableEventLogSettings>) => void;
}) {
  const { t } = useTranslation('settings');
  const value = data[field];
  const [hasSaved, setHasSaved] = useState(() => isMaskedSecret(value));
  useEffect(() => {
    if (isMaskedSecret(value)) setHasSaved(true);
  }, [value]);

  const removed = hasSaved && value === '';
  const placeholder = removed
    ? t('partnerEventLogs.secretRemovedPlaceholder')
    : hasSaved
      ? t('partnerEventLogs.savedSecretPlaceholder')
      : t('partnerEventLogs.notSet');

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">{label}</label>
      <div className="flex gap-2">
        <input
          type="password"
          autoComplete="new-password"
          data-testid={testId}
          value={isMaskedSecret(value) ? '' : (value ?? '')}
          onChange={e => set({ [field]: e.target.value || (hasSaved ? MASKED_SECRET : undefined) })}
          placeholder={placeholder}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
        />
        {hasSaved && !removed && (
          <button
            type="button"
            data-testid={`${testId}-remove`}
            onClick={() => set({ [field]: '' })}
            className="h-10 shrink-0 rounded-md border px-3 text-sm hover:bg-muted"
          >
            {t('partnerEventLogs.removeSecret')}
          </button>
        )}
      </div>
    </div>
  );
}

export default function PartnerEventLogsTab({ data, onChange }: Props) {
  const { t } = useTranslation('settings');
  const set = (patch: Partial<InheritableEventLogSettings>) =>
    onChange({ ...data, ...patch });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={data.enabled ?? false}
          onChange={e => set({ enabled: e.target.checked })}
          className="h-4 w-4 rounded border"
        />
        <label className="text-sm font-medium">{t('partnerEventLogs.enable')}</label>
      </div>

      {data.enabled && (
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('partnerEventLogs.endpoint')}</label>
            <input
              type="url"
              value={data.elasticsearchUrl ?? ''}
              onChange={e => set({ elasticsearchUrl: e.target.value || undefined })}
              placeholder={t('partnerEventLogs.endpointPlaceholder')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">{t('partnerEventLogs.indexPrefix')}</label>
            <input
              type="text"
              value={data.indexPrefix ?? ''}
              onChange={e => set({ indexPrefix: e.target.value || undefined })}
              placeholder={t('partnerEventLogs.indexPlaceholder')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

          <SecretField
            field="elasticsearchApiKey"
            label={t('partnerEventLogs.apiKey')}
            testId="partner-event-logs-api-key"
            data={data}
            set={set}
          />

          <div className="space-y-2">
            <label className="text-sm font-medium">{t('partnerEventLogs.username')}</label>
            <input
              type="text"
              value={data.elasticsearchUsername ?? ''}
              onChange={e => set({ elasticsearchUsername: e.target.value || undefined })}
              placeholder={t('partnerEventLogs.notSet')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

          <SecretField
            field="elasticsearchPassword"
            label={t('partnerEventLogs.password')}
            testId="partner-event-logs-password"
            data={data}
            set={set}
          />
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        <Trans i18nKey="partnerEventLogs.description" t={t} components={{ bulk: <code /> }} />
      </p>
    </div>
  );
}
