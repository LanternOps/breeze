import type { InheritableNotificationSettings } from '@breeze/shared';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

type Props = {
  data: InheritableNotificationSettings;
  onChange: (data: InheritableNotificationSettings) => void;
};

export default function PartnerNotificationsTab({ data, onChange }: Props) {
  const { t } = useTranslation('settings');
  const set = (patch: Partial<InheritableNotificationSettings>) =>
    onChange({ ...data, ...patch });

  return (
    <div className="space-y-6">
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium">{t('partnerNotifications.fromAddress')}</label>
          <input
            type="email"
            value={data.fromAddress ?? ''}
            onChange={e => set({ fromAddress: e.target.value || undefined })}
            placeholder={t('partnerNotifications.notSet')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('partnerNotifications.replyTo')}</label>
          <input
            type="email"
            value={data.replyTo ?? ''}
            onChange={e => set({ replyTo: e.target.value || undefined })}
            placeholder={t('partnerNotifications.notSet')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </div>
      </div>

      {/* Custom SMTP */}
      <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={data.useCustomSmtp ?? false}
            onChange={e => set({ useCustomSmtp: e.target.checked })}
            className="h-4 w-4 rounded border"
          />
          <label className="text-sm font-medium">{t('partnerNotifications.useCustomSmtp')}</label>
        </div>

        {data.useCustomSmtp && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('partnerNotifications.smtpHost')}</label>
              <input
                type="text"
                value={data.smtpHost ?? ''}
                onChange={e => set({ smtpHost: e.target.value || undefined })}
                placeholder={t('partnerNotifications.smtpHostPlaceholder')}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('partnerNotifications.smtpPort')}</label>
              <input
                type="number"
                value={data.smtpPort ?? ''}
                onChange={e => set({ smtpPort: e.target.value ? Number(e.target.value) : undefined })}
                placeholder={t('partnerNotifications.smtpPortPlaceholder')}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('partnerNotifications.smtpUsername')}</label>
              <input
                type="text"
                value={data.smtpUsername ?? ''}
                onChange={e => set({ smtpUsername: e.target.value || undefined })}
                placeholder={t('partnerNotifications.notSet')}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('partnerNotifications.encryption')}</label>
              <select
                value={data.smtpEncryption ?? ''}
                onChange={e => set({ smtpEncryption: (e.target.value || undefined) as InheritableNotificationSettings['smtpEncryption'] })}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">{t('partnerNotifications.notSet')}</option>
                <option value="tls">TLS</option>
                <option value="ssl">SSL</option>
                <option value="none">{t('common:labels.none')}</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Slack */}
      <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
        <p className="text-sm font-medium">{t('partnerNotifications.slackIntegration')}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('partnerNotifications.slackWebhook')}</label>
            <input
              type="url"
              value={data.slackWebhookUrl ?? ''}
              onChange={e => set({ slackWebhookUrl: e.target.value || undefined })}
              placeholder={t('partnerNotifications.notSet')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('partnerNotifications.slackChannel')}</label>
            <input
              type="text"
              value={data.slackChannel ?? ''}
              onChange={e => set({ slackChannel: e.target.value || undefined })}
              placeholder={t('partnerNotifications.slackChannelPlaceholder')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
        </div>
      </div>

      {/* Pushover defaults */}
      <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
        <div>
          <p className="text-sm font-medium">{t('partnerNotifications.pushoverDefaults')}</p>
          <p className="text-xs text-muted-foreground">
            {t('partnerNotifications.pushoverDescription')}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('partnerNotifications.applicationToken')}</label>
            <input
              type="password"
              autoComplete="new-password"
              value={data.pushoverAppToken ?? ''}
              maxLength={30}
              onChange={e => set({ pushoverAppToken: e.target.value || undefined })}
              placeholder={t('partnerNotifications.notSet')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('partnerNotifications.defaultUserKey')}</label>
            <input
              type="text"
              autoComplete="off"
              value={data.pushoverDefaultUser ?? ''}
              maxLength={30}
              onChange={e => set({ pushoverDefaultUser: e.target.value || undefined })}
              placeholder={t('partnerNotifications.notSet')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('partnerNotifications.defaultSound')}</label>
            <input
              type="text"
              value={data.pushoverDefaultSound ?? ''}
              onChange={e => set({ pushoverDefaultSound: e.target.value || undefined })}
              placeholder={t('partnerNotifications.soundPlaceholder')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <label className="text-sm font-medium">{t('partnerNotifications.defaultPriority')}</label>
            <select
              value={data.pushoverDefaultPriority ?? ''}
              onChange={e =>
                set({
                  pushoverDefaultPriority:
                    e.target.value === ''
                      ? undefined
                      : (Number(e.target.value) as InheritableNotificationSettings['pushoverDefaultPriority'])
                })
              }
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t('partnerNotifications.notSet')}</option>
              <option value={-2}>{t('partnerNotifications.priorities.lowest')}</option>
              <option value={-1}>{t('partnerNotifications.priorities.low')}</option>
              <option value={0}>{t('partnerNotifications.priorities.normal')}</option>
              <option value={1}>{t('partnerNotifications.priorities.high')}</option>
              <option value={2}>{t('partnerNotifications.priorities.emergency')}</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
