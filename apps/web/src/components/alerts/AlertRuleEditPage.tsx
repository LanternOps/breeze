import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
import AlertRuleForm, { type AlertRuleFormValues } from './AlertRuleForm';
import type { NotificationChannel } from './NotificationChannelList';

type Site = { id: string; name: string };
type Group = { id: string; name: string };
type Device = { id: string; name: string };

type AlertRuleEditPageProps = {
  ruleId?: string;
  isNew?: boolean;
};

export default function AlertRuleEditPage({ ruleId, isNew = false }: AlertRuleEditPageProps) {
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [defaultValues, setDefaultValues] = useState<Partial<AlertRuleFormValues>>();
  const [sites, setSites] = useState<Site[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [notificationChannels, setNotificationChannels] = useState<NotificationChannel[]>([]);

  const fetchRule = useCallback(async () => {
    if (!ruleId || isNew) return;

    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch(`/api/alerts/rules/${ruleId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch alert rule');
      }
      const data = await response.json();
      const rule = data.rule ?? data;

      // Transform rule to form values
      setDefaultValues({
        name: rule.name,
        description: rule.description,
        severity: rule.severity,
        targetType: rule.targets?.type ?? 'all',
        targetIds: rule.targets?.ids ?? [],
        conditions: rule.conditions ?? [],
        notificationChannelIds: rule.notificationChannelIds ?? [],
        cooldownMinutes: rule.cooldownMinutes ?? 15,
        autoResolve: rule.autoResolve ?? false
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [ruleId, isNew]);

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

  const fetchDevices = useCallback(async () => {
    try {
      const response = await fetch('/api/devices');
      if (response.ok) {
        const data = await response.json();
        setDevices(
          (data.devices ?? data ?? []).map((d: { id: string; hostname: string }) => ({
            id: d.id,
            name: d.hostname
          }))
        );
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
    fetchRule();
    fetchSites();
    fetchGroups();
    fetchDevices();
    fetchChannels();
  }, [fetchRule, fetchSites, fetchGroups, fetchDevices, fetchChannels]);

  const handleSubmit = async (values: AlertRuleFormValues) => {
    setSaving(true);
    setError(undefined);

    try {
      // Transform form values to API format
      const payload = {
        name: values.name,
        description: values.description,
        severity: values.severity,
        targets: {
          type: values.targetType,
          ids: values.targetIds
        },
        conditions: values.conditions,
        notificationChannelIds: values.notificationChannelIds,
        cooldownMinutes: values.cooldownMinutes,
        autoResolve: values.autoResolve,
        enabled: true
      };

      const url = isNew ? '/api/alerts/rules' : `/api/alerts/rules/${ruleId}`;
      const method = isNew ? 'POST' : 'PUT';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save alert rule');
      }

      window.location.href = '/alerts/rules';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    window.location.href = '/alerts/rules';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading alert rule...</p>
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
          onClick={fetchRule}
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
          href="/alerts/rules"
          className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
        >
          <ArrowLeft className="h-5 w-5" />
        </a>
        <div>
          <h1 className="text-2xl font-bold">
            {isNew ? 'Create Alert Rule' : 'Edit Alert Rule'}
          </h1>
          <p className="text-muted-foreground">
            {isNew
              ? 'Define conditions that trigger alerts.'
              : 'Modify the alert rule configuration.'}
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <AlertRuleForm
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        defaultValues={defaultValues}
        submitLabel={isNew ? 'Create Rule' : 'Save Changes'}
        loading={saving}
        sites={sites}
        groups={groups}
        devices={devices}
        notificationChannels={notificationChannels}
      />
    </div>
  );
}
