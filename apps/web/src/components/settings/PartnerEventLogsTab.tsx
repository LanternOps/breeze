import type { InheritableEventLogSettings } from '@breeze/shared';
import { Trans, useTranslation } from 'react-i18next';
import '@/lib/i18n';
import SavedSecretInput from './SavedSecretInput';

type Props = {
  data: InheritableEventLogSettings;
  onChange: (data: InheritableEventLogSettings) => void;
};

export default function PartnerEventLogsTab({ data, onChange }: Props) {
  const { t } = useTranslation('settings');
  const set = (patch: Partial<InheritableEventLogSettings>) =>
    onChange({ ...data, ...patch });

  return (
    <div className="space-y-6">
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={data.enabled ?? false}
          onChange={e => set({ enabled: e.target.checked })}
          className="h-4 w-4 rounded border"
        />
        <span className="text-sm font-medium">{t('partnerEventLogs.enable')}</span>
      </label>

      {data.enabled && (
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="partner-event-logs-endpoint" className="text-sm font-medium">{t('partnerEventLogs.endpoint')}</label>
            <input
              id="partner-event-logs-endpoint"
              type="url"
              value={data.elasticsearchUrl ?? ''}
              onChange={e => set({ elasticsearchUrl: e.target.value || undefined })}
              placeholder={t('partnerEventLogs.endpointPlaceholder')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="partner-event-logs-index-prefix" className="text-sm font-medium">{t('partnerEventLogs.indexPrefix')}</label>
            <input
              id="partner-event-logs-index-prefix"
              type="text"
              value={data.indexPrefix ?? ''}
              onChange={e => set({ indexPrefix: e.target.value || undefined })}
              placeholder={t('partnerEventLogs.indexPlaceholder')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

          <SavedSecretInput
            value={data.elasticsearchApiKey}
            onChange={elasticsearchApiKey => set({ elasticsearchApiKey })}
            label={t('partnerEventLogs.apiKey')}
            testId="partner-event-logs-api-key"
            notSetPlaceholder={t('partnerEventLogs.notSet')}
          />

          <div className="space-y-2">
            <label htmlFor="partner-event-logs-username" className="text-sm font-medium">{t('partnerEventLogs.username')}</label>
            <input
              id="partner-event-logs-username"
              type="text"
              value={data.elasticsearchUsername ?? ''}
              onChange={e => set({ elasticsearchUsername: e.target.value || undefined })}
              placeholder={t('partnerEventLogs.notSet')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

          <SavedSecretInput
            value={data.elasticsearchPassword}
            onChange={elasticsearchPassword => set({ elasticsearchPassword })}
            label={t('partnerEventLogs.password')}
            testId="partner-event-logs-password"
            notSetPlaceholder={t('partnerEventLogs.notSet')}
          />
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        <Trans i18nKey="partnerEventLogs.description" t={t} components={{ bulk: <code /> }} />
      </p>
    </div>
  );
}
