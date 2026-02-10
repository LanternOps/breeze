import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
import AutomationForm, { type ActionFormValues, type AutomationFormValues } from './AutomationForm';
import { fetchWithAuth } from '../../stores/auth';
import type { DeploymentTargetConfig } from '@breeze/shared';

type Site = { id: string; name: string };
type Group = { id: string; name: string };
type Script = { id: string; name: string };
type NotificationChannel = { id: string; name: string; type: string };

type AutomationEditPageProps = {
  automationId?: string;
  isNew?: boolean;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeActionForForm(value: unknown): ActionFormValues {
  const action = isPlainRecord(value) ? value : {};
  const type = asString(action.type);

  if (type === 'send_notification') {
    return {
      type,
      notificationChannelId: asString(action.notificationChannelId) ?? asString(action.channelId)
    };
  }

  if (type === 'create_alert') {
    return {
      type,
      alertSeverity: (asString(action.alertSeverity) ?? asString(action.severity) ?? 'medium') as ActionFormValues['alertSeverity'],
      alertMessage: asString(action.alertMessage) ?? asString(action.message) ?? ''
    };
  }

  if (type === 'execute_command') {
    return {
      type,
      command: asString(action.command) ?? ''
    };
  }

  return {
    type: 'run_script',
    scriptId: asString(action.scriptId) ?? asString(action.script_id)
  };
}

function buildActionPayload(action: ActionFormValues) {
  if (action.type === 'run_script') {
    return {
      type: action.type,
      scriptId: action.scriptId
    };
  }

  if (action.type === 'send_notification') {
    return {
      type: action.type,
      notificationChannelId: action.notificationChannelId
    };
  }

  if (action.type === 'create_alert') {
    return {
      type: action.type,
      alertSeverity: action.alertSeverity,
      alertMessage: action.alertMessage
    };
  }

  return {
    type: action.type,
    command: action.command
  };
}

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
      const response = await fetchWithAuth(`/automations/${automationId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch automation');
      }
      const data = await response.json();
      const automation = data.automation ?? data;

      const trigger = isPlainRecord(automation.trigger)
        ? automation.trigger
        : isPlainRecord(automation.triggerConfig)
          ? automation.triggerConfig
          : {};

      const triggerType = (
        asString(automation.triggerType)
        ?? asString(trigger.type)
        ?? 'manual'
      ) as AutomationFormValues['triggerType'];

      const notificationTargets = isPlainRecord(automation.notificationTargets)
        ? automation.notificationTargets
        : {};

      const notificationChannelIds = Array.isArray(notificationTargets.channelIds)
        ? notificationTargets.channelIds.filter((value: unknown): value is string => typeof value === 'string')
        : [];

      const notifyOnFailureChannelId = notificationChannelIds[0]
        ?? asString(automation.notifyOnFailureChannelId);

      const targetConfig = isPlainRecord(automation.conditions)
        ? automation.conditions as DeploymentTargetConfig
        : undefined;

      const formActions = Array.isArray(automation.actions)
        ? automation.actions.map(normalizeActionForForm)
        : [{ type: 'run_script' as const }];

      setDefaultValues({
        name: asString(automation.name) ?? '',
        description: asString(automation.description),
        triggerType,
        cronExpression: asString(trigger.cronExpression) ?? asString(trigger.cron),
        eventType: asString(trigger.eventType),
        webhookSecret: asString(trigger.secret) ?? asString(trigger.webhookSecret),
        conditions: Array.isArray(automation.conditions) ? automation.conditions : [],
        targetConfig,
        actions: formActions,
        onFailure: (asString(automation.onFailure) ?? 'stop') as AutomationFormValues['onFailure'],
        notifyOnFailureChannelId
      });

      setWebhookUrl(asString(trigger.webhookUrl));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [automationId, isNew]);

  const fetchSites = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/orgs/sites');
      if (response.ok) {
        const data = await response.json();
        setSites(data.data ?? data.sites ?? []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const fetchGroups = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/groups');
      if (response.ok) {
        const data = await response.json();
        setGroups(data.data ?? data.groups ?? []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const fetchScripts = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/scripts');
      if (response.ok) {
        const data = await response.json();
        setScripts(data.data ?? data.scripts ?? []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const fetchChannels = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/alerts/channels');
      if (response.ok) {
        const data = await response.json();
        setNotificationChannels(data.data ?? data.channels ?? []);
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
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

      const trigger =
        values.triggerType === 'schedule'
          ? {
              type: 'schedule',
              cronExpression: values.cronExpression,
              timezone
            }
          : values.triggerType === 'event'
            ? {
                type: 'event',
                eventType: values.eventType
              }
            : values.triggerType === 'webhook'
              ? {
                  type: 'webhook',
                  secret: values.webhookSecret?.trim() || undefined
                }
              : {
                  type: 'manual'
                };

      const payload = {
        name: values.name,
        description: values.description,
        trigger,
        conditions: values.targetConfig ?? values.conditions,
        actions: values.actions.map(buildActionPayload),
        onFailure: values.onFailure,
        notificationTargets: values.onFailure === 'notify' && values.notifyOnFailureChannelId
          ? { channelIds: [values.notifyOnFailureChannelId] }
          : undefined
      };

      if (isNew) {
        Object.assign(payload, { enabled: true });
      }

      const url = isNew ? '/automations' : `/automations/${automationId}`;
      const method = isNew ? 'POST' : 'PUT';

      const response = await fetchWithAuth(url, {
        method,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
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
