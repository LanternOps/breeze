import type { InheritableNotificationSettings } from '@breeze/shared';

type Props = {
  data: InheritableNotificationSettings;
  onChange: (data: InheritableNotificationSettings) => void;
};

const PLACEHOLDER = 'Not set — orgs configure individually';

export default function PartnerNotificationsTab({ data, onChange }: Props) {
  const set = (patch: Partial<InheritableNotificationSettings>) =>
    onChange({ ...data, ...patch });

  return (
    <div className="space-y-6">
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium">From Address</label>
          <input
            type="email"
            value={data.fromAddress ?? ''}
            onChange={e => set({ fromAddress: e.target.value || undefined })}
            placeholder={PLACEHOLDER}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Reply-To Address</label>
          <input
            type="email"
            value={data.replyTo ?? ''}
            onChange={e => set({ replyTo: e.target.value || undefined })}
            placeholder={PLACEHOLDER}
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
          <label className="text-sm font-medium">Use Custom SMTP Server</label>
        </div>

        {data.useCustomSmtp && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">SMTP Host</label>
              <input
                type="text"
                value={data.smtpHost ?? ''}
                onChange={e => set({ smtpHost: e.target.value || undefined })}
                placeholder="smtp.example.com"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">SMTP Port</label>
              <input
                type="number"
                value={data.smtpPort ?? ''}
                onChange={e => set({ smtpPort: e.target.value ? Number(e.target.value) : undefined })}
                placeholder="587"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">SMTP Username</label>
              <input
                type="text"
                value={data.smtpUsername ?? ''}
                onChange={e => set({ smtpUsername: e.target.value || undefined })}
                placeholder={PLACEHOLDER}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Encryption</label>
              <select
                value={data.smtpEncryption ?? ''}
                onChange={e => set({ smtpEncryption: (e.target.value || undefined) as InheritableNotificationSettings['smtpEncryption'] })}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">{PLACEHOLDER}</option>
                <option value="tls">TLS</option>
                <option value="ssl">SSL</option>
                <option value="none">None</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Slack */}
      <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
        <p className="text-sm font-medium">Slack Integration</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">Slack Webhook URL</label>
            <input
              type="url"
              value={data.slackWebhookUrl ?? ''}
              onChange={e => set({ slackWebhookUrl: e.target.value || undefined })}
              placeholder={PLACEHOLDER}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Slack Channel</label>
            <input
              type="text"
              value={data.slackChannel ?? ''}
              onChange={e => set({ slackChannel: e.target.value || undefined })}
              placeholder="#alerts"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
