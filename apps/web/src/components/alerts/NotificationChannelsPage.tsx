import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, GripVertical, ArrowUpDown, ChevronDown, ChevronRight } from 'lucide-react';
import NotificationChannelList, { type NotificationChannel } from './NotificationChannelList';
import NotificationChannelForm, { type NotificationChannelFormValues } from './NotificationChannelForm';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { navigateTo } from '@/lib/navigation';

type ModalMode = 'closed' | 'create' | 'edit' | 'delete';

type RoutingRule = {
  id: string;
  name: string;
  priority: number;
  conditions: {
    severities?: string[];
    conditionTypes?: string[];
  };
  channelIds: string[];
  enabled: boolean;
};

export default function NotificationChannelsPage() {
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedChannel, setSelectedChannel] = useState<NotificationChannel | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { currentOrgId } = useOrgStore();

  // Routing rules state
  const [routingRules, setRoutingRules] = useState<RoutingRule[]>([]);
  const [routingExpanded, setRoutingExpanded] = useState(false);
  const [editingRule, setEditingRule] = useState<RoutingRule | null>(null);
  const [showRuleForm, setShowRuleForm] = useState(false);

  const fetchRoutingRules = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/alerts/routing-rules');
      if (!response.ok) return;
      const data = await response.json();
      setRoutingRules(data.rules ?? data.data ?? (Array.isArray(data) ? data : []));
    } catch { /* non-critical */ }
  }, []);

  const fetchChannels = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/alerts/channels');
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error('Failed to fetch notification channels');
      }
      const data = await response.json();
      setChannels(data.channels ?? data.data ?? (Array.isArray(data) ? data : []));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchChannels();
    fetchRoutingRules();
  }, [fetchChannels, fetchRoutingRules]);

  const handleCreate = () => {
    setSelectedChannel(null);
    setModalMode('create');
  };

  const handleEdit = (channel: NotificationChannel) => {
    setSelectedChannel(channel);
    setModalMode('edit');
  };

  const handleDelete = (channel: NotificationChannel) => {
    setSelectedChannel(channel);
    setModalMode('delete');
  };

  const handleTest = async (channel: NotificationChannel) => {
    try {
      const response = await fetchWithAuth(`/alerts/channels/${channel.id}/test`, {
        method: 'POST'
      });

      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error('Test failed');
      }

      // Refresh to update test status
      await fetchChannels();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test failed');
    }
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedChannel(null);
  };

  const transformFormToPayload = (values: NotificationChannelFormValues) => {
    const base = {
      name: values.name,
      type: values.type,
      enabled: values.enabled
    };

    let config: Record<string, unknown> = {};

    switch (values.type) {
      case 'email':
        config = {
          recipients: values.emailRecipients?.map(r => r.value).filter(v => v) ?? []
        };
        break;
      case 'slack':
        config = {
          webhookUrl: values.slackWebhookUrl,
          channel: values.slackChannel
        };
        break;
      case 'teams':
        config = {
          webhookUrl: values.teamsWebhookUrl
        };
        break;
      case 'pagerduty':
        config = {
          integrationKey: values.pagerdutyIntegrationKey,
          severity: values.pagerdutySeverity
        };
        break;
      case 'webhook':
        config = {
          url: values.webhookUrl,
          method: values.webhookMethod,
          headers: values.webhookHeaders?.filter(h => h.key) ?? [],
          authType: values.webhookAuthType,
          authUsername: values.webhookAuthUsername,
          authPassword: values.webhookAuthPassword,
          authToken: values.webhookAuthToken
        };
        break;
      case 'sms':
        config = {
          phoneNumbers: values.smsPhoneNumbers
            ?.map(p => p.value.trim())
            .filter(v => v) ?? []
        };
        if (values.smsFrom?.trim()) {
          config.from = values.smsFrom.trim();
        }
        if (values.smsMessagingServiceSid?.trim()) {
          config.messagingServiceSid = values.smsMessagingServiceSid.trim();
        }
        break;
    }

    // Per-channel templates
    const templates: Record<string, string> = {};
    if (values.templateTriggered?.trim()) {
      templates.alert_triggered = values.templateTriggered.trim();
    }
    if (values.templateResolved?.trim()) {
      templates.alert_resolved = values.templateResolved.trim();
    }

    return { ...base, config, ...(Object.keys(templates).length > 0 ? { templates } : {}) };
  };

  const transformChannelToForm = (channel: NotificationChannel): Partial<NotificationChannelFormValues> => {
    const base: Partial<NotificationChannelFormValues> = {
      name: channel.name,
      type: channel.type,
      enabled: channel.enabled
    };

    // Per-channel templates
    const channelTemplates = (channel as NotificationChannel & { templates?: Record<string, string> }).templates;
    if (channelTemplates) {
      base.templateTriggered = channelTemplates.alert_triggered ?? '';
      base.templateResolved = channelTemplates.alert_resolved ?? '';
    }

    const config = channel.config;

    switch (channel.type) {
      case 'email':
        base.emailRecipients = Array.isArray(config.recipients)
          ? (config.recipients as string[]).map(v => ({ value: v }))
          : [{ value: '' }];
        break;
      case 'slack':
        base.slackWebhookUrl = config.webhookUrl as string;
        base.slackChannel = config.channel as string;
        break;
      case 'teams':
        base.teamsWebhookUrl = config.webhookUrl as string;
        break;
      case 'pagerduty':
        base.pagerdutyIntegrationKey = config.integrationKey as string;
        base.pagerdutySeverity = config.severity as 'critical' | 'error' | 'warning' | 'info';
        break;
      case 'webhook':
        base.webhookUrl = config.url as string;
        base.webhookMethod = config.method as 'POST' | 'PUT' | 'PATCH';
        base.webhookHeaders = Array.isArray(config.headers)
          ? (config.headers as { key: string; value: string }[])
          : [];
        base.webhookAuthType = config.authType as 'none' | 'basic' | 'bearer';
        base.webhookAuthUsername = config.authUsername as string;
        base.webhookAuthPassword = config.authPassword as string;
        base.webhookAuthToken = config.authToken as string;
        break;
      case 'sms':
        base.smsPhoneNumbers = Array.isArray(config.phoneNumbers)
          ? (config.phoneNumbers as string[]).map(v => ({ value: v }))
          : [{ value: '' }];
        base.smsFrom = config.from as string;
        base.smsMessagingServiceSid = config.messagingServiceSid as string;
        break;
    }

    return base;
  };

  const handleSubmit = async (values: NotificationChannelFormValues) => {
    setSubmitting(true);
    setError(undefined);

    try {
      const payload = transformFormToPayload(values);
      const url =
        modalMode === 'create'
          ? '/alerts/channels'
          : `/alerts/channels/${selectedChannel?.id}`;
      const method = modalMode === 'create' ? 'POST' : 'PUT';

      const requestPayload = modalMode === 'create' && currentOrgId
        ? { ...payload, orgId: currentOrgId }
        : payload;

      const response = await fetchWithAuth(url, {
        method,
        body: JSON.stringify(requestPayload)
      });

      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        const data = await response.json();
        throw new Error(data.error || 'Failed to save channel');
      }

      await fetchChannels();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedChannel) return;

    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/alerts/channels/${selectedChannel.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error('Failed to delete channel');
      }

      await fetchChannels();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveRoutingRule = async (rule: Omit<RoutingRule, 'id'> & { id?: string }) => {
    try {
      const isEdit = !!rule.id;
      const url = isEdit ? `/alerts/routing-rules/${rule.id}` : '/alerts/routing-rules';
      const method = isEdit ? 'PATCH' : 'POST';
      const response = await fetchWithAuth(url, {
        method,
        body: JSON.stringify({
          name: rule.name,
          priority: rule.priority,
          conditions: rule.conditions,
          channelIds: rule.channelIds,
          enabled: rule.enabled,
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save routing rule');
      }
      await fetchRoutingRules();
      setShowRuleForm(false);
      setEditingRule(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save routing rule');
    }
  };

  const handleDeleteRoutingRule = async (ruleId: string) => {
    try {
      const response = await fetchWithAuth(`/alerts/routing-rules/${ruleId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to delete routing rule');
      await fetchRoutingRules();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete routing rule');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading notification channels...</p>
        </div>
      </div>
    );
  }

  if (error && channels.length === 0 && modalMode === 'closed') {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchChannels}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Notification Channels</h1>
          <p className="text-muted-foreground">
            Configure where alert notifications are sent.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/configuration-policies"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            Configuration Policies
          </a>
          <button
            type="button"
            onClick={handleCreate}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            New Channel
          </button>
        </div>
      </div>

      {error && modalMode === 'closed' && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <NotificationChannelList
        channels={channels}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onTest={handleTest}
      />

      {/* Routing Rules Section */}
      <div className="rounded-lg border bg-card">
        <button
          type="button"
          onClick={() => setRoutingExpanded(!routingExpanded)}
          className="flex w-full items-center justify-between px-6 py-4 text-left hover:bg-muted/50"
        >
          <div className="flex items-center gap-3">
            <ArrowUpDown className="h-5 w-5 text-muted-foreground" />
            <div>
              <h2 className="text-lg font-semibold">Notification Routing Rules</h2>
              <p className="text-sm text-muted-foreground">
                Route alerts to specific channels based on severity. First matching rule wins.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{routingRules.length} rule{routingRules.length !== 1 ? 's' : ''}</span>
            {routingExpanded ? <ChevronDown className="h-5 w-5 text-muted-foreground" /> : <ChevronRight className="h-5 w-5 text-muted-foreground" />}
          </div>
        </button>

        {routingExpanded && (
          <div className="border-t px-6 pb-6 pt-4">
            {routingRules.length === 0 && !showRuleForm ? (
              <div className="rounded-md border border-dashed py-8 text-center">
                <p className="text-sm text-muted-foreground">No routing rules configured. All alerts go to all enabled channels.</p>
                <button
                  type="button"
                  onClick={() => { setEditingRule(null); setShowRuleForm(true); }}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  <Plus className="h-3.5 w-3.5" /> Add Routing Rule
                </button>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  {routingRules
                    .sort((a, b) => a.priority - b.priority)
                    .map((rule) => (
                      <div key={rule.id} className="flex items-center gap-3 rounded-md border bg-muted/20 px-4 py-3">
                        <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground/50" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{rule.name}</span>
                            {!rule.enabled && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Disabled</span>
                            )}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                            <span>Priority: {rule.priority}</span>
                            {rule.conditions.severities && rule.conditions.severities.length > 0 && (
                              <span>
                                Severities: {rule.conditions.severities.join(', ')}
                              </span>
                            )}
                            <span>
                              Channels: {rule.channelIds.length === 0
                                ? 'None'
                                : rule.channelIds
                                    .map(id => channels.find(c => c.id === id)?.name ?? id.slice(0, 8))
                                    .join(', ')}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => { setEditingRule(rule); setShowRuleForm(true); }}
                            className="rounded-md px-2 py-1 text-xs font-medium hover:bg-muted"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteRoutingRule(rule.id)}
                            className="rounded-md p-1 text-destructive hover:bg-muted"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
                {!showRuleForm && (
                  <button
                    type="button"
                    onClick={() => { setEditingRule(null); setShowRuleForm(true); }}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add Rule
                  </button>
                )}
              </>
            )}

            {/* Inline Routing Rule Form */}
            {showRuleForm && (
              <RoutingRuleForm
                rule={editingRule}
                channels={channels}
                onSave={handleSaveRoutingRule}
                onCancel={() => { setShowRuleForm(false); setEditingRule(null); }}
              />
            )}
          </div>
        )}
      </div>

      {/* Create/Edit Modal */}
      {(modalMode === 'create' || modalMode === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 px-4 py-8">
          <div className="w-full max-w-3xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-bold">
                {modalMode === 'create' ? 'Create Notification Channel' : 'Edit Notification Channel'}
              </h2>
            </div>
            {error && (
              <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
            <NotificationChannelForm
              onSubmit={handleSubmit}
              onCancel={handleCloseModal}
              defaultValues={
                modalMode === 'edit' && selectedChannel
                  ? transformChannelToForm(selectedChannel)
                  : undefined
              }
              submitLabel={modalMode === 'create' ? 'Create Channel' : 'Save Changes'}
              loading={submitting}
            />
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {modalMode === 'delete' && selectedChannel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Delete Notification Channel</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete{' '}
              <span className="font-medium">{selectedChannel.name}</span>? This action cannot be
              undone. Any alert rules using this channel will no longer send notifications to it.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================
// Routing Rule Inline Form
// ============================================

const SEVERITY_OPTIONS = ['critical', 'high', 'medium', 'low', 'info'];

function RoutingRuleForm({
  rule,
  channels,
  onSave,
  onCancel,
}: {
  rule: RoutingRule | null;
  channels: NotificationChannel[];
  onSave: (rule: Omit<RoutingRule, 'id'> & { id?: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(rule?.name ?? '');
  const [priority, setPriority] = useState(rule?.priority ?? 10);
  const [severities, setSeverities] = useState<string[]>(rule?.conditions.severities ?? []);
  const [channelIds, setChannelIds] = useState<string[]>(rule?.channelIds ?? []);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);

  const toggleSeverity = (sev: string) => {
    setSeverities((prev) =>
      prev.includes(sev) ? prev.filter((s) => s !== sev) : [...prev, sev]
    );
  };

  const toggleChannel = (id: string) => {
    setChannelIds((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  const handleSubmit = () => {
    if (!name.trim()) return;
    onSave({
      ...(rule?.id ? { id: rule.id } : {}),
      name: name.trim(),
      priority,
      conditions: { severities: severities.length > 0 ? severities : undefined },
      channelIds,
      enabled,
    });
  };

  return (
    <div className="mt-4 rounded-md border bg-card p-4 space-y-4">
      <h3 className="text-sm font-semibold">{rule ? 'Edit Routing Rule' : 'New Routing Rule'}</h3>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Critical to PagerDuty"
            className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Priority (lower = higher)</label>
          <input
            type="number"
            min={1}
            max={100}
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value) || 10)}
            className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground">Match Severities</label>
        <p className="text-xs text-muted-foreground mb-2">Leave empty to match all severities.</p>
        <div className="flex flex-wrap gap-2">
          {SEVERITY_OPTIONS.map((sev) => (
            <button
              key={sev}
              type="button"
              onClick={() => toggleSeverity(sev)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                severities.includes(sev)
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'hover:bg-muted'
              }`}
            >
              {sev}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground">Route to Channels</label>
        <div className="mt-2 space-y-1">
          {channels.map((ch) => (
            <label key={ch.id} className="flex items-center gap-2 cursor-pointer rounded-md px-2 py-1 hover:bg-muted">
              <input
                type="checkbox"
                checked={channelIds.includes(ch.id)}
                onChange={() => toggleChannel(ch.id)}
                className="h-4 w-4 rounded border-muted"
              />
              <span className="text-sm">{ch.name}</span>
              <span className="text-xs text-muted-foreground">({ch.type})</span>
            </label>
          ))}
          {channels.length === 0 && (
            <p className="text-xs text-muted-foreground">No channels configured yet.</p>
          )}
        </div>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-muted"
        />
        <span className="text-sm">Enabled</span>
      </label>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-9 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!name.trim() || channelIds.length === 0}
          className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {rule ? 'Save Rule' : 'Create Rule'}
        </button>
      </div>
    </div>
  );
}
