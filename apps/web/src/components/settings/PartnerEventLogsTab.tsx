import type { InheritableEventLogSettings } from '@breeze/shared';
import { Trans, useTranslation } from 'react-i18next';
import '@/lib/i18n';

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

          <div className="space-y-2">
            <label className="text-sm font-medium">{t('partnerEventLogs.apiKey')}</label>
            <input
              type="password"
              value={data.elasticsearchApiKey ?? ''}
              onChange={e => set({ elasticsearchApiKey: e.target.value || undefined })}
              placeholder={t('partnerEventLogs.notSet')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

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

          <div className="space-y-2">
            <label className="text-sm font-medium">{t('partnerEventLogs.password')}</label>
            <input
              type="password"
              value={data.elasticsearchPassword ?? ''}
              onChange={e => set({ elasticsearchPassword: e.target.value || undefined })}
              placeholder={t('partnerEventLogs.notSet')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        <Trans i18nKey="partnerEventLogs.description" t={t} components={{ bulk: <code /> }} />
      </p>
    </div>
  );
}
