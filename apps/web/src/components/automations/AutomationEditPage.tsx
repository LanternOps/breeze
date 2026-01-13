import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
import AutomationForm, { type AutomationFormValues } from './AutomationForm';

type Site = { id: string; name: string };
type Group = { id: string; name: string };
type Script = { id: string; name: string };
type NotificationChannel = { id: string; name: string; type: string };

type AutomationEditPageProps = {
  automationId?: string;
  isNew?: boolean;
};

export default function AutomationEditPage({ automationId, isNew = false }: AutomationEditPageProps) {
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [defaultValues, setDefaultValues] = useState<Partial<AutomationFormValues>>();
  const [webhookUrl, setWebhookUrl] = useState<string>();
  const [sites, setSites] = useState<Site[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [notificationChannels, setNotificationChannels] = useState<NotificationChannel[]>([]);

  const fetchAutomation = useCallback(async () => {
    if (!automationId || isNew) return;

    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch(`/api/automations/${automationId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch automation');
      }
      const data = await response.json();
      const automation = data.automation ?? data;

      // Transform automation to form values
      setDefaultValues({
        name: automation.name,
        description: automation.description,
        triggerType: automation.triggerType,
        cronExpression: automation.triggerConfig?.cronExpression,
        eventType: automation.triggerConfig?.eventType,
        conditions: automation.conditions ?? [],
        actions: automation.actions ?? [{ type: 'run_script' }],
        onFailure: automation.onFailure ?? 'stop',
        notifyOnFailureChannelId: automation.notifyOnFailureChannelId
      });
      setWebhookUrl(automation.triggerConfig?.webhookUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [automationId, isNew]);

  const fetchSites = useCallback(async () => {
    try {
      const response = await fetch('/api/sites');
      if (response.ok) {
        const data = await response.json();
        setSites(data.sites ?? data ?? []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const fetchGroups = useCallback(async () => {
    try {
      const response = await fetch('/api/groups');
      if (response.ok) {
        const data = await response.json();
        setGroups(data.groups ?? data ?? []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const fetchScripts = useCallback(async () => {
    try {
      const response = await fetch('/api/scripts');
      if (response.ok) {
        const data = await response.json();
        setScripts(data.scripts ?? data ?? []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const fetchChannels = useCallback(async () => {
    try {
      const response = await fetch('/api/alerts/channels');
      if (response.ok) {
        const data = await response.json();
        setNotificationChannels(data.channels ?? data ?? []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  useEffect(() => {
    fetchAutomation();
    fetchSites();
    fetchGroups();
    fetchScripts();
    fetchChannels();
  }, [fetchAutomation, fetchSites, fetchGroups, fetchScripts, fetchChannels]);

  const handleSubmit = async (values: AutomationFormValues) => {
    setSaving(true);
    setError(undefined);

    try {
      // Transform form values to API format
      const payload = {
        name: values.name,
        description: values.description,
        triggerType: values.triggerType,
        triggerConfig: {
          cronExpression: values.triggerType === 'schedule' ? values.cronExpression : undefined,
          eventType: values.triggerType === 'event' ? values.eventType : undefined
        },
        conditions: values.conditions,
        actions: values.actions,
        onFailure: values.onFailure,
        notifyOnFailureChannelId: values.onFailure === 'notify' ? values.notifyOnFailureChannelId : undefined,
        enabled: true
      };

      const url = isNew ? '/api/automations' : `/api/automations/${automationId}`;
      const method = isNew ? 'POST' : 'PUT';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save automation');
      }

      window.location.href = '/automations';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    window.location.href = '/automations';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading automation...</p>
        </div>
      </div>
    );
  }

  if (error && !defaultValues && !isNew) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchAutomation}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <a
          href="/automations"
          className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
        >
          <ArrowLeft className="h-5 w-5" />
        </a>
        <div>
          <h1 className="text-2xl font-bold">
            {isNew ? 'Create Automation' : 'Edit Automation'}
          </h1>
          <p className="text-muted-foreground">
            {isNew
              ? 'Build an automated workflow with triggers, conditions, and actions.'
              : 'Modify the automation configuration.'}
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <AutomationForm
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        defaultValues={defaultValues}
        webhookUrl={webhookUrl}
        submitLabel={isNew ? 'Create Automation' : 'Save Changes'}
        loading={saving}
        sites={sites}
        groups={groups}
        scripts={scripts}
        notificationChannels={notificationChannels}
      />
    </div>
  );
}
