import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  CalendarClock,
  CheckCircle,
  Clock,
  GripVertical,
  Mail,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Webhook,
  Zap
} from 'lucide-react';
import { cn } from '@/lib/utils';

type TriggerType = 'schedule' | 'event' | 'alert' | 'webhook';
type ActionType = 'run_script' | 'send_alert' | 'create_ticket' | 'send_email' | 'call_webhook';
type ConditionField = 'site' | 'group' | 'os' | 'tag' | 'status';
type ConditionOperator = 'is' | 'is_not' | 'contains' | 'not_contains';

type TriggerConfig = {
  type: TriggerType;
  cron?: string;
  timezone?: string;
  eventType?: string;
  alertType?: string;
  alertSeverity?: string;
  webhookUrl?: string;
  webhookSecret?: string;
};

type DeviceCondition = {
  id: string;
  field: ConditionField;
  operator: ConditionOperator;
  value: string;
};

type TimeWindow = {
  enabled: boolean;
  startTime: string;
  endTime: string;
  timezone: string;
  days: string[];
};

type ActionInputMapping = {
  id: string;
  source: string;
  target: string;
};

type BaseAction = {
  id: string;
  type: ActionType;
  name: string;
  outputKey?: string;
  inputMappings: ActionInputMapping[];
};

type RunScriptAction = BaseAction & {
  type: 'run_script';
  scriptId?: string;
  scriptArgs?: string;
};

type SendAlertAction = BaseAction & {
  type: 'send_alert';
  severity?: string;
  title?: string;
  message?: string;
};

type CreateTicketAction = BaseAction & {
  type: 'create_ticket';
  title?: string;
  description?: string;
  priority?: string;
  queue?: string;
};

type SendEmailAction = BaseAction & {
  type: 'send_email';
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
};

type CallWebhookAction = BaseAction & {
  type: 'call_webhook';
  url?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  payload?: string;
  headers?: string;
};

type AutomationAction =
  | RunScriptAction
  | SendAlertAction
  | CreateTicketAction
  | SendEmailAction
  | CallWebhookAction;

type ErrorHandlingConfig = {
  retryCount: number;
  fallbackActionIds: string[];
};

type AutomationDraft = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: TriggerConfig;
  conditions: DeviceCondition[];
  timeWindow: TimeWindow;
  actions: AutomationAction[];
  errorHandling: ErrorHandlingConfig;
  nextRunAt?: string;
};

type ScriptOption = { id: string; name: string };
type DeviceOption = { id: string; name: string; siteName?: string; os?: string };

type AutomationRunSummary = {
  id: string;
  status: 'running' | 'success' | 'failed' | 'partial';
  startedAt: string;
  completedAt?: string;
  triggeredBy?: string;
  devicesTotal?: number;
};

type AutomationEditorProps = {
  automationId: string;
};

const triggerOptions: { value: TriggerType; label: string; description: string; icon: typeof Clock }[] = [
  { value: 'schedule', label: 'Schedule', description: 'Run on a cron schedule', icon: CalendarClock },
  { value: 'event', label: 'Event', description: 'Run on device or system events', icon: Zap },
  { value: 'alert', label: 'Alert', description: 'Run when an alert is triggered', icon: Bell },
  { value: 'webhook', label: 'Webhook', description: 'Run via webhook call', icon: Webhook }
];

const eventTypeOptions = [
  { value: 'device.online', label: 'Device Online' },
  { value: 'device.offline', label: 'Device Offline' },
  { value: 'patch.completed', label: 'Patch Completed' },
  { value: 'script.completed', label: 'Script Completed' },
  { value: 'security.alert', label: 'Security Alert' }
];

const alertTypeOptions = [
  { value: 'alert.triggered', label: 'Alert Triggered' },
  { value: 'alert.resolved', label: 'Alert Resolved' },
  { value: 'alert.acknowledged', label: 'Alert Acknowledged' }
];

const severityOptions = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'info', label: 'Info' }
];

const conditionFieldOptions = [
  { value: 'site', label: 'Site' },
  { value: 'group', label: 'Group' },
  { value: 'os', label: 'Operating System' },
  { value: 'tag', label: 'Tag' },
  { value: 'status', label: 'Status' }
];

const operatorOptions = [
  { value: 'is', label: 'Is' },
  { value: 'is_not', label: 'Is not' },
  { value: 'contains', label: 'Contains' },
  { value: 'not_contains', label: 'Does not contain' }
];

const dayOptions = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const timezoneOptions = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];

const actionTypeOptions: { value: ActionType; label: string }[] = [
  { value: 'run_script', label: 'Run Script' },
  { value: 'send_alert', label: 'Send Alert' },
  { value: 'create_ticket', label: 'Create Ticket' },
  { value: 'send_email', label: 'Send Email' },
  { value: 'call_webhook', label: 'Call Webhook' }
];

const ticketPriorityOptions = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' }
];

const webhookMethodOptions = ['POST', 'PUT', 'PATCH', 'GET'] as const;

const statusStyles: Record<AutomationRunSummary['status'], { label: string; className: string }> = {
  running: { label: 'Running', className: 'border-blue-500/40 bg-blue-500/10 text-blue-700' },
  success: { label: 'Success', className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700' },
  failed: { label: 'Failed', className: 'border-red-500/40 bg-red-500/10 text-red-700' },
  partial: { label: 'Partial', className: 'border-amber-500/40 bg-amber-500/10 text-amber-700' }
};

let idCounter = 0;
const createId = (prefix: string = 'id') => {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
};

const describeCron = (cron: string): string => {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return 'Invalid cron expression';
  if (cron === '0 * * * *') return 'Every hour at minute 0';
  if (cron === '*/5 * * * *') return 'Every 5 minutes';
  if (cron === '*/15 * * * *') return 'Every 15 minutes';
  if (cron === '0 9 * * *') return 'Every day at 9:00 AM';
  if (cron === '0 9 * * 1-5') return 'Weekdays at 9:00 AM';
  return cron;
};

const formatDateTime = (value?: string) => {
  if (!value) return 'Not scheduled';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const buildAction = (type: ActionType, base?: Partial<BaseAction>): AutomationAction => {
  const common: BaseAction = {
    id: base?.id ?? createId('act'),
    type,
    name: base?.name ?? '',
    outputKey: base?.outputKey ?? '',
    inputMappings: base?.inputMappings ?? []
  };

  switch (type) {
    case 'run_script':
      return { ...common, type, scriptId: '', scriptArgs: '' };
    case 'send_alert':
      return { ...common, type, severity: 'medium', title: '', message: '' };
    case 'create_ticket':
      return { ...common, type, title: '', description: '', priority: 'normal', queue: '' };
    case 'send_email':
      return { ...common, type, to: '', cc: '', subject: '', body: '' };
    case 'call_webhook':
      return { ...common, type, url: '', method: 'POST', payload: '', headers: '' };
    default:
      return { ...common, type: 'run_script', scriptId: '', scriptArgs: '' };
  }
};

const normalizeAction = (action: any): AutomationAction => {
  const typeMap: Record<string, ActionType> = {
    run_script: 'run_script',
    execute_command: 'run_script',
    send_notification: 'send_alert',
    create_alert: 'send_alert',
    send_alert: 'send_alert',
    create_ticket: 'create_ticket',
    send_email: 'send_email',
    call_webhook: 'call_webhook',
    webhook: 'call_webhook'
  };

  const resolvedType = typeMap[action?.type] ?? 'run_script';
  const base: Partial<BaseAction> = {
    id: action?.id ?? createId('act'),
    name: action?.name ?? '',
    outputKey: action?.outputKey ?? action?.outputVariable ?? '',
    inputMappings: Array.isArray(action?.inputMappings)
      ? action.inputMappings.map((mapping: any) => ({
          id: mapping.id ?? createId('map'),
          source: mapping.source ?? '',
          target: mapping.target ?? ''
        }))
      : []
  };

  const normalized = buildAction(resolvedType, base);
  if (normalized.type === 'run_script') {
    normalized.scriptId = action?.scriptId ?? action?.script_id ?? '';
    normalized.scriptArgs = action?.scriptArgs ?? action?.args ?? '';
  }
  if (normalized.type === 'send_alert') {
    normalized.severity = action?.severity ?? action?.alertSeverity ?? normalized.severity;
    normalized.title = action?.title ?? action?.alertTitle ?? '';
    normalized.message = action?.message ?? action?.alertMessage ?? '';
  }
  if (normalized.type === 'create_ticket') {
    normalized.title = action?.title ?? action?.summary ?? '';
    normalized.description = action?.description ?? action?.body ?? '';
    normalized.priority = action?.priority ?? normalized.priority;
    normalized.queue = action?.queue ?? action?.board ?? '';
  }
  if (normalized.type === 'send_email') {
    normalized.to = action?.to ?? '';
    normalized.cc = action?.cc ?? '';
    normalized.subject = action?.subject ?? '';
    normalized.body = action?.body ?? '';
  }
  if (normalized.type === 'call_webhook') {
    normalized.url = action?.url ?? action?.webhookUrl ?? '';
    normalized.method = action?.method ?? normalized.method;
    normalized.payload = action?.payload ?? action?.body ?? '';
    normalized.headers = action?.headers ?? '';
  }
  return normalized;
};

const normalizeAutomation = (payload: any, automationId: string): AutomationDraft => {
  const triggerConfig = payload?.triggerConfig ?? payload?.trigger ?? {};
  let triggerType = payload?.triggerType ?? payload?.trigger?.type ?? 'schedule';
  if (triggerType === 'event' && typeof triggerConfig.eventType === 'string') {
    if (triggerConfig.eventType.startsWith('alert.')) {
      triggerType = 'alert';
    }
  }

  const actions = Array.isArray(payload?.actions) ? payload.actions.map(normalizeAction) : [];
  return {
    id: payload?.id ?? automationId,
    name: payload?.name ?? 'Untitled Automation',
    description: payload?.description ?? '',
    enabled: payload?.enabled ?? true,
    trigger: {
      type: triggerType,
      cron: triggerConfig.cronExpression ?? triggerConfig.cron ?? '0 9 * * *',
      timezone: triggerConfig.timezone ?? 'UTC',
      eventType: triggerConfig.eventType ?? 'device.offline',
      alertType: triggerConfig.alertType ?? triggerConfig.eventType ?? 'alert.triggered',
      alertSeverity: triggerConfig.alertSeverity ?? 'medium',
      webhookUrl: triggerConfig.webhookUrl ?? payload?.webhookUrl ?? '',
      webhookSecret: triggerConfig.webhookSecret ?? ''
    },
    conditions: Array.isArray(payload?.conditions)
      ? payload.conditions.map((condition: any) => ({
          id: condition.id ?? createId('cond'),
          field: condition.field ?? condition.type ?? 'site',
          operator: condition.operator ?? 'is',
          value: condition.value ?? ''
        }))
      : [],
    timeWindow: {
      enabled: payload?.timeWindow?.enabled ?? false,
      startTime: payload?.timeWindow?.startTime ?? '09:00',
      endTime: payload?.timeWindow?.endTime ?? '17:00',
      timezone: payload?.timeWindow?.timezone ?? 'UTC',
      days: payload?.timeWindow?.days ?? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
    },
    actions: actions.length > 0 ? actions : [buildAction('run_script')],
    errorHandling: {
      retryCount: payload?.errorHandling?.retryCount ?? 0,
      fallbackActionIds: payload?.errorHandling?.fallbackActionIds ?? []
    },
    nextRunAt: payload?.nextRunAt ?? payload?.next_run_at
  };
};

const buildPayload = (draft: AutomationDraft) => ({
  name: draft.name,
  description: draft.description,
  enabled: draft.enabled,
  triggerType: draft.trigger.type,
  triggerConfig: {
    cronExpression: draft.trigger.type === 'schedule' ? draft.trigger.cron : undefined,
    timezone: draft.trigger.timezone,
    eventType: draft.trigger.type === 'event' ? draft.trigger.eventType : undefined,
    alertType: draft.trigger.type === 'alert' ? draft.trigger.alertType : undefined,
    alertSeverity: draft.trigger.type === 'alert' ? draft.trigger.alertSeverity : undefined,
    webhookUrl: draft.trigger.type === 'webhook' ? draft.trigger.webhookUrl : undefined,
    webhookSecret: draft.trigger.type === 'webhook' ? draft.trigger.webhookSecret : undefined
  },
  conditions: draft.conditions.map(({ id, ...rest }) => rest),
  timeWindow: draft.timeWindow,
  actions: draft.actions.map(action => {
    const base = {
      id: action.id,
      type: action.type,
      name: action.name,
      outputKey: action.outputKey,
      inputMappings: action.inputMappings.map(({ id, ...rest }) => rest)
    };
    switch (action.type) {
      case 'run_script':
        return { ...base, scriptId: action.scriptId, scriptArgs: action.scriptArgs };
      case 'send_alert':
        return { ...base, severity: action.severity, title: action.title, message: action.message };
      case 'create_ticket':
        return {
          ...base,
          title: action.title,
          description: action.description,
          priority: action.priority,
          queue: action.queue
        };
      case 'send_email':
        return { ...base, to: action.to, cc: action.cc, subject: action.subject, body: action.body };
      case 'call_webhook':
        return {
          ...base,
          url: action.url,
          method: action.method,
          payload: action.payload,
          headers: action.headers
        };
      default:
        return base;
    }
  }),
  errorHandling: draft.errorHandling
});

export default function AutomationEditor({ automationId }: AutomationEditorProps) {
  const [automation, setAutomation] = useState<AutomationDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [statusMessage, setStatusMessage] = useState<string>();
  const [scripts, setScripts] = useState<ScriptOption[]>([]);
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [runs, setRuns] = useState<AutomationRunSummary[]>([]);
  const [testDeviceId, setTestDeviceId] = useState('');
  const [testRunning, setTestRunning] = useState(false);
  const [toggleLoading, setToggleLoading] = useState(false);
  const [draggingActionId, setDraggingActionId] = useState<string | null>(null);
  const [dragOverActionId, setDragOverActionId] = useState<string | null>(null);

  const fetchAutomation = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch(`/api/automations/${automationId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch automation');
      }
      const data = await response.json();
      const payload = data?.automation ?? data;
      setAutomation(normalizeAutomation(payload, automationId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load automation');
    } finally {
      setLoading(false);
    }
  }, [automationId]);

  const fetchScripts = useCallback(async () => {
    try {
      const response = await fetch('/api/scripts');
      if (!response.ok) return;
      const data = await response.json();
      setScripts(data.scripts ?? data ?? []);
    } catch {
      // ignore
    }
  }, []);

  const fetchDevices = useCallback(async () => {
    try {
      const response = await fetch('/api/devices');
      if (!response.ok) return;
      const data = await response.json();
      setDevices(data.devices ?? data ?? []);
    } catch {
      // ignore
    }
  }, []);

  const fetchRuns = useCallback(async () => {
    try {
      const response = await fetch(`/api/automations/${automationId}/runs`);
      if (!response.ok) return;
      const data = await response.json();
      setRuns(data.runs ?? data ?? []);
    } catch {
      // ignore
    }
  }, [automationId]);

  useEffect(() => {
    fetchAutomation();
    fetchScripts();
    fetchDevices();
    fetchRuns();
  }, [fetchAutomation, fetchScripts, fetchDevices, fetchRuns]);

  const updateAutomation = useCallback((updater: (prev: AutomationDraft) => AutomationDraft) => {
    setAutomation(prev => (prev ? updater(prev) : prev));
  }, []);

  const handleSave = async () => {
    if (!automation) return;
    setSaving(true);
    setError(undefined);
    setStatusMessage(undefined);
    try {
      const response = await fetch(`/api/automations/${automationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload(automation))
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? 'Failed to save automation');
      }
      setStatusMessage('Automation saved successfully.');
      await fetchAutomation();
      await fetchRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save automation');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!automation) return;
    const nextEnabled = !automation.enabled;
    setToggleLoading(true);
    updateAutomation(prev => ({ ...prev, enabled: nextEnabled }));
    try {
      const response = await fetch(`/api/automations/${automationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled })
      });
      if (!response.ok) {
        throw new Error('Failed to update automation status');
      }
    } catch (err) {
      updateAutomation(prev => ({ ...prev, enabled: !nextEnabled }));
      setError(err instanceof Error ? err.message : 'Unable to update status');
    } finally {
      setToggleLoading(false);
    }
  };

  const handleTestRun = async () => {
    if (!automation || !testDeviceId) {
      setError('Select a test device before running.');
      return;
    }
    setTestRunning(true);
    setError(undefined);
    setStatusMessage(undefined);
    try {
      const response = await fetch(`/api/automations/${automationId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: testDeviceId, mode: 'test' })
      });
      if (!response.ok) {
        throw new Error('Failed to start test run');
      }
      setStatusMessage('Test run started. Check history for status updates.');
      await fetchRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start test run');
    } finally {
      setTestRunning(false);
    }
  };

  const handleActionDragStart = (id: string) => (event: DragEvent<HTMLDivElement>) => {
    setDraggingActionId(id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  };

  const handleActionDragOver = (id: string) => (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOverActionId(id);
  };

  const handleActionDrop = (id: string) => (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const dragId = draggingActionId ?? event.dataTransfer.getData('text/plain');
    if (!dragId || dragId === id) {
      setDragOverActionId(null);
      return;
    }
    updateAutomation(prev => {
      const dragIndex = prev.actions.findIndex(action => action.id === dragId);
      const targetIndex = prev.actions.findIndex(action => action.id === id);
      if (dragIndex === -1 || targetIndex === -1) return prev;
      const nextActions = [...prev.actions];
      const [dragged] = nextActions.splice(dragIndex, 1);
      nextActions.splice(targetIndex, 0, dragged);
      return { ...prev, actions: nextActions };
    });
    setDragOverActionId(null);
  };

  const handleActionDragEnd = () => {
    setDraggingActionId(null);
    setDragOverActionId(null);
  };

  const availableOutputKeys = useCallback(
    (index: number) => {
      if (!automation) return [];
      return automation.actions
        .slice(0, index)
        .filter(action => action.outputKey)
        .map(action => ({
          value: action.outputKey ?? '',
          label: `${action.outputKey} (step ${automation.actions.indexOf(action) + 1})`
        }));
    },
    [automation]
  );

  const nextRunPreview = useMemo(() => {
    if (!automation) return '';
    if (!automation.enabled) return 'Automation disabled';
    if (automation.trigger.type === 'schedule') {
      return automation.nextRunAt
        ? `Next run at ${formatDateTime(automation.nextRunAt)}`
        : `Next run based on ${automation.trigger.cron}`;
    }
    if (automation.trigger.type === 'event') return 'Runs when the selected event occurs';
    if (automation.trigger.type === 'alert') return 'Runs when alert conditions match';
    return 'Runs on incoming webhook calls';
  }, [automation]);

  const cronDescription = useMemo(() => {
    if (!automation?.trigger.cron) return '';
    return describeCron(automation.trigger.cron);
  }, [automation?.trigger.cron]);

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

  if (!automation) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error ?? 'Automation not found.'}</p>
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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <a
            href="/automations"
            className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
          >
            <ArrowLeft className="h-5 w-5" />
          </a>
          <div>
            <h1 className="text-2xl font-bold">Automation Editor</h1>
            <p className="text-muted-foreground">Configure triggers, conditions, and actions.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => (window.location.href = '/automations')}
            className="h-10 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save className="h-4 w-4" />
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {statusMessage && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">
          {statusMessage}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Basics</h2>
            <p className="text-sm text-muted-foreground">Give this automation a clear name and description.</p>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium">Name</label>
                <input
                  type="text"
                  value={automation.name}
                  onChange={event =>
                    updateAutomation(prev => ({ ...prev, name: event.target.value }))
                  }
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <label className="text-sm font-medium">Description</label>
                <textarea
                  rows={2}
                  value={automation.description}
                  onChange={event =>
                    updateAutomation(prev => ({ ...prev, description: event.target.value }))
                  }
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                />
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Trigger Configuration</h2>
                <p className="text-sm text-muted-foreground">Define how the automation starts.</p>
              </div>
              <span className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                {automation.trigger.type}
              </span>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {triggerOptions.map(option => {
                const Icon = option.icon;
                const isActive = automation.trigger.type === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() =>
                      updateAutomation(prev => ({
                        ...prev,
                        trigger: {
                          ...prev.trigger,
                          type: option.value,
                          cron: prev.trigger.cron ?? '0 9 * * *',
                          eventType: prev.trigger.eventType ?? 'device.offline',
                          alertType: prev.trigger.alertType ?? 'alert.triggered',
                          alertSeverity: prev.trigger.alertSeverity ?? 'medium'
                        }
                      }))
                    }
                    className={cn(
                      'flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition',
                      isActive
                        ? 'border-primary bg-primary/10'
                        : 'border-input bg-background hover:bg-muted'
                    )}
                  >
                    <Icon className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{option.label}</p>
                      <p className="text-xs text-muted-foreground">{option.description}</p>
                    </div>
                  </button>
                );
              })}
            </div>

            {automation.trigger.type === 'schedule' && (
              <div className="mt-5 grid gap-4 rounded-md border bg-background p-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Cron Expression</label>
                  <input
                    type="text"
                    value={automation.trigger.cron}
                    onChange={event =>
                      updateAutomation(prev => ({
                        ...prev,
                        trigger: { ...prev.trigger, cron: event.target.value }
                      }))
                    }
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  {cronDescription && (
                    <p className="text-xs text-muted-foreground">{cronDescription}</p>
                  )}
                  <div className="flex flex-wrap gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() =>
                        updateAutomation(prev => ({
                          ...prev,
                          trigger: { ...prev.trigger, cron: '*/15 * * * *' }
                        }))
                      }
                      className="rounded border px-2 py-1 hover:bg-muted"
                    >
                      Every 15 min
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        updateAutomation(prev => ({
                          ...prev,
                          trigger: { ...prev.trigger, cron: '0 * * * *' }
                        }))
                      }
                      className="rounded border px-2 py-1 hover:bg-muted"
                    >
                      Hourly
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        updateAutomation(prev => ({
                          ...prev,
                          trigger: { ...prev.trigger, cron: '0 9 * * *' }
                        }))
                      }
                      className="rounded border px-2 py-1 hover:bg-muted"
                    >
                      Daily 9 AM
                    </button>
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Timezone</label>
                  <select
                    value={automation.trigger.timezone}
                    onChange={event =>
                      updateAutomation(prev => ({
                        ...prev,
                        trigger: { ...prev.trigger, timezone: event.target.value }
                      }))
                    }
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {timezoneOptions.map(zone => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Next run preview updates based on cron and timezone.
                  </p>
                </div>
              </div>
            )}

            {automation.trigger.type === 'event' && (
              <div className="mt-5 grid gap-4 rounded-md border bg-background p-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Event Type</label>
                  <select
                    value={automation.trigger.eventType}
                    onChange={event =>
                      updateAutomation(prev => ({
                        ...prev,
                        trigger: { ...prev.trigger, eventType: event.target.value }
                      }))
                    }
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {eventTypeOptions.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="rounded-md border border-dashed bg-muted/20 p-4 text-xs text-muted-foreground">
                  Provide an event payload filter from the API if needed.
                </div>
              </div>
            )}

            {automation.trigger.type === 'alert' && (
              <div className="mt-5 grid gap-4 rounded-md border bg-background p-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Alert Type</label>
                  <select
                    value={automation.trigger.alertType}
                    onChange={event =>
                      updateAutomation(prev => ({
                        ...prev,
                        trigger: { ...prev.trigger, alertType: event.target.value }
                      }))
                    }
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {alertTypeOptions.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Alert Severity</label>
                  <select
                    value={automation.trigger.alertSeverity}
                    onChange={event =>
                      updateAutomation(prev => ({
                        ...prev,
                        trigger: { ...prev.trigger, alertSeverity: event.target.value }
                      }))
                    }
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {severityOptions.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {automation.trigger.type === 'webhook' && (
              <div className="mt-5 grid gap-4 rounded-md border bg-background p-4 md:grid-cols-2">
                <div className="space-y-2 md:col-span-2">
                  <label className="text-sm font-medium">Webhook URL</label>
                  <input
                    type="text"
                    value={automation.trigger.webhookUrl || 'Generated after save'}
                    readOnly
                    className="h-10 w-full rounded-md border bg-muted/40 px-3 text-sm font-mono text-muted-foreground"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Signing Secret</label>
                  <input
                    type="text"
                    value={automation.trigger.webhookSecret ?? ''}
                    onChange={event =>
                      updateAutomation(prev => ({
                        ...prev,
                        trigger: { ...prev.trigger, webhookSecret: event.target.value }
                      }))
                    }
                    placeholder="Optional shared secret"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="rounded-md border border-dashed bg-muted/20 p-4 text-xs text-muted-foreground">
                  Use the secret to verify webhook signatures.
                </div>
              </div>
            )}
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Conditions</h2>
                <p className="text-sm text-muted-foreground">
                  Filter which devices qualify and when actions can run.
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  updateAutomation(prev => ({
                    ...prev,
                    conditions: [
                      ...prev.conditions,
                      {
                        id: createId('cond'),
                        field: 'site',
                        operator: 'is',
                        value: ''
                      }
                    ]
                  }))
                }
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
              >
                <Plus className="h-4 w-4" />
                Add Filter
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {automation.conditions.length === 0 && (
                <div className="rounded-md border border-dashed bg-muted/10 p-4 text-sm text-muted-foreground">
                  No filters applied. All devices are eligible.
                </div>
              )}
              {automation.conditions.map(condition => (
                <div key={condition.id} className="flex flex-wrap gap-2 rounded-md border bg-background p-3">
                  <select
                    value={condition.field}
                    onChange={event =>
                      updateAutomation(prev => ({
                        ...prev,
                        conditions: prev.conditions.map(item =>
                          item.id === condition.id
                            ? { ...item, field: event.target.value as ConditionField }
                            : item
                        )
                      }))
                    }
                    className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {conditionFieldOptions.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={condition.operator}
                    onChange={event =>
                      updateAutomation(prev => ({
                        ...prev,
                        conditions: prev.conditions.map(item =>
                          item.id === condition.id
                            ? { ...item, operator: event.target.value as ConditionOperator }
                            : item
                        )
                      }))
                    }
                    className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {operatorOptions.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={condition.value}
                    onChange={event =>
                      updateAutomation(prev => ({
                        ...prev,
                        conditions: prev.conditions.map(item =>
                          item.id === condition.id ? { ...item, value: event.target.value } : item
                        )
                      }))
                    }
                    placeholder="Value"
                    className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      updateAutomation(prev => ({
                        ...prev,
                        conditions: prev.conditions.filter(item => item.id !== condition.id)
                      }))
                    }
                    className="flex h-9 w-9 items-center justify-center rounded-md text-destructive hover:bg-muted"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-md border bg-muted/20 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold">Time Window</h3>
                  <p className="text-xs text-muted-foreground">Restrict execution to specific days and hours.</p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    updateAutomation(prev => ({
                      ...prev,
                      timeWindow: { ...prev.timeWindow, enabled: !prev.timeWindow.enabled }
                    }))
                  }
                  className={cn(
                    'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold',
                    automation.timeWindow.enabled
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : 'border-slate-200 bg-slate-50 text-slate-600'
                  )}
                >
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full',
                      automation.timeWindow.enabled ? 'bg-emerald-500' : 'bg-slate-400'
                    )}
                  />
                  {automation.timeWindow.enabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>

              {automation.timeWindow.enabled && (
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Start Time</label>
                    <input
                      type="time"
                      value={automation.timeWindow.startTime}
                      onChange={event =>
                        updateAutomation(prev => ({
                          ...prev,
                          timeWindow: { ...prev.timeWindow, startTime: event.target.value }
                        }))
                      }
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">End Time</label>
                    <input
                      type="time"
                      value={automation.timeWindow.endTime}
                      onChange={event =>
                        updateAutomation(prev => ({
                          ...prev,
                          timeWindow: { ...prev.timeWindow, endTime: event.target.value }
                        }))
                      }
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <label className="text-sm font-medium">Days of Week</label>
                    <div className="flex flex-wrap gap-2">
                      {dayOptions.map(day => (
                        <button
                          key={day}
                          type="button"
                          onClick={() =>
                            updateAutomation(prev => {
                              const hasDay = prev.timeWindow.days.includes(day);
                              return {
                                ...prev,
                                timeWindow: {
                                  ...prev.timeWindow,
                                  days: hasDay
                                    ? prev.timeWindow.days.filter(item => item !== day)
                                    : [...prev.timeWindow.days, day]
                                }
                              };
                            })
                          }
                          className={cn(
                            'rounded-full border px-3 py-1 text-xs font-medium',
                            automation.timeWindow.days.includes(day)
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-input bg-background text-muted-foreground'
                          )}
                        >
                          {day}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <label className="text-sm font-medium">Timezone</label>
                    <select
                      value={automation.timeWindow.timezone}
                      onChange={event =>
                        updateAutomation(prev => ({
                          ...prev,
                          timeWindow: { ...prev.timeWindow, timezone: event.target.value }
                        }))
                      }
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      {timezoneOptions.map(zone => (
                        <option key={zone} value={zone}>
                          {zone}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Action Sequence</h2>
                <p className="text-sm text-muted-foreground">
                  Drag actions to reorder. Outputs can feed into later steps.
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  updateAutomation(prev => ({
                    ...prev,
                    actions: [...prev.actions, buildAction('run_script')]
                  }))
                }
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
              >
                <Plus className="h-4 w-4" />
                Add Action
              </button>
            </div>

            <div className="mt-4 space-y-4">
              {automation.actions.map((action, index) => {
                const outputs = availableOutputKeys(index);
                return (
                  <div
                    key={action.id}
                    draggable
                    onDragStart={handleActionDragStart(action.id)}
                    onDragOver={handleActionDragOver(action.id)}
                    onDrop={handleActionDrop(action.id)}
                    onDragEnd={handleActionDragEnd}
                    className={cn(
                      'rounded-md border bg-muted/20 p-4 transition',
                      dragOverActionId === action.id ? 'border-primary/60 ring-1 ring-primary/20' : ''
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                        {index + 1}
                      </div>
                      <div className="flex-1 space-y-4">
                        <div className="flex flex-wrap items-center gap-3">
                          <GripVertical className="h-4 w-4 text-muted-foreground" />
                          <select
                            value={action.type}
                            onChange={event =>
                              updateAutomation(prev => ({
                                ...prev,
                                actions: prev.actions.map(item =>
                                  item.id === action.id
                                    ? buildAction(event.target.value as ActionType, item)
                                    : item
                                )
                              }))
                            }
                            className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          >
                            {actionTypeOptions.map(option => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                          <input
                            type="text"
                            value={action.name}
                            onChange={event =>
                              updateAutomation(prev => ({
                                ...prev,
                                actions: prev.actions.map(item =>
                                  item.id === action.id
                                    ? { ...item, name: event.target.value }
                                    : item
                                )
                              }))
                            }
                            placeholder="Optional action name"
                            className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          />
                        </div>

                        {action.type === 'run_script' && (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-2">
                              <label className="text-xs font-medium text-muted-foreground">Script</label>
                              <select
                                value={action.scriptId ?? ''}
                                onChange={event =>
                                  updateAutomation(prev => ({
                                    ...prev,
                                    actions: prev.actions.map(item =>
                                      item.id === action.id
                                        ? { ...item, scriptId: event.target.value }
                                        : item
                                    )
                                  }))
                                }
                                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                              >
                                <option value="">Select a script...</option>
                                {scripts.map(script => (
                                  <option key={script.id} value={script.id}>
                                    {script.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="space-y-2">
                              <label className="text-xs font-medium text-muted-foreground">Arguments</label>
                              <input
                                type="text"
                                value={action.scriptArgs ?? ''}
                                onChange={event =>
                                  updateAutomation(prev => ({
                                    ...prev,
                                    actions: prev.actions.map(item =>
                                      item.id === action.id
                                        ? { ...item, scriptArgs: event.target.value }
                                        : item
                                    )
                                  }))
                                }
                                placeholder="--target /tmp"
                                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                              />
                            </div>
                          </div>
                        )}

                        {action.type === 'send_alert' && (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-2">
                              <label className="text-xs font-medium text-muted-foreground">Severity</label>
                              <select
                                value={action.severity ?? 'medium'}
                                onChange={event =>
                                  updateAutomation(prev => ({
                                    ...prev,
                                    actions: prev.actions.map(item =>
                                      item.id === action.id
                                        ? { ...item, severity: event.target.value }
                                        : item
                                    )
                                  }))
                                }
                                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                              >
                                {severityOptions.map(option => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="space-y-2">
                              <label className="text-xs font-medium text-muted-foreground">Title</label>
                              <input
                                type="text"
                                value={action.title ?? ''}
                                onChange={event =>
                                  updateAutomation(prev => ({
                                    ...prev,
                                    actions: prev.actions.map(item =>
                                      item.id === action.id
                                        ? { ...item, title: event.target.value }
                                        : item
                                    )
                                  }))
                                }
                                placeholder="Alert title"
                                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                              />
                            </div>
                            <div className="space-y-2 sm:col-span-2">
                              <label className="text-xs font-medium text-muted-foreground">Message</label>
                              <textarea
                                rows={2}
                                value={action.message ?? ''}
                                onChange={event =>
                                  updateAutomation(prev => ({
                                    ...prev,
                                    actions: prev.actions.map(item =>
                                      item.id === action.id
                                        ? { ...item, message: event.target.value }
                                        : item
                                    )
                                  }))
                                }
                                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                              />
                            </div>
                          </div>
                        )}

                        {action.type === 'create_ticket' && (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-2">
                              <label className="text-xs font-medium text-muted-foreground">Title</label>
                              <input
                                type="text"
                                value={action.title ?? ''}
                                onChange={event =>
                                  updateAutomation(prev => ({
                                    ...prev,
                                    actions: prev.actions.map(item =>
                                      item.id === action.id
                                        ? { ...item, title: event.target.value }
                                        : item
                                    )
                                  }))
                                }
                                placeholder="Ticket title"
                                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                              />
                            </div>
                            <div className="space-y-2">
                              <label className="text-xs font-medium text-muted-foreground">Priority</label>
                              <select
                                value={action.priority ?? 'normal'}
                                onChange={event =>
                                  updateAutomation(prev => ({
                                    ...prev,
                                    actions: prev.actions.map(item =>
                                      item.id === action.id
                                        ? { ...item, priority: event.target.value }
                                        : item
                                    )
                                  }))
                                }
                                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                              >
                                {ticketPriorityOptions.map(option => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="space-y-2">
                              <label className="text-xs font-medium text-muted-foreground">Queue</label>
                              <input
                                type="text"
                                value={action.queue ?? ''}
                                onChange={event =>
                                  updateAutomation(prev => ({
                                    ...prev,
                                    actions: prev.actions.map(item =>
                                      item.id === action.id
                                        ? { ...item, queue: event.target.value }
                                        : item
                                    )
                                  }))
                                }
                                placeholder="Service Desk"
                                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                              />
                            </div>
                            <div className="space-y-2 sm:col-span-2">
                              <label className="text-xs font-medium text-muted-foreground">Description</label>
                              <textarea
                                rows={2}
                                value={action.description ?? ''}
                                onChange={event =>
                                  updateAutomation(prev => ({
                                    ...prev,
                                    actions: prev.actions.map(item =>
                                      item.id === action.id
                                        ? { ...item, description: event.target.value }
                                        : item
                                    )
                                  }))
                                }
                                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                              />
                            </div>
                          </div>
                        )}

                        {action.type === 'send_email' && (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-2">
                              <label className="text-xs font-medium text-muted-foreground">To</label>
                              <input
                                type="text"
                                value={action.to ?? ''}
                                onChange={event =>
                                  updateAutomation(prev => ({
                                    ...prev,
                                    actions: prev.actions.map(item =>
                                      item.id === action.id
                                        ? { ...item, to: event.target.value }
                                        : item
                                    )
                                  }))
                                }
                                placeholder="ops@example.com"
                                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                              />
                            </div>
                            <div className="space-y-2">
                              <label className="text-xs font-medium text-muted-foreground">CC</label>
                              <input
                                type="text"
                                value={action.cc ?? ''}
                                onChange={event =>
                                  updateAutomation(prev => ({
                                    ...prev,
                                    actions: prev.actions.map(item =>
                                      item.id === action.id
                                        ? { ...item, cc: event.target.value }
                                        : item
                                    )
                                  }))
                                }
                                placeholder="team@example.com"
                                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                              />
                            </div>
                            <div className="space-y-2 sm:col-span-2">
                              <label className="text-xs font-medium text-muted-foreground">Subject</label>
                              <input
                                type="text"
                                value={action.subject ?? ''}
                                onChange={event =>
                                  updateAutomation(prev => ({
                                    ...prev,
                                    actions: prev.actions.map(item =>
                                      item.id === action.id
                                        ? { ...item, subject: event.target.value }
                                        : item
                                    )
                                  }))
                                }
                                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                              />
                            </div>
                            <div className="space-y-2 sm:col-span-2">
                              <label className="text-xs font-medium text-muted-foreground">Body</label>
                              <textarea
                                rows={2}
                                value={action.body ?? ''}
                                onChange={event =>
                                  updateAutomation(prev => ({
                                    ...prev,
                                    actions: prev.actions.map(item =>
                                      item.id === action.id
                                        ? { ...item, body: event.target.value }
                                        : item
                                    )
                                  }))
                                }
                                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                              />
                            </div>
                          </div>
                        )}

                        {action.type === 'call_webhook' && (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-2 sm:col-span-2">
                              <label className="text-xs font-medium text-muted-foreground">Webhook URL</label>
                              <input
                                type="url"
                                value={action.url ?? ''}
                                onChange={event =>
                                  updateAutomation(prev => ({
                                    ...prev,
                                    actions: prev.actions.map(item =>
                                      item.id === action.id
                                        ? { ...item, url: event.target.value }
                                        : item
                                    )
                                  }))
                                }
                                placeholder="https://hooks.example.com"
                                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                              />
                            </div>
                            <div className="space-y-2">
                              <label className="text-xs font-medium text-muted-foreground">Method</label>
                              <select
                                value={action.method ?? 'POST'}
                                onChange={event =>
                                  updateAutomation(prev => ({
                                    ...prev,
                                    actions: prev.actions.map(item =>
                                      item.id === action.id
                                        ? { ...item, method: event.target.value as CallWebhookAction['method'] }
                                        : item
                                    )
                                  }))
                                }
                                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                              >
                                {webhookMethodOptions.map(option => (
                                  <option key={option} value={option}>
                                    {option}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="space-y-2">
                              <label className="text-xs font-medium text-muted-foreground">Headers</label>
                              <input
                                type="text"
                                value={action.headers ?? ''}
                                onChange={event =>
                                  updateAutomation(prev => ({
                                    ...prev,
                                    actions: prev.actions.map(item =>
                                      item.id === action.id
                                        ? { ...item, headers: event.target.value }
                                        : item
                                    )
                                  }))
                                }
                                placeholder="Authorization: Bearer ..."
                                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                              />
                            </div>
                            <div className="space-y-2 sm:col-span-2">
                              <label className="text-xs font-medium text-muted-foreground">Payload</label>
                              <textarea
                                rows={2}
                                value={action.payload ?? ''}
                                onChange={event =>
                                  updateAutomation(prev => ({
                                    ...prev,
                                    actions: prev.actions.map(item =>
                                      item.id === action.id
                                        ? { ...item, payload: event.target.value }
                                        : item
                                    )
                                  }))
                                }
                                placeholder='{"device":"{{deviceId}}"}'
                                className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                              />
                            </div>
                          </div>
                        )}

                        <div className="rounded-md border bg-background p-4">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-xs font-semibold">Variable Passing</p>
                              <p className="text-xs text-muted-foreground">
                                Expose outputs and map them into this action.
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                updateAutomation(prev => ({
                                  ...prev,
                                  actions: prev.actions.map(item =>
                                    item.id === action.id
                                      ? {
                                          ...item,
                                          inputMappings: [
                                            ...item.inputMappings,
                                            { id: createId('map'), source: '', target: '' }
                                          ]
                                        }
                                      : item
                                  )
                                }))
                              }
                              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                            >
                              <Plus className="h-3 w-3" />
                              Add Mapping
                            </button>
                          </div>
                          <div className="mt-3 space-y-3">
                            <div className="space-y-2">
                              <label className="text-xs font-medium text-muted-foreground">Output Variable</label>
                              <input
                                type="text"
                                value={action.outputKey ?? ''}
                                onChange={event =>
                                  updateAutomation(prev => ({
                                    ...prev,
                                    actions: prev.actions.map(item =>
                                      item.id === action.id
                                        ? { ...item, outputKey: event.target.value }
                                        : item
                                    )
                                  }))
                                }
                                placeholder="e.g. diskReport"
                                className="h-8 w-full rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                              />
                              <p className="text-xs text-muted-foreground">
                                This output becomes available to later actions.
                              </p>
                            </div>

                            {outputs.length === 0 && (
                              <p className="text-xs text-muted-foreground">
                                Add output variables to previous actions to map inputs here.
                              </p>
                            )}

                            {action.inputMappings.map(mapping => (
                              <div key={mapping.id} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                                <select
                                  value={mapping.source}
                                  onChange={event =>
                                    updateAutomation(prev => ({
                                      ...prev,
                                      actions: prev.actions.map(item =>
                                        item.id === action.id
                                          ? {
                                              ...item,
                                              inputMappings: item.inputMappings.map(entry =>
                                                entry.id === mapping.id
                                                  ? { ...entry, source: event.target.value }
                                                  : entry
                                              )
                                            }
                                          : item
                                      )
                                    }))
                                  }
                                  className="h-8 rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                                >
                                  <option value="">Select output...</option>
                                  {outputs.map(option => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                                <input
                                  type="text"
                                  value={mapping.target}
                                  onChange={event =>
                                    updateAutomation(prev => ({
                                      ...prev,
                                      actions: prev.actions.map(item =>
                                        item.id === action.id
                                          ? {
                                              ...item,
                                              inputMappings: item.inputMappings.map(entry =>
                                                entry.id === mapping.id
                                                  ? { ...entry, target: event.target.value }
                                                  : entry
                                              )
                                            }
                                          : item
                                      )
                                    }))
                                  }
                                  placeholder="Parameter name"
                                  className="h-8 rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    updateAutomation(prev => ({
                                      ...prev,
                                      actions: prev.actions.map(item =>
                                        item.id === action.id
                                          ? {
                                              ...item,
                                              inputMappings: item.inputMappings.filter(
                                                entry => entry.id !== mapping.id
                                              )
                                            }
                                          : item
                                      )
                                    }))
                                  }
                                  className="flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() =>
                          updateAutomation(prev => ({
                            ...prev,
                            actions: prev.actions.filter(item => item.id !== action.id),
                            errorHandling: {
                              ...prev.errorHandling,
                              fallbackActionIds: prev.errorHandling.fallbackActionIds.filter(
                                fallbackId => fallbackId !== action.id
                              )
                            }
                          }))
                        }
                        className="flex h-9 w-9 items-center justify-center rounded-md text-destructive hover:bg-muted"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Error Handling</h2>
                <p className="text-sm text-muted-foreground">
                  Configure retries and fallback actions when a step fails.
                </p>
              </div>
              <AlertTriangle className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium">Retry Count</label>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={automation.errorHandling.retryCount}
                  onChange={event =>
                    updateAutomation(prev => ({
                      ...prev,
                      errorHandling: {
                        ...prev.errorHandling,
                        retryCount: Number(event.target.value)
                      }
                    }))
                  }
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <label className="text-sm font-medium">Fallback Actions</label>
                <div className="grid gap-2 md:grid-cols-2">
                  {automation.actions.map((action, index) => {
                    const checked = automation.errorHandling.fallbackActionIds.includes(action.id);
                    return (
                      <label
                        key={action.id}
                        className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            updateAutomation(prev => ({
                              ...prev,
                              errorHandling: {
                                ...prev.errorHandling,
                                fallbackActionIds: checked
                                  ? prev.errorHandling.fallbackActionIds.filter(id => id !== action.id)
                                  : [...prev.errorHandling.fallbackActionIds, action.id]
                              }
                            }))
                          }
                          className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                        />
                        <span>
                          Step {index + 1} - {action.name || actionTypeOptions.find(opt => opt.value === action.type)?.label}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Status</h2>
                <p className="text-sm text-muted-foreground">Enable or pause this automation.</p>
              </div>
              <button
                type="button"
                onClick={handleToggleEnabled}
                disabled={toggleLoading}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold',
                  automation.enabled
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-slate-200 bg-slate-50 text-slate-600'
                )}
              >
                <span
                  className={cn(
                    'h-2 w-2 rounded-full',
                    automation.enabled ? 'bg-emerald-500' : 'bg-slate-400'
                  )}
                />
                {automation.enabled ? 'Enabled' : 'Disabled'}
              </button>
            </div>
            <div className="mt-4 rounded-md border bg-muted/20 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <CalendarClock className="h-4 w-4 text-muted-foreground" />
                Next Run Preview
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{nextRunPreview}</p>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Test Run</h2>
                <p className="text-sm text-muted-foreground">Execute against a test device.</p>
              </div>
              <Play className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="mt-4 space-y-3">
              <select
                value={testDeviceId}
                onChange={event => setTestDeviceId(event.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Select a test device...</option>
                {devices.map(device => (
                  <option key={device.id} value={device.id}>
                    {device.name}
                    {device.siteName ? ` (${device.siteName})` : ''}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleTestRun}
                disabled={testRunning}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {testRunning ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    Running...
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4" />
                    Run Test
                  </>
                )}
              </button>
              <p className="text-xs text-muted-foreground">
                Test runs execute against the selected device only.
              </p>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Execution History</h2>
                <p className="text-sm text-muted-foreground">Recent automation runs.</p>
              </div>
              <button
                type="button"
                onClick={fetchRuns}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </button>
            </div>
            <div className="mt-4 space-y-3">
              {runs.length === 0 && (
                <div className="rounded-md border border-dashed bg-muted/10 p-4 text-sm text-muted-foreground">
                  No runs yet. Trigger a test run to see results.
                </div>
              )}
              {runs.slice(0, 6).map(run => {
                const status = statusStyles[run.status] ?? statusStyles.running;
                return (
                  <div key={run.id} className="rounded-md border bg-background p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">{formatDateTime(run.startedAt)}</p>
                        <p className="text-xs text-muted-foreground">
                          {run.triggeredBy ?? 'manual'} {run.devicesTotal ? `• ${run.devicesTotal} devices` : ''}
                        </p>
                      </div>
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                          status.className
                        )}
                      >
                        {status.label}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                <CheckCircle className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium">Ready to go</p>
                <p className="text-xs text-muted-foreground">
                  Save changes to update the automation in production.
                </p>
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Mail className="h-3.5 w-3.5" />
                Notifications for failures can be added via alert actions.
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Zap className="h-3.5 w-3.5" />
                Use output keys to wire data into later steps.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
