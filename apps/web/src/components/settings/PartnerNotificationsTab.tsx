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

      {/* Pushover defaults */}
      <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
        <div>
          <p className="text-sm font-medium">Pushover Defaults</p>
          <p className="text-xs text-muted-foreground">
            App token inherited by any per-org Pushover channel that leaves its token blank.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2 sm:col-span-3">
            <label className="text-sm font-medium">Application Token</label>
            <input
              type="password"
              autoComplete="new-password"
              value={data.pushoverAppToken ?? ''}
              maxLength={30}
              onChange={e => set({ pushoverAppToken: e.target.value || undefined })}
              placeholder={PLACEHOLDER}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Default Sound</label>
            <input
              type="text"
              value={data.pushoverDefaultSound ?? ''}
              onChange={e => set({ pushoverDefaultSound: e.target.value || undefined })}
              placeholder="pushover"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <label className="text-sm font-medium">Default Priority</label>
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
              <option value="">{PLACEHOLDER}</option>
              <option value={-2}>Lowest</option>
              <option value={-1}>Low</option>
              <option value={0}>Normal</option>
              <option value={1}>High</option>
              <option value={2}>Emergency</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
