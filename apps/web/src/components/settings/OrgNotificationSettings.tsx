import { useMemo, useState } from 'react';
import { Bell, Mail, MessageSquare, Plus, Save, Send, Trash2, Webhook } from 'lucide-react';

type NotificationsData = {
  fromAddress?: string;
  replyTo?: string;
  useCustomSmtp?: boolean;
  smtpHost?: string;
  smtpPort?: string;
  smtpUsername?: string;
  smtpEncryption?: string;
  slackWebhookUrl?: string;
  slackChannel?: string;
  webhooks?: string[];
  preferences?: Record<string, Record<string, boolean>>;
};

type OrgNotificationSettingsProps = {
  notifications?: NotificationsData;
  onDirty?: () => void;
  onSave?: (data: NotificationsData) => void;
  locked?: string[];
};

const defaultNotifications: NotificationsData = {
  fromAddress: 'alerts@breeze.io',
  replyTo: 'support@breeze.io',
  useCustomSmtp: false,
  smtpHost: 'smtp.breeze.io',
  smtpPort: '587',
  smtpUsername: 'alerts',
  smtpEncryption: 'tls',
  slackWebhookUrl: '',
  slackChannel: '#ops-alerts',
  webhooks: []
};

const slackChannels = ['#ops-alerts', '#security', '#it-helpdesk'];

const alertTypes = [
  { id: 'critical', label: 'Critical incidents' },
  { id: 'policy', label: 'Policy violations' },
  { id: 'device', label: 'Device offline' },
  { id: 'updates', label: 'Agent updates' },
  { id: 'billing', label: 'Billing notices' }
];

const channelOptions = [
  { id: 'email', label: 'Email' },
  { id: 'slack', label: 'Slack' },
  { id: 'webhook', label: 'Webhook' }
];

const getDefaultPreferences = () => {
  const initial: Record<string, Record<string, boolean>> = {};
  alertTypes.forEach(alert => {
    initial[alert.id] = { email: true, slack: alert.id !== 'billing', webhook: false };
  });
  return initial;
};

export default function OrgNotificationSettings({
  notifications,
  onDirty,
  onSave,
  locked
}: OrgNotificationSettingsProps) {
  const isLocked = (field: string) => locked?.includes(`notifications.${field}`) ?? false;
  const initialData = { ...defaultNotifications, ...notifications };
  const [fromAddress, setFromAddress] = useState(initialData.fromAddress || '');
  const [replyTo, setReplyTo] = useState(initialData.replyTo || '');
  const [useCustomSmtp, setUseCustomSmtp] = useState(initialData.useCustomSmtp || false);
  const [smtpHost, setSmtpHost] = useState(initialData.smtpHost || '');
  const [smtpPort, setSmtpPort] = useState(initialData.smtpPort || '587');
  const [smtpUsername, setSmtpUsername] = useState(initialData.smtpUsername || '');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [smtpEncryption, setSmtpEncryption] = useState(initialData.smtpEncryption || 'tls');
  const [slackWebhookUrl, setSlackWebhookUrl] = useState(initialData.slackWebhookUrl || '');
  const [slackChannel, setSlackChannel] = useState(initialData.slackChannel || '#ops-alerts');
  const [slackStatus, setSlackStatus] = useState<string | null>(null);
  const [webhooks, setWebhooks] = useState(initialData.webhooks || []);
  const [newWebhook, setNewWebhook] = useState('');
  const [preferences, setPreferences] = useState(initialData.preferences || getDefaultPreferences());

  const markDirty = () => {
    onDirty?.();
  };

  const handleAddWebhook = () => {
    if (!newWebhook.trim()) {
      return;
    }
    setWebhooks(prev => [...prev, newWebhook.trim()]);
    setNewWebhook('');
    markDirty();
  };

  const handleRemoveWebhook = (url: string) => {
    setWebhooks(prev => prev.filter(item => item !== url));
    markDirty();
  };

  const handleSlackTest = () => {
    setSlackStatus(`Test sent to ${slackChannel}.`);
  };

  const handleSave = () => {
    const data: NotificationsData = {
      fromAddress,
      replyTo,
      useCustomSmtp,
      smtpHost,
      smtpPort,
      smtpUsername,
      smtpEncryption,
      slackWebhookUrl,
      slackChannel,
      webhooks,
      preferences
    };
    onSave?.(data);
  };

  const smtpFields = useMemo(
    () => [
      { label: 'SMTP host', value: smtpHost, onChange: setSmtpHost, lockKey: 'smtpHost' },
      { label: 'Port', value: smtpPort, onChange: setSmtpPort, lockKey: 'smtpPort' },
      { label: 'Username', value: smtpUsername, onChange: setSmtpUsername, lockKey: 'smtpUsername' },
      { label: 'Password', value: smtpPassword, onChange: setSmtpPassword, lockKey: 'smtpPassword' }
    ],
    [smtpHost, smtpPort, smtpUsername, smtpPassword]
  );

  return (
    <section className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Notifications</h2>
          <p className="text-sm text-muted-foreground">
            Configure messaging channels and alert routing for your teams.
          </p>
        </div>
        <button
          type="button"
          onClick={handleSave}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Save className="h-4 w-4" />
          Save settings
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-6">
          <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Mail className="h-4 w-4" />
              Email settings
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium">From address</label>
                <input
                  type="email"
                  value={fromAddress}
                  disabled={isLocked('fromAddress')}
                  onChange={event => {
                    setFromAddress(event.target.value);
                    markDirty();
                  }}
                  className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked('fromAddress') ? 'opacity-60' : ''}`}
                />
                {isLocked('fromAddress') && (
                  <span className="text-xs text-amber-600 dark:text-amber-400 italic">Managed by partner</span>
                )}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Reply-to address</label>
                <input
                  type="email"
                  value={replyTo}
                  disabled={isLocked('replyTo')}
                  onChange={event => {
                    setReplyTo(event.target.value);
                    markDirty();
                  }}
                  className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked('replyTo') ? 'opacity-60' : ''}`}
                />
                {isLocked('replyTo') && (
                  <span className="text-xs text-amber-600 dark:text-amber-400 italic">Managed by partner</span>
                )}
              </div>
            </div>

            <label className={`flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm ${isLocked('useCustomSmtp') ? 'opacity-60' : ''}`}>
              <span>Use custom SMTP server</span>
              <input
                type="checkbox"
                checked={useCustomSmtp}
                disabled={isLocked('useCustomSmtp')}
                onChange={event => {
                  setUseCustomSmtp(event.target.checked);
                  markDirty();
                }}
                className="h-4 w-4"
              />
            </label>
            {isLocked('useCustomSmtp') && (
              <span className="text-xs text-amber-600 dark:text-amber-400 italic">Managed by partner</span>
            )}

            {useCustomSmtp ? (
              <div className="grid gap-4 md:grid-cols-2">
                {smtpFields.map(field => (
                  <div key={field.label} className="space-y-2">
                    <label className="text-sm font-medium">{field.label}</label>
                    <input
                      type={field.label === 'Password' ? 'password' : 'text'}
                      value={field.value}
                      disabled={isLocked(field.lockKey)}
                      onChange={event => {
                        field.onChange(event.target.value);
                        markDirty();
                      }}
                      className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked(field.lockKey) ? 'opacity-60' : ''}`}
                    />
                    {isLocked(field.lockKey) && (
                      <span className="text-xs text-amber-600 dark:text-amber-400 italic">Managed by partner</span>
                    )}
                  </div>
                ))}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Encryption</label>
                  <select
                    value={smtpEncryption}
                    disabled={isLocked('smtpEncryption')}
                    onChange={event => {
                      setSmtpEncryption(event.target.value);
                      markDirty();
                    }}
                    className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked('smtpEncryption') ? 'opacity-60' : ''}`}
                  >
                    <option value="tls">TLS</option>
                    <option value="ssl">SSL</option>
                    <option value="none">None</option>
                  </select>
                  {isLocked('smtpEncryption') && (
                    <span className="text-xs text-amber-600 dark:text-amber-400 italic">Managed by partner</span>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Using Breeze managed SMTP for faster deliverability.
              </p>
            )}
          </div>

          <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <MessageSquare className="h-4 w-4" />
              Slack integration
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Webhook URL</label>
              <input
                type="text"
                value={slackWebhookUrl}
                disabled={isLocked('slackWebhookUrl')}
                onChange={event => {
                  setSlackWebhookUrl(event.target.value);
                  markDirty();
                }}
                className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked('slackWebhookUrl') ? 'opacity-60' : ''}`}
              />
              {isLocked('slackWebhookUrl') && (
                <span className="text-xs text-amber-600 dark:text-amber-400 italic">Managed by partner</span>
              )}
            </div>
            <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
              <div className="space-y-2">
                <label className="text-sm font-medium">Default channel</label>
                <select
                  value={slackChannel}
                  disabled={isLocked('slackChannel')}
                  onChange={event => {
                    setSlackChannel(event.target.value);
                    markDirty();
                  }}
                  className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked('slackChannel') ? 'opacity-60' : ''}`}
                >
                  {slackChannels.map(channel => (
                    <option key={channel} value={channel}>
                      {channel}
                    </option>
                  ))}
                </select>
                {isLocked('slackChannel') && (
                  <span className="text-xs text-amber-600 dark:text-amber-400 italic">Managed by partner</span>
                )}
              </div>
              <button
                type="button"
                onClick={handleSlackTest}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition hover:bg-muted"
              >
                <Send className="h-4 w-4" />
                Test
              </button>
            </div>
            {slackStatus ? (
              <p className="text-xs text-muted-foreground">{slackStatus}</p>
            ) : null}
          </div>

          <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Webhook className="h-4 w-4" />
              Webhook notifications
            </div>
            {isLocked('webhooks') && (
              <span className="text-xs text-amber-600 dark:text-amber-400 italic">Managed by partner</span>
            )}
            <div className={`flex flex-wrap gap-2 ${isLocked('webhooks') ? 'opacity-60' : ''}`}>
              <input
                type="text"
                value={newWebhook}
                disabled={isLocked('webhooks')}
                onChange={event => setNewWebhook(event.target.value)}
                placeholder="https://api.example.com/alerts"
                className="h-10 flex-1 rounded-md border bg-background px-3 text-sm"
              />
              <button
                type="button"
                onClick={handleAddWebhook}
                disabled={isLocked('webhooks')}
                className="inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                Add
              </button>
            </div>
            <div className="space-y-2">
              {webhooks.map(url => (
                <div
                  key={url}
                  className="flex items-center justify-between rounded-md border bg-background px-3 py-2 text-xs"
                >
                  <span className="truncate">{url}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveWebhook(url)}
                    className="inline-flex items-center gap-1 text-muted-foreground transition hover:text-foreground"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </button>
                </div>
              ))}
              {webhooks.length === 0 ? (
                <p className="text-xs text-muted-foreground">No webhooks configured.</p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Bell className="h-4 w-4" />
            Notification preferences
          </div>
          <div className="overflow-auto">
            <table className="w-full min-w-[340px] text-left text-xs">
              <thead className="text-[11px] uppercase text-muted-foreground">
                <tr>
                  <th className="px-2 py-2">Alert type</th>
                  {channelOptions.map(channel => (
                    <th key={channel.id} className="px-2 py-2">
                      {channel.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {alertTypes.map(alert => (
                  <tr key={alert.id} className="border-t">
                    <td className="px-2 py-2 text-sm font-medium">{alert.label}</td>
                    {channelOptions.map(channel => (
                      <td key={channel.id} className={`px-2 py-2 ${isLocked('preferences') ? 'opacity-60' : ''}`}>
                        <input
                          type="checkbox"
                          checked={preferences[alert.id][channel.id]}
                          disabled={isLocked('preferences')}
                          onChange={() => {
                            setPreferences(prev => ({
                              ...prev,
                              [alert.id]: {
                                ...prev[alert.id],
                                [channel.id]: !prev[alert.id][channel.id]
                              }
                            }));
                            markDirty();
                          }}
                          className="h-4 w-4"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Choose which channels are used for each alert type.
          </p>
          {isLocked('preferences') && (
            <span className="text-xs text-amber-600 dark:text-amber-400 italic">Managed by partner</span>
          )}
        </div>
      </div>
    </section>
  );
}
