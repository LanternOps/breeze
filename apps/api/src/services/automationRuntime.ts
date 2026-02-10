import { randomBytes } from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DeploymentTargetConfig } from '@breeze/shared';
import { db } from '../db';
import {
  alertRules,
  alerts,
  alertTemplates,
  automations,
  automationRuns,
  deviceGroupMemberships,
  devices,
  notificationChannels,
  scripts,
} from '../db/schema';
import { resolveDeploymentTargets } from './deploymentEngine';
import { CommandTypes, queueCommandForExecution } from './commandQueue';
import { publishEvent } from './eventBus';
import {
  getEmailRecipients,
  sendEmailNotification,
  sendWebhookNotification,
} from './notificationSenders';

const ALERT_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

export type AlertSeverity = typeof ALERT_SEVERITIES[number];

export type AutomationTrigger =
  | {
      type: 'schedule';
      cronExpression: string;
      timezone: string;
    }
  | {
      type: 'event';
      eventType: string;
      filter?: Record<string, unknown>;
    }
  | {
      type: 'webhook';
      secret?: string;
      webhookUrl?: string;
    }
  | {
      type: 'manual';
    };

export type RunScriptAction = {
  type: 'run_script';
  scriptId: string;
  parameters?: Record<string, unknown>;
  runAs?: 'system' | 'user' | 'elevated' | string;
};

export type SendNotificationAction = {
  type: 'send_notification';
  notificationChannelId: string;
  title?: string;
  message?: string;
  severity?: AlertSeverity;
};

export type CreateAlertAction = {
  type: 'create_alert';
  alertSeverity: AlertSeverity;
  alertMessage: string;
  alertTitle?: string;
};

export type ExecuteCommandAction = {
  type: 'execute_command';
  command: string;
  shell?: 'bash' | 'powershell' | 'cmd';
};

export type AutomationAction =
  | RunScriptAction
  | SendNotificationAction
  | CreateAlertAction
  | ExecuteCommandAction;

export type NotificationTargets = {
  channelIds?: string[];
  emails?: string[];
};

type AutomationRow = typeof automations.$inferSelect;
type AutomationRunRow = typeof automationRuns.$inferSelect;

type LogLevel = 'info' | 'warning' | 'error';

type AutomationLogEntry = {
  timestamp: string;
  level: LogLevel;
  message: string;
  actionType?: string;
  actionIndex?: number;
  deviceId?: string;
  commandId?: string;
  alertId?: string;
  channelId?: string;
  details?: Record<string, unknown>;
};

export class AutomationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationValidationError';
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function normalizeSeverity(value: unknown, fallback: AlertSeverity = 'medium'): AlertSeverity {
  if (typeof value !== 'string') return fallback;
  if ((ALERT_SEVERITIES as readonly string[]).includes(value)) {
    return value as AlertSeverity;
  }
  return fallback;
}

function toTriggerBase(input: unknown): Record<string, unknown> {
  if (!isPlainRecord(input)) {
    throw new AutomationValidationError('trigger must be an object');
  }
  return input;
}

function isDeploymentTargetConfig(value: unknown): value is DeploymentTargetConfig {
  if (!isPlainRecord(value)) return false;
  const type = asString(value.type);
  return type === 'all' || type === 'devices' || type === 'groups' || type === 'filter';
}

function normalizeLegacyConditions(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) return [];
  return input.filter((item): item is Record<string, unknown> => isPlainRecord(item));
}

function validateCronExpression(cronExpression: string): void {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new AutomationValidationError('schedule trigger cron expression must have 5 fields');
  }
}

export function normalizeAutomationTrigger(input: unknown): AutomationTrigger {
  const value = toTriggerBase(input);
  const type = asString(value.type);

  if (!type) {
    throw new AutomationValidationError('trigger.type is required');
  }

  if (type === 'manual') {
    return { type: 'manual' };
  }

  if (type === 'schedule') {
    const cronExpression = asString(value.cronExpression) ?? asString(value.cron);
    if (!cronExpression) {
      throw new AutomationValidationError('schedule trigger requires cronExpression');
    }
    validateCronExpression(cronExpression);
    return {
      type: 'schedule',
      cronExpression,
      timezone: asString(value.timezone) ?? 'UTC',
    };
  }

  if (type === 'event') {
    const eventType = asString(value.eventType) ?? asString(value.event);
    if (!eventType) {
      throw new AutomationValidationError('event trigger requires eventType');
    }
    return {
      type: 'event',
      eventType,
      filter: isPlainRecord(value.filter) ? value.filter : undefined,
    };
  }

  if (type === 'webhook') {
    const secret = asNonEmptyString(value.secret) ?? asNonEmptyString(value.webhookSecret);
    const webhookUrl = asNonEmptyString(value.webhookUrl);
    return {
      type: 'webhook',
      secret,
      webhookUrl,
    };
  }

  throw new AutomationValidationError(`unsupported trigger type: ${type}`);
}

export function withWebhookDefaults(
  trigger: AutomationTrigger,
  automationId: string,
  requestUrl: string,
): AutomationTrigger {
  if (trigger.type !== 'webhook') {
    return trigger;
  }

  let origin = '';
  try {
    origin = new URL(requestUrl).origin;
  } catch {
    origin = '';
  }

  const webhookUrl = trigger.webhookUrl
    ?? (origin ? `${origin}/api/v1/automations/webhooks/${automationId}` : undefined);

  return {
    ...trigger,
    secret: trigger.secret ?? randomBytes(24).toString('hex'),
    webhookUrl,
  };
}

export function normalizeAutomationActions(input: unknown): AutomationAction[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new AutomationValidationError('actions must be a non-empty array');
  }

  const normalized: AutomationAction[] = [];

  for (const [index, action] of input.entries()) {
    if (!isPlainRecord(action)) {
      throw new AutomationValidationError(`actions[${index}] must be an object`);
    }

    const type = asString(action.type);
    if (!type) {
      throw new AutomationValidationError(`actions[${index}].type is required`);
    }

    if (type === 'run_script') {
      const scriptId = asString(action.scriptId) ?? asString(action.script_id);
      if (!scriptId) {
        throw new AutomationValidationError(`actions[${index}] run_script requires scriptId`);
      }
      normalized.push({
        type: 'run_script',
        scriptId,
        parameters: isPlainRecord(action.parameters) ? action.parameters : undefined,
        runAs: asString(action.runAs),
      });
      continue;
    }

    if (type === 'send_notification') {
      const notificationChannelId = asString(action.notificationChannelId)
        ?? asString(action.channelId)
        ?? asString(action.notification_channel_id);
      if (!notificationChannelId) {
        throw new AutomationValidationError(`actions[${index}] send_notification requires notificationChannelId`);
      }
      normalized.push({
        type: 'send_notification',
        notificationChannelId,
        title: asString(action.title),
        message: asString(action.message),
        severity: normalizeSeverity(action.severity),
      });
      continue;
    }

    if (type === 'create_alert') {
      const alertMessage = asString(action.alertMessage) ?? asString(action.message);
      if (!alertMessage) {
        throw new AutomationValidationError(`actions[${index}] create_alert requires alertMessage`);
      }
      normalized.push({
        type: 'create_alert',
        alertSeverity: normalizeSeverity(action.alertSeverity ?? action.severity),
        alertMessage,
        alertTitle: asString(action.alertTitle) ?? asString(action.title),
      });
      continue;
    }

    if (type === 'execute_command') {
      const command = asString(action.command);
      if (!command) {
        throw new AutomationValidationError(`actions[${index}] execute_command requires command`);
      }
      const shell = asString(action.shell);
      normalized.push({
        type: 'execute_command',
        command,
        shell: shell === 'bash' || shell === 'powershell' || shell === 'cmd' ? shell : undefined,
      });
      continue;
    }

    throw new AutomationValidationError(`unsupported action type: ${type}`);
  }

  return normalized;
}

export function normalizeNotificationTargets(input: unknown): NotificationTargets | undefined {
  if (!input) return undefined;

  if (Array.isArray(input)) {
    const channelIds = asStringArray(input);
    return channelIds.length > 0 ? { channelIds } : undefined;
  }

  if (!isPlainRecord(input)) return undefined;

  const channelIds = asStringArray(input.channelIds ?? input.notificationChannelIds);
  const emails = asStringArray(input.emails);

  if (channelIds.length === 0 && emails.length === 0) {
    return undefined;
  }

  return {
    channelIds: channelIds.length > 0 ? channelIds : undefined,
    emails: emails.length > 0 ? emails : undefined,
  };
}

export type NormalizedAutomationInput = {
  trigger: AutomationTrigger;
  actions: AutomationAction[];
  conditions?: unknown;
  onFailure: 'stop' | 'continue' | 'notify';
  notificationTargets?: NotificationTargets;
};

export function normalizeAutomationInput(input: {
  trigger: unknown;
  actions: unknown;
  conditions?: unknown;
  onFailure?: unknown;
  notificationTargets?: unknown;
}): NormalizedAutomationInput {
  const trigger = normalizeAutomationTrigger(input.trigger);
  const actions = normalizeAutomationActions(input.actions);

  const onFailure = input.onFailure === 'continue' || input.onFailure === 'notify'
    ? input.onFailure
    : 'stop';

  return {
    trigger,
    actions,
    conditions: input.conditions,
    onFailure,
    notificationTargets: normalizeNotificationTargets(input.notificationTargets),
  };
}

function coerceToFilterValue(condition: Record<string, unknown>): string {
  return asString(condition.value) ?? '';
}

async function resolveLegacyConditionTargets(orgId: string, conditionsInput: unknown): Promise<string[]> {
  const conditions = normalizeLegacyConditions(conditionsInput);
  if (conditions.length === 0) {
    const orgDevices = await db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.orgId, orgId));
    return orgDevices.map((device) => device.id);
  }

  const orgDevices = await db
    .select({
      id: devices.id,
      siteId: devices.siteId,
      osType: devices.osType,
      tags: devices.tags,
    })
    .from(devices)
    .where(eq(devices.orgId, orgId));

  const deviceIds = orgDevices.map((device) => device.id);
  const groupMembers = deviceIds.length > 0
    ? await db
      .select({
        deviceId: deviceGroupMemberships.deviceId,
        groupId: deviceGroupMemberships.groupId,
      })
      .from(deviceGroupMemberships)
      .where(inArray(deviceGroupMemberships.deviceId, deviceIds))
    : [];

  const groupsByDevice = new Map<string, Set<string>>();
  for (const member of groupMembers) {
    const bucket = groupsByDevice.get(member.deviceId) ?? new Set<string>();
    bucket.add(member.groupId);
    groupsByDevice.set(member.deviceId, bucket);
  }

  const matchesCondition = (
    condition: Record<string, unknown>,
    device: { id: string; siteId: string; osType: string; tags: string[] | null },
  ) => {
    const type = asString(condition.type);
    const operator = asString(condition.operator) ?? 'is';
    const value = coerceToFilterValue(condition);

    if (!type || !value) return true;

    const evaluateString = (candidate: string | undefined) => {
      const normalizedCandidate = (candidate ?? '').toLowerCase();
      const normalizedValue = value.toLowerCase();

      if (operator === 'is') return normalizedCandidate === normalizedValue;
      if (operator === 'is_not') return normalizedCandidate !== normalizedValue;
      if (operator === 'contains') return normalizedCandidate.includes(normalizedValue);
      if (operator === 'not_contains') return !normalizedCandidate.includes(normalizedValue);
      return normalizedCandidate === normalizedValue;
    };

    if (type === 'site') {
      return evaluateString(device.siteId);
    }

    if (type === 'os') {
      return evaluateString(device.osType);
    }

    if (type === 'group') {
      const deviceGroups = groupsByDevice.get(device.id) ?? new Set<string>();
      const hasGroup = deviceGroups.has(value);
      if (operator === 'is_not' || operator === 'not_contains') {
        return !hasGroup;
      }
      return hasGroup;
    }

    if (type === 'tag') {
      const tags = (device.tags ?? []).map((tag) => tag.toLowerCase());
      const hasTag = tags.some((tag) => tag === value.toLowerCase() || tag.includes(value.toLowerCase()));
      if (operator === 'is_not' || operator === 'not_contains') {
        return !hasTag;
      }
      return hasTag;
    }

    return true;
  };

  return orgDevices
    .filter((device) => conditions.every((condition) => matchesCondition(condition, device)))
    .map((device) => device.id);
}

export async function resolveAutomationTargetDeviceIds(automation: AutomationRow): Promise<string[]> {
  if (isDeploymentTargetConfig(automation.conditions)) {
    return resolveDeploymentTargets({
      orgId: automation.orgId,
      targetConfig: automation.conditions,
    });
  }

  if (Array.isArray(automation.conditions)) {
    return resolveLegacyConditionTargets(automation.orgId, automation.conditions);
  }

  const trigger = isPlainRecord(automation.trigger) ? automation.trigger : null;
  const triggerDeviceIds = trigger ? asStringArray(trigger.deviceIds) : [];

  if (triggerDeviceIds.length > 0) {
    const scopedDevices = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.orgId, automation.orgId), inArray(devices.id, triggerDeviceIds)));
    return scopedDevices.map((device) => device.id);
  }

  const orgDevices = await db
    .select({ id: devices.id })
    .from(devices)
    .where(eq(devices.orgId, automation.orgId));

  return orgDevices.map((device) => device.id);
}

function getExistingLogs(logs: unknown): AutomationLogEntry[] {
  if (!Array.isArray(logs)) return [];
  return logs.filter((entry): entry is AutomationLogEntry => isPlainRecord(entry) && typeof entry.message === 'string').map((entry) => ({
    timestamp: asString(entry.timestamp) ?? new Date().toISOString(),
    level: (asString(entry.level) as LogLevel) ?? 'info',
    message: asString(entry.message) ?? '',
    actionType: asString(entry.actionType),
    actionIndex: typeof entry.actionIndex === 'number' ? entry.actionIndex : undefined,
    deviceId: asString(entry.deviceId),
    commandId: asString(entry.commandId),
    alertId: asString(entry.alertId),
    channelId: asString(entry.channelId),
    details: isPlainRecord(entry.details) ? entry.details : undefined,
  }));
}

function logEntry(
  message: string,
  level: LogLevel = 'info',
  extras: Omit<AutomationLogEntry, 'timestamp' | 'level' | 'message'> = {},
): AutomationLogEntry {
  return {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...extras,
  };
}

function parseNotificationChannelConfig(config: unknown): Record<string, unknown> {
  if (!isPlainRecord(config)) return {};
  return config;
}

async function ensureAutomationAlertRule(orgId: string): Promise<string> {
  const templateName = 'Automation Action Template';
  const ruleName = 'Automation Action Alerts';

  const [existingTemplate] = await db
    .select({ id: alertTemplates.id })
    .from(alertTemplates)
    .where(and(eq(alertTemplates.orgId, orgId), eq(alertTemplates.name, templateName)))
    .limit(1);

  const templateId = existingTemplate?.id ?? (await db
    .insert(alertTemplates)
    .values({
      orgId,
      name: templateName,
      description: 'Template for alerts generated by automation actions',
      conditions: {},
      severity: 'medium',
      titleTemplate: '{{title}}',
      messageTemplate: '{{message}}',
      autoResolve: false,
      cooldownMinutes: 1,
      isBuiltIn: false,
    })
    .returning({ id: alertTemplates.id })
  )[0]?.id;

  if (!templateId) {
    throw new Error('Failed to create automation alert template');
  }

  const [existingRule] = await db
    .select({ id: alertRules.id })
    .from(alertRules)
    .where(
      and(
        eq(alertRules.orgId, orgId),
        eq(alertRules.name, ruleName),
        eq(alertRules.targetType, 'org'),
        eq(alertRules.targetId, orgId),
      ),
    )
    .limit(1);

  if (existingRule?.id) {
    return existingRule.id;
  }

  const [rule] = await db
    .insert(alertRules)
    .values({
      orgId,
      templateId,
      name: ruleName,
      targetType: 'org',
      targetId: orgId,
      overrideSettings: {
        templateOwned: true,
      },
      isActive: true,
    })
    .returning({ id: alertRules.id });

  if (!rule?.id) {
    throw new Error('Failed to create automation alert rule');
  }

  return rule.id;
}

type ActionExecutionContext = {
  automation: AutomationRow;
  runId: string;
  device: {
    id: string;
    hostname: string;
    displayName: string | null;
    osType: 'windows' | 'macos' | 'linux';
    status: string;
  };
  scriptsById: Map<string, typeof scripts.$inferSelect>;
  channelsById: Map<string, typeof notificationChannels.$inferSelect>;
};

type ActionExecutionResult = {
  success: boolean;
  log: AutomationLogEntry;
};

async function executeRunScriptAction(
  action: RunScriptAction,
  actionIndex: number,
  context: ActionExecutionContext,
): Promise<ActionExecutionResult> {
  const script = context.scriptsById.get(action.scriptId);
  if (!script) {
    return {
      success: false,
      log: logEntry('Script not found for run_script action', 'error', {
        actionType: action.type,
        actionIndex,
        deviceId: context.device.id,
        details: { scriptId: action.scriptId },
      }),
    };
  }

  if (!script.osTypes.includes(context.device.osType)) {
    return {
      success: false,
      log: logEntry('Script OS type does not match target device', 'error', {
        actionType: action.type,
        actionIndex,
        deviceId: context.device.id,
        details: {
          scriptId: script.id,
          deviceOsType: context.device.osType,
          scriptOsTypes: script.osTypes,
        },
      }),
    };
  }

  const queueResult = await queueCommandForExecution(
    context.device.id,
    CommandTypes.SCRIPT,
    {
      scriptId: script.id,
      executionId: `${context.runId}:${context.device.id}:${actionIndex}`,
      language: script.language,
      content: script.content,
      parameters: action.parameters ?? {},
      timeoutSeconds: script.timeoutSeconds,
      runAs: action.runAs ?? script.runAs,
    },
    {
      userId: context.automation.createdBy ?? undefined,
    },
  );

  if (!queueResult.command) {
    return {
      success: false,
      log: logEntry('Failed to queue run_script action command', 'error', {
        actionType: action.type,
        actionIndex,
        deviceId: context.device.id,
        details: { error: queueResult.error ?? 'Unknown queue error', scriptId: script.id },
      }),
    };
  }

  return {
    success: true,
    log: logEntry('Queued run_script action', 'info', {
      actionType: action.type,
      actionIndex,
      deviceId: context.device.id,
      commandId: queueResult.command.id,
      details: { scriptId: script.id },
    }),
  };
}

function chooseShellForDevice(deviceOsType: 'windows' | 'macos' | 'linux', requested?: string) {
  if (requested === 'powershell' || requested === 'cmd' || requested === 'bash') {
    return requested;
  }
  if (deviceOsType === 'windows') {
    return 'powershell';
  }
  return 'bash';
}

async function executeCommandAction(
  action: ExecuteCommandAction,
  actionIndex: number,
  context: ActionExecutionContext,
): Promise<ActionExecutionResult> {
  const shell = chooseShellForDevice(context.device.osType, action.shell);

  const queueResult = await queueCommandForExecution(
    context.device.id,
    CommandTypes.SCRIPT,
    {
      scriptId: `automation:${context.automation.id}`,
      executionId: `${context.runId}:${context.device.id}:${actionIndex}`,
      language: shell === 'cmd' ? 'cmd' : shell,
      content: action.command,
      timeoutSeconds: 300,
      runAs: 'system',
    },
    {
      userId: context.automation.createdBy ?? undefined,
    },
  );

  if (!queueResult.command) {
    return {
      success: false,
      log: logEntry('Failed to queue execute_command action', 'error', {
        actionType: action.type,
        actionIndex,
        deviceId: context.device.id,
        details: {
          error: queueResult.error ?? 'Unknown queue error',
          shell,
        },
      }),
    };
  }

  return {
    success: true,
    log: logEntry('Queued execute_command action', 'info', {
      actionType: action.type,
      actionIndex,
      deviceId: context.device.id,
      commandId: queueResult.command.id,
      details: { shell },
    }),
  };
}

async function sendChannelNotification(
  channel: typeof notificationChannels.$inferSelect,
  payload: {
    title: string;
    message: string;
    severity: AlertSeverity;
    orgId: string;
    alertId: string;
    deviceId: string;
    deviceName: string;
  },
): Promise<{ success: boolean; error?: string }> {
  const channelConfig = parseNotificationChannelConfig(channel.config);

  if (channel.type === 'email') {
    const recipients = getEmailRecipients(channelConfig);
    if (recipients.length === 0) {
      return {
        success: false,
        error: 'No recipients configured on email notification channel',
      };
    }

    return sendEmailNotification({
      to: recipients,
      alertName: payload.title,
      severity: payload.severity,
      summary: payload.message,
      orgName: 'Breeze',
      deviceName: payload.deviceName,
    });
  }

  if (channel.type === 'webhook') {
    const configuredMethod = asString(channelConfig.method);
    const method: 'POST' | 'PUT' = configuredMethod === 'PUT' ? 'PUT' : 'POST';
    return sendWebhookNotification(
      {
        url: asString(channelConfig.url) ?? '',
        method,
        headers: isPlainRecord(channelConfig.headers)
          ? Object.fromEntries(Object.entries(channelConfig.headers).filter(([, value]) => typeof value === 'string')) as Record<string, string>
          : undefined,
        authType: asString(channelConfig.authType) as 'none' | 'basic' | 'bearer' | 'api_key' | undefined,
        authToken: asString(channelConfig.authToken),
        authUsername: asString(channelConfig.authUsername),
        authPassword: asString(channelConfig.authPassword),
        apiKeyHeader: asString(channelConfig.apiKeyHeader),
        apiKeyValue: asString(channelConfig.apiKeyValue),
        payloadTemplate: asString(channelConfig.payloadTemplate),
      },
      {
        alertId: payload.alertId,
        alertName: payload.title,
        severity: payload.severity,
        summary: payload.message,
        orgId: payload.orgId,
        orgName: 'Breeze',
        triggeredAt: new Date().toISOString(),
        ruleId: 'automation-action',
        ruleName: 'Automation Action',
        deviceId: payload.deviceId,
        deviceName: payload.deviceName,
      },
    );
  }

  if ((channel.type === 'slack' || channel.type === 'teams') && asString(channelConfig.webhookUrl)) {
    return sendWebhookNotification(
      {
        url: asString(channelConfig.webhookUrl) ?? '',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      {
        alertId: payload.alertId,
        alertName: payload.title,
        severity: payload.severity,
        summary: payload.message,
        orgId: payload.orgId,
        orgName: 'Breeze',
        triggeredAt: new Date().toISOString(),
        ruleId: 'automation-action',
        ruleName: 'Automation Action',
        deviceId: payload.deviceId,
        deviceName: payload.deviceName,
      },
    );
  }

  return {
    success: false,
    error: `Notification channel type ${channel.type} is not implemented`,
  };
}

async function executeSendNotificationAction(
  action: SendNotificationAction,
  actionIndex: number,
  context: ActionExecutionContext,
): Promise<ActionExecutionResult> {
  const channel = context.channelsById.get(action.notificationChannelId);
  if (!channel) {
    return {
      success: false,
      log: logEntry('Notification channel not found for send_notification action', 'error', {
        actionType: action.type,
        actionIndex,
        deviceId: context.device.id,
        details: { notificationChannelId: action.notificationChannelId },
      }),
    };
  }

  const title = action.title ?? `${context.automation.name} notification`;
  const message = action.message ?? `Automation ${context.automation.name} executed on ${context.device.hostname}`;
  const severity = action.severity ?? 'info';
  const syntheticAlertId = `${context.runId}:${context.device.id}:${actionIndex}`;

  const sendResult = await sendChannelNotification(channel, {
    title,
    message,
    severity,
    orgId: context.automation.orgId,
    alertId: syntheticAlertId,
    deviceId: context.device.id,
    deviceName: context.device.displayName ?? context.device.hostname,
  });

  if (!sendResult.success) {
    return {
      success: false,
      log: logEntry('send_notification action failed', 'error', {
        actionType: action.type,
        actionIndex,
        deviceId: context.device.id,
        channelId: channel.id,
        details: { error: sendResult.error },
      }),
    };
  }

  return {
    success: true,
    log: logEntry('send_notification action completed', 'info', {
      actionType: action.type,
      actionIndex,
      deviceId: context.device.id,
      channelId: channel.id,
    }),
  };
}

async function executeCreateAlertAction(
  action: CreateAlertAction,
  actionIndex: number,
  context: ActionExecutionContext,
): Promise<ActionExecutionResult> {
  const ruleId = await ensureAutomationAlertRule(context.automation.orgId);

  const title = action.alertTitle ?? `${context.automation.name} automation alert`;
  const message = action.alertMessage;

  const [createdAlert] = await db
    .insert(alerts)
    .values({
      ruleId,
      deviceId: context.device.id,
      orgId: context.automation.orgId,
      status: 'active',
      severity: action.alertSeverity,
      title,
      message,
      context: {
        automationId: context.automation.id,
        automationRunId: context.runId,
        deviceId: context.device.id,
      },
      triggeredAt: new Date(),
    })
    .returning({ id: alerts.id });

  if (!createdAlert?.id) {
    return {
      success: false,
      log: logEntry('Failed to create alert from create_alert action', 'error', {
        actionType: action.type,
        actionIndex,
        deviceId: context.device.id,
      }),
    };
  }

  await publishEvent(
    'alert.triggered',
    context.automation.orgId,
    {
      alertId: createdAlert.id,
      ruleId,
      deviceId: context.device.id,
      severity: action.alertSeverity,
      title,
      message,
      automationId: context.automation.id,
      runId: context.runId,
    },
    'automation-executor',
  );

  return {
    success: true,
    log: logEntry('create_alert action created alert successfully', 'info', {
      actionType: action.type,
      actionIndex,
      deviceId: context.device.id,
      alertId: createdAlert.id,
    }),
  };
}

async function executeAction(
  action: AutomationAction,
  actionIndex: number,
  context: ActionExecutionContext,
): Promise<ActionExecutionResult> {
  if (action.type === 'run_script') {
    return executeRunScriptAction(action, actionIndex, context);
  }

  if (action.type === 'execute_command') {
    return executeCommandAction(action, actionIndex, context);
  }

  if (action.type === 'send_notification') {
    return executeSendNotificationAction(action, actionIndex, context);
  }

  if (action.type === 'create_alert') {
    return executeCreateAlertAction(action, actionIndex, context);
  }

  return {
    success: false,
    log: logEntry(`Unsupported action type ${(action as { type?: string }).type ?? 'unknown'}`, 'error', {
      actionIndex,
      deviceId: context.device.id,
    }),
  };
}

async function sendOnFailureNotifications(
  automation: AutomationRow,
  channelsById: Map<string, typeof notificationChannels.$inferSelect>,
  notificationTargets: NotificationTargets | undefined,
  details: {
    runId: string;
    deviceId: string;
    message: string;
  },
): Promise<AutomationLogEntry[]> {
  const logs: AutomationLogEntry[] = [];

  const channelIds = notificationTargets?.channelIds ?? [];
  for (const channelId of channelIds) {
    const channel = channelsById.get(channelId);
    if (!channel) {
      logs.push(logEntry('On-failure notification channel not found', 'warning', {
        channelId,
        deviceId: details.deviceId,
      }));
      continue;
    }

    const sendResult = await sendChannelNotification(channel, {
      title: `${automation.name} action failed`,
      message: details.message,
      severity: 'high',
      orgId: automation.orgId,
      alertId: `${details.runId}:${details.deviceId}:failure`,
      deviceId: details.deviceId,
      deviceName: details.deviceId,
    });

    logs.push(logEntry(
      sendResult.success
        ? 'On-failure notification sent'
        : `On-failure notification failed: ${sendResult.error ?? 'unknown error'}`,
      sendResult.success ? 'info' : 'error',
      {
        channelId,
        deviceId: details.deviceId,
      },
    ));
  }

  return logs;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  handler: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;

  let current = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (current < items.length) {
      const index = current;
      current += 1;
      const item = items[index];
      if (item !== undefined) {
        await handler(item, index);
      }
    }
  });

  await Promise.all(workers);
}

export async function createAutomationRunRecord(options: {
  automation: AutomationRow;
  triggeredBy: string;
  details?: Record<string, unknown>;
}): Promise<{ run: AutomationRunRow; targetDeviceIds: string[] }> {
  const targetDeviceIds = await resolveAutomationTargetDeviceIds(options.automation);

  const [run] = await db
    .insert(automationRuns)
    .values({
      automationId: options.automation.id,
      triggeredBy: options.triggeredBy,
      status: 'running',
      devicesTargeted: targetDeviceIds.length,
      devicesSucceeded: 0,
      devicesFailed: 0,
      logs: [
        logEntry('Automation run created', 'info', {
          details: {
            triggeredBy: options.triggeredBy,
            ...options.details,
          },
        }),
      ],
    })
    .returning();

  if (!run) {
    throw new Error('Failed to create automation run record');
  }

  await db
    .update(automations)
    .set({
      runCount: sql`${automations.runCount} + 1`,
      lastRunAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(automations.id, options.automation.id));

  await publishEvent(
    'automation.started',
    options.automation.orgId,
    {
      automationId: options.automation.id,
      runId: run.id,
      triggeredBy: options.triggeredBy,
      devicesTargeted: targetDeviceIds.length,
    },
    'automation-runtime',
  );

  return { run, targetDeviceIds };
}

export async function executeAutomationRun(
  runId: string,
  targetDeviceIdsFromQueue?: string[],
): Promise<{
  status: 'completed' | 'failed' | 'partial';
  devicesSucceeded: number;
  devicesFailed: number;
}> {
  const [run] = await db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.id, runId))
    .limit(1);

  if (!run) {
    throw new Error('Automation run not found');
  }

  const [automation] = await db
    .select()
    .from(automations)
    .where(eq(automations.id, run.automationId))
    .limit(1);

  if (!automation) {
    throw new Error('Automation definition not found');
  }

  const normalized = normalizeAutomationInput({
    trigger: automation.trigger,
    actions: automation.actions,
    conditions: automation.conditions,
    onFailure: automation.onFailure,
    notificationTargets: automation.notificationTargets,
  });

  const targetDeviceIds = targetDeviceIdsFromQueue && targetDeviceIdsFromQueue.length > 0
    ? targetDeviceIdsFromQueue
    : await resolveAutomationTargetDeviceIds(automation);

  await db
    .update(automationRuns)
    .set({
      devicesTargeted: targetDeviceIds.length,
    })
    .where(eq(automationRuns.id, run.id));

  const deviceRows = targetDeviceIds.length > 0
    ? await db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        displayName: devices.displayName,
        osType: devices.osType,
        status: devices.status,
      })
      .from(devices)
      .where(inArray(devices.id, targetDeviceIds))
    : [];

  const scriptIds = [...new Set(
    normalized.actions
      .filter((action): action is RunScriptAction => action.type === 'run_script')
      .map((action) => action.scriptId),
  )];

  const scriptRows = scriptIds.length > 0
    ? await db
      .select()
      .from(scripts)
      .where(inArray(scripts.id, scriptIds))
    : [];

  const scriptsById = new Map(scriptRows.map((script) => [script.id, script]));

  const notificationChannelIds = new Set<string>();
  for (const action of normalized.actions) {
    if (action.type === 'send_notification') {
      notificationChannelIds.add(action.notificationChannelId);
    }
  }
  for (const channelId of normalized.notificationTargets?.channelIds ?? []) {
    notificationChannelIds.add(channelId);
  }

  const channelRows = notificationChannelIds.size > 0
    ? await db
      .select()
      .from(notificationChannels)
      .where(
        and(
          eq(notificationChannels.orgId, automation.orgId),
          inArray(notificationChannels.id, [...notificationChannelIds]),
        ),
      )
    : [];

  const channelsById = new Map(channelRows.map((channel) => [channel.id, channel]));

  const existingLogs = getExistingLogs(run.logs);
  const logs: AutomationLogEntry[] = [...existingLogs];
  let devicesSucceeded = 0;
  let devicesFailed = 0;

  await runWithConcurrency(deviceRows, 5, async (device) => {
    let deviceFailed = false;

    for (const [actionIndex, action] of normalized.actions.entries()) {
      const result = await executeAction(action, actionIndex, {
        automation,
        runId: run.id,
        device,
        scriptsById,
        channelsById,
      });

      logs.push(result.log);

      if (!result.success) {
        deviceFailed = true;

        if (normalized.onFailure === 'notify') {
          const failureLogs = await sendOnFailureNotifications(
            automation,
            channelsById,
            normalized.notificationTargets,
            {
              runId: run.id,
              deviceId: device.id,
              message: result.log.message,
            },
          );
          logs.push(...failureLogs);
        }

        if (normalized.onFailure === 'stop' || normalized.onFailure === 'notify') {
          break;
        }
      }
    }

    if (deviceFailed) {
      devicesFailed += 1;
    } else {
      devicesSucceeded += 1;
    }
  });

  const status: 'completed' | 'failed' | 'partial' =
    devicesFailed === 0
      ? 'completed'
      : devicesSucceeded === 0
        ? 'failed'
        : 'partial';

  logs.push(logEntry(`Automation run finished with status ${status}`, status === 'completed' ? 'info' : 'warning', {
    details: {
      devicesSucceeded,
      devicesFailed,
      devicesTargeted: targetDeviceIds.length,
    },
  }));

  await db
    .update(automationRuns)
    .set({
      status,
      devicesSucceeded,
      devicesFailed,
      completedAt: new Date(),
      logs,
    })
    .where(eq(automationRuns.id, run.id));

  await publishEvent(
    status === 'completed' ? 'automation.completed' : 'automation.failed',
    automation.orgId,
    {
      automationId: automation.id,
      runId: run.id,
      triggeredBy: run.triggeredBy,
      status,
      devicesTargeted: targetDeviceIds.length,
      devicesSucceeded,
      devicesFailed,
    },
    'automation-runtime',
  );

  return {
    status,
    devicesSucceeded,
    devicesFailed,
  };
}

export function formatScheduleTriggerKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  const hour = `${date.getUTCHours()}`.padStart(2, '0');
  const minute = `${date.getUTCMinutes()}`.padStart(2, '0');
  return `${year}${month}${day}${hour}${minute}`;
}

export function matchesCronField(
  field: string,
  value: number,
  min: number,
  max: number,
): boolean {
  const normalized = field.trim();

  if (normalized === '*') {
    return true;
  }

  const values = normalized.split(',');
  for (const segment of values) {
    const valueMatch = segment.trim();
    if (!valueMatch) continue;

    const stepParts = valueMatch.split('/');
    const base = stepParts[0] ?? '';
    const step = stepParts[1] ? Number.parseInt(stepParts[1], 10) : null;

    let rangeStart = min;
    let rangeEnd = max;

    if (base !== '*') {
      if (base.includes('-')) {
        const [startRaw, endRaw] = base.split('-');
        const parsedStart = Number.parseInt(startRaw ?? '', 10);
        const parsedEnd = Number.parseInt(endRaw ?? '', 10);
        if (Number.isNaN(parsedStart) || Number.isNaN(parsedEnd)) {
          continue;
        }
        rangeStart = parsedStart;
        rangeEnd = parsedEnd;
      } else {
        const parsedSingle = Number.parseInt(base, 10);
        if (Number.isNaN(parsedSingle)) {
          continue;
        }
        rangeStart = parsedSingle;
        rangeEnd = parsedSingle;
      }
    }

    if (value < rangeStart || value > rangeEnd) {
      continue;
    }

    if (!step || step <= 0) {
      return true;
    }

    if ((value - rangeStart) % step === 0) {
      return true;
    }
  }

  return false;
}

function getZonedDateParts(date: Date, timeZone: string): {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
  });

  const parts = formatter.formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));

  const weekday = lookup.get('weekday') ?? 'Sun';
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    minute: Number.parseInt(lookup.get('minute') ?? '0', 10),
    hour: Number.parseInt(lookup.get('hour') ?? '0', 10),
    dayOfMonth: Number.parseInt(lookup.get('day') ?? '1', 10),
    month: Number.parseInt(lookup.get('month') ?? '1', 10),
    dayOfWeek: weekdayMap[weekday] ?? 0,
  };
}

export function isCronDue(cronExpression: string, timeZone: string, date: Date = new Date()): boolean {
  const fields = cronExpression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return false;
  }

  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = fields;
  const zoned = getZonedDateParts(date, timeZone);

  const minuteMatches = matchesCronField(minuteField ?? '*', zoned.minute, 0, 59);
  const hourMatches = matchesCronField(hourField ?? '*', zoned.hour, 0, 23);
  const monthMatches = matchesCronField(monthField ?? '*', zoned.month, 1, 12);

  const dayOfMonthMatches = matchesCronField(dayOfMonthField ?? '*', zoned.dayOfMonth, 1, 31);
  const normalizedDowValue = zoned.dayOfWeek === 0 ? 7 : zoned.dayOfWeek;
  const dayOfWeekMatches = matchesCronField(dayOfWeekField ?? '*', zoned.dayOfWeek, 0, 7)
    || matchesCronField(dayOfWeekField ?? '*', normalizedDowValue, 1, 7);

  const isDomWildcard = (dayOfMonthField ?? '*') === '*';
  const isDowWildcard = (dayOfWeekField ?? '*') === '*';

  const dayMatches = isDomWildcard || isDowWildcard
    ? dayOfMonthMatches && dayOfWeekMatches
    : dayOfMonthMatches || dayOfWeekMatches;

  return minuteMatches && hourMatches && monthMatches && dayMatches;
}
