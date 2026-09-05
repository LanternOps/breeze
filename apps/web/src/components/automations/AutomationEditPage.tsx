import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Bot } from 'lucide-react';
import AutomationForm, { type ActionFormValues, type AutomationFormValues } from './AutomationForm';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useDefaultOwnerScope } from '@/hooks/useDefaultOwnerScope';
import type { DeploymentTargetConfig } from '@breeze/shared';
import { extractApiError } from '@/lib/apiError';
import { navigateTo } from '@/lib/navigation';
import Breadcrumbs from '../layout/Breadcrumbs';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

type Site = { id: string; name: string };
type Group = { id: string; name: string };
// `runAs` (#4888): `GET /scripts` selects whole rows, so the saved run
// context is already on the wire — surfaced on the type so the run_script
// action's control can name the default it inherits ("Script default
// (System)") the way the other launch surfaces do.
type Script = { id: string; name: string; runAs?: 'system' | 'user' | 'elevated' };
type NotificationChannel = { id: string; name: string; type: string };
type SoftwareCatalogItem = { id: string; name: string; vendor?: string };

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

/**
 * Narrows a stored `run_script` action's run context to the `script_run_as`
 * enum (#4888).
 *
 * `'elevated'` is INCLUDED even though the control cannot hand it out: it is a
 * legal stored value (`automationRuntime.normalizeAutomationActions` keeps
 * it), and dropping it here would mean opening an elevated automation for an
 * unrelated edit and silently downgrading it on save. `RunContextSelect`
 * renders it as a disabled option so the value is visible and survives the
 * round trip untouched.
 */
function asRunAs(value: unknown): 'system' | 'user' | 'elevated' | undefined {
  return value === 'system' || value === 'user' || value === 'elevated' ? value : undefined;
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

  if (type === 'deploy_software') {
    return {
      type,
      catalogId: asString(action.catalogId) ?? asString(action.catalog_id)
    };
  }

  return {
    type: 'run_script',
    scriptId: asString(action.scriptId) ?? asString(action.script_id),
    // #4888 — read the stored run-context override back so opening an
    // automation for edit shows the choice that is actually in effect.
    // Without this the form would render "Script default" for an action that
    // overrides it, and the next save would erase the override.
    runAs: asRunAs(action.runAs)
  };
}

function buildActionPayload(action: ActionFormValues) {
  if (action.type === 'run_script') {
    return {
      type: action.type,
      scriptId: action.scriptId,
      // #4888 — this builder reconstructs each action field by field rather
      // than spreading the form values, so a field added to the form and NOT
      // added here is silently dropped between the operator clicking Save and
      // the request going out. That is precisely the bug #4888 was filed for
      // (the Fix flow's discarded run-as select), so it must not be
      // reintroduced one layer below the form. `undefined` is omitted by
      // JSON.stringify, which is what "Script default" has to serialise to.
      ...(action.runAs ? { runAs: action.runAs } : {})
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

  if (action.type === 'deploy_software') {
    return {
      type: action.type,
      catalogId: action.catalogId
    };
  }

  return {
    type: action.type,
    command: action.command
  };
}

export default function AutomationEditPage({ automationId, isNew = false }: AutomationEditPageProps) {
  const { t } = useTranslation('scripts');
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [defaultValues, setDefaultValues] = useState<Partial<AutomationFormValues>>();
  const [webhookUrl, setWebhookUrl] = useState<string>();
  // #3824: a seeded, agent-owned automation is read-only — render a notice
  // instead of the editor. The API 409s on save anyway.
  const [managedByAgentId, setManagedByAgentId] = useState<string | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [notificationChannels, setNotificationChannels] = useState<NotificationChannel[]>([]);
  const [softwareCatalog, setSoftwareCatalog] = useState<SoftwareCatalogItem[]>([]);

  // Ownership axis (#2133, mirrors software/ComplianceDashboard #2126):
  // partner-scope creators may own an automation partner-wide.
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();

  const fetchAutomation = useCallback(async () => {
    if (!automationId || isNew) return;

    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth(`/automations/${automationId}`);
      if (!response.ok) {
        throw new Error(t('automationEditPage.errors.fetch'));
      }
      const data = await response.json();
      const automation = data.automation ?? data;
      setManagedByAgentId(asString(automation.managedByAgentId) ?? null);

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
      setError(err instanceof Error ? err.message : t('automationEditPage.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [automationId, isNew, t]);

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

  const fetchSoftwareCatalog = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/software/catalog');
      if (response.ok) {
        const data = await response.json();
        setSoftwareCatalog(data.data ?? data.catalog ?? []);
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
    fetchSoftwareCatalog();
  }, [fetchAutomation, fetchSites, fetchGroups, fetchScripts, fetchChannels, fetchSoftwareCatalog]);

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
        // ownerScope is create-only (#2133): ownership never changes after
        // creation, and the server rejects it on non-partner callers.
        Object.assign(payload, {
          enabled: true,
          ...(isPartnerScope && values.ownerScope ? { ownerScope: values.ownerScope } : {})
        });
      }

      const url = isNew ? '/automations' : `/automations/${automationId}`;
      const method = isNew ? 'POST' : 'PUT';

      const response = await fetchWithAuth(url, {
        method,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(extractApiError(data, t('automationEditPage.errors.save')));
      }

      void navigateTo('/automations');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('automationEditPage.errors.generic'));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    void navigateTo('/automations');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('automationEditPage.loading')}</p>
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
          {t('common:actions.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Breadcrumbs items={[
        { label: t('automationEditPage.breadcrumb.automations'), href: '/automations' },
        { label: isNew ? t('automationEditPage.breadcrumb.new') : (defaultValues?.name || t('automationEditPage.breadcrumb.edit')) }
      ]} />
      <div className="flex items-center gap-4">
        <a
          href="/automations"
          className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
        >
          <ArrowLeft className="h-5 w-5" />
        </a>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {isNew ? t('automationEditPage.title.create') : t('automationEditPage.title.edit')}
          </h1>
          <p className="text-muted-foreground">
            {isNew
              ? t('automationEditPage.description.create')
              : t('automationEditPage.description.edit')}
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {managedByAgentId ? (
        <div
          className="rounded-lg border border-purple-500/40 bg-purple-500/10 p-6"
          data-testid="automation-managed-notice"
        >
          <div className="flex items-center gap-2 text-purple-700 dark:text-purple-200">
            <Bot className="h-5 w-5" />
            <h2 className="text-sm font-semibold">{t('automationEditPage.managed.title')}</h2>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('automationEditPage.managed.description')}
          </p>
        </div>
      ) : (
        <AutomationForm
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          defaultValues={isNew ? { ownerScope: defaultOwnerScope, ...defaultValues } : defaultValues}
          webhookUrl={webhookUrl}
          showOwnerScope={isNew && isPartnerScope}
          submitLabel={isNew ? t('automationEditPage.actions.create') : t('automationEditPage.actions.saveChanges')}
          loading={saving}
          sites={sites}
          groups={groups}
          scripts={scripts}
          notificationChannels={notificationChannels}
          softwareCatalog={softwareCatalog}
        />
      )}
    </div>
  );
}
