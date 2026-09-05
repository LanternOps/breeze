import { randomBytes } from 'crypto';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { scriptParametersSchema, type DeploymentTargetConfig } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  alertRules,
  alerts,
  alertTemplates,
  automations,
  automationResourceBindings,
  automationRuns,
  automationRunDeviceResults,
  configPolicyAutomations,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceGroupMemberships,
  devices,
  notificationChannels,
  organizations,
  scriptExecutions,
  scripts,
} from '../db/schema';
import { resolveDeploymentTargets } from './deploymentEngine';
import { canAccessSite, type UserPermissions } from './permissions';
import { dispatchScriptToDevice } from './scriptDispatch';
import { loadTenantVariableScope, type TenantVariableScope } from './tenantVariableResolution';
import { scriptNeedsVariableScope } from './sourcedParameters';
import { publishEvent } from './eventBus';
import { captureException } from './sentry';
import {
  createAndEnqueueAgentRun,
  type AgentRunSkipReason,
  type CreateAgentRunInput,
} from './aiAgents/runService';
import {
  getEmailRecipients,
  sendEmailNotification,
  sendWebhookNotification,
} from './notificationSenders';
import {
  AutomationReferenceAuthorizationError,
  resolveOwnedAutomationReferences,
  type AutomationReferenceOwner,
  type ResolvedAutomationReferences,
} from './automationReferenceAuthorization';
import {
  recordAutomationActionDispatch,
  reconcileAutomationRun,
  seedAutomationActionResults,
} from './automationActionResults';
// softwareDeployment and softwareCurrency are imported lazily inside
// executeDeploySoftwareActions to avoid pulling the agentWs→configurationPolicy
// import chain into partial-mock test suites at module-load time.

const ALERT_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type AutomationOwnerAxes = { orgId: string | null; partnerId: string | null };

function withAutomationRuntimeDb<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

function recordAutomationRuntimeActionDispatch(
  input: Parameters<typeof recordAutomationActionDispatch>[0],
): Promise<boolean> {
  // Runtime callers can be invoked beneath a request/test transaction. Keep
  // action-result locks and reconciliation publications out of that ambient
  // transaction, just like the action-side writes they describe.
  return withAutomationRuntimeDb(() => recordAutomationActionDispatch(input));
}

/**
 * Ownership → org fan-out (#2133). An org-owned automation targets devices in
 * its own org; a partner-wide automation (orgId NULL) fans out to every org
 * under the owning partner. Returns [] when the owner resolves to no orgs —
 * i.e. zero target devices.
 */
async function automationOwnerOrgIds(
  automation: Pick<AutomationRow, 'orgId' | 'partnerId'>,
): Promise<string[]> {
  if (automation.orgId) {
    return [automation.orgId];
  }

  if (!automation.partnerId) {
    // The one-owner CHECK makes this unreachable; guard against bad legacy
    // data. Log loudly — the downstream symptom is "automation targets zero
    // devices and the run completes", a silent no-op.
    console.error(
      '[AutomationRuntime] automation has neither orgId nor partnerId — resolving zero target devices',
    );
    return [];
  }

  const orgRows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.partnerId, automation.partnerId), ne(organizations.type, 'quick_support')));

  return orgRows.map((row) => row.id);
}

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
  // #3409 PR2 Task 7: matches scriptParametersSchema's inferred value type —
  // canonicalized to strings once, downstream, at scriptDispatch.ts.
  parameters?: Record<string, string | number | boolean>;
  /**
   * Run-context override for this action. Absent = the script's saved default
   * (`executeRunScriptAction` resolves `action.runAs ?? script.runAs`).
   *
   * #4888 narrowed this from `… | string`: the automation form now exposes the
   * control, so an unrecognised value is a bug rather than a shape the type
   * has to keep representing. `normalizeAutomationActions` drops anything
   * outside the enum back to `undefined` — see the note there for why it
   * drops rather than throws.
   */
  runAs?: 'system' | 'user' | 'elevated';
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

export type DeploySoftwareAction = {
  type: 'deploy_software';
  catalogId: string;
};

// AI agents wave 3d (#3824). No config by design — see the shared
// validator arm: the agent comes from automation.managedByAgentId and
// the device from the event-target binding.
export type AiTriageAction = {
  type: 'ai_triage';
};

export type AutomationAction =
  | RunScriptAction
  | SendNotificationAction
  | CreateAlertAction
  | ExecuteCommandAction
  | DeploySoftwareAction
  | AiTriageAction;

/**
 * AI agents wave 3d (#3824): what the triggering EVENT was, threaded from
 * processTriggerEvent through the queue into every action's execution context.
 * Only populated for managed automations (automations.managedByAgentId).
 */
export type AutomationTriggerContext = {
  alertId: string | null;
  eventId: string | null;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info' | null;
  ruleId: string | null;
};

// Normalization is the trust boundary for persisted action JSON. Keep the
// explicit name for authorization/storage callers while preserving the
// existing AutomationAction public type for runtime consumers.
export type NormalizedAutomationAction = AutomationAction;

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

/**
 * Narrows a stored `run_script` action's run context to the `script_run_as`
 * enum (#4888).
 *
 * DROPS rather than throws on an unrecognised value, deliberately.
 * `normalizeAutomationActions` is not only the write validator — it also runs
 * over ALREADY-STORED rows every time an automation EXECUTES:
 * `createAutomationRunRecord` (via `normalizeAutomationInput`) and
 * `executeConfigPolicyAutomationRun` both normalize the loaded row, and both
 * are driven by `jobs/automationWorker.ts` on the scheduled/event path (plus
 * the manual-trigger routes in `routes/automations.ts`). Throwing here would
 * therefore not reject a bad edit — it would take a live automation offline
 * mid-run over a value that has been forwarded harmlessly for as long as the
 * field has existed. Falling back to `undefined` means "the script's saved
 * default", which is the conservative outcome and exactly what an action with
 * no run context has always done.
 */
function asRunAs(value: unknown): 'system' | 'user' | 'elevated' | undefined {
  return value === 'system' || value === 'user' || value === 'elevated' ? value : undefined;
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
      // #3409 PR2 Task 7: the ONE script-parameter schema (@breeze/shared),
      // replacing the old hand-rolled isPlainRecord check — a malformed
      // parameters map is now a save-time AutomationValidationError instead
      // of a silent drop.
      let parameters: Record<string, string | number | boolean> | undefined;
      if (action.parameters !== undefined) {
        const parsed = scriptParametersSchema.safeParse(action.parameters);
        if (!parsed.success) {
          throw new AutomationValidationError(
            `actions[${index}] run_script has invalid parameters: ${parsed.error.issues[0]?.message ?? 'invalid parameters'}`
          );
        }
        parameters = parsed.data;
      }
      normalized.push({
        type: 'run_script',
        scriptId,
        parameters,
        runAs: asRunAs(action.runAs),
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

    if (type === 'deploy_software') {
      const catalogId = asString(action.catalogId) ?? asString(action.catalog_id);
      if (!catalogId) {
        throw new AutomationValidationError(`actions[${index}] deploy_software requires catalogId`);
      }
      normalized.push({ type: 'deploy_software', catalogId });
      continue;
    }

    if (type === 'ai_triage') {
      normalized.push({ type: 'ai_triage' });
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

type AutomationResourceKind = 'script' | 'software_catalog' | 'notification_channel';
type AutomationReferenceDescriptor = {
  resourceKind: AutomationResourceKind;
  resourceId: string;
  expectedResourceOrgId: string | null;
  expectedResourcePartnerId: string | null;
  expectedResourceIsSystem: boolean;
};

function automationReferenceKey(kind: AutomationResourceKind, id: string): string {
  return `${kind}:${id}`;
}

function requestedAutomationReferenceKeys(
  actions: readonly AutomationAction[],
  notificationTargets?: NotificationTargets,
): Set<string> {
  const keys = new Set<string>();
  for (const action of actions) {
    if (action.type === 'run_script') {
      keys.add(automationReferenceKey('script', action.scriptId));
    } else if (action.type === 'deploy_software') {
      keys.add(automationReferenceKey('software_catalog', action.catalogId));
    } else if (action.type === 'send_notification') {
      keys.add(automationReferenceKey('notification_channel', action.notificationChannelId));
    }
  }
  for (const channelId of notificationTargets?.channelIds ?? []) {
    keys.add(automationReferenceKey('notification_channel', channelId));
  }
  return keys;
}

function descriptorsFromResolvedReferences(
  resolved: ResolvedAutomationReferences,
): Map<string, AutomationReferenceDescriptor> {
  const descriptors = new Map<string, AutomationReferenceDescriptor>();
  for (const row of resolved.scriptsById.values()) {
    const descriptor: AutomationReferenceDescriptor = {
      resourceKind: 'script',
      resourceId: row.id,
      expectedResourceOrgId: row.isSystem ? null : row.orgId,
      expectedResourcePartnerId: row.isSystem ? null : row.partnerId,
      expectedResourceIsSystem: row.isSystem,
    };
    descriptors.set(automationReferenceKey(descriptor.resourceKind, descriptor.resourceId), descriptor);
  }
  for (const row of resolved.softwareCatalogsById.values()) {
    const descriptor: AutomationReferenceDescriptor = {
      resourceKind: 'software_catalog',
      resourceId: row.id,
      expectedResourceOrgId: row.orgId,
      expectedResourcePartnerId: row.partnerId,
      expectedResourceIsSystem: false,
    };
    descriptors.set(automationReferenceKey(descriptor.resourceKind, descriptor.resourceId), descriptor);
  }
  for (const row of resolved.notificationChannelsById.values()) {
    const descriptor: AutomationReferenceDescriptor = {
      resourceKind: 'notification_channel',
      resourceId: row.id,
      expectedResourceOrgId: row.orgId,
      expectedResourcePartnerId: row.partnerId,
      expectedResourceIsSystem: false,
    };
    descriptors.set(automationReferenceKey(descriptor.resourceKind, descriptor.resourceId), descriptor);
  }
  return descriptors;
}

async function resolveAutomationReferenceOwner(
  tx: DbTransaction,
  axes: AutomationOwnerAxes,
): Promise<AutomationReferenceOwner> {
  if (axes.orgId) {
    const [org] = await tx
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, axes.orgId))
      .limit(1);
    if (!org?.partnerId) throw new AutomationReferenceAuthorizationError();
    return { scope: 'organization', orgId: axes.orgId, partnerId: org.partnerId };
  }
  if (axes.partnerId) {
    return { scope: 'partner', orgId: null, partnerId: axes.partnerId };
  }
  throw new AutomationReferenceAuthorizationError();
}

export async function resolveAutomationReferencesForOwner(
  tx: DbTransaction,
  axes: AutomationOwnerAxes,
  actions: readonly AutomationAction[],
  notificationTargets?: NotificationTargets,
): Promise<ResolvedAutomationReferences> {
  const owner = await resolveAutomationReferenceOwner(tx, axes);
  return resolveOwnedAutomationReferences(
    tx,
    owner,
    axes.orgId ? [axes.orgId] : [],
    actions,
    notificationTargets?.channelIds ?? [],
  );
}

export async function replaceAutomationResourceBindings(
  tx: DbTransaction,
  automationId: string,
  axes: AutomationOwnerAxes,
  resolved: ResolvedAutomationReferences,
): Promise<void> {
  await tx
    .delete(automationResourceBindings)
    .where(eq(automationResourceBindings.automationId, automationId));

  const descriptors = [...descriptorsFromResolvedReferences(resolved).values()];
  if (descriptors.length === 0) return;
  await tx.insert(automationResourceBindings).values(descriptors.map((descriptor) => ({
    automationId,
    orgId: axes.orgId,
    partnerId: axes.partnerId,
    ...descriptor,
    state: 'active' as const,
    reason: null,
  })));
}

async function resolveStandaloneAutomationReferencesForAdmission(
  tx: DbTransaction,
  automation: AutomationRow,
  normalized: NormalizedAutomationInput,
): Promise<ResolvedAutomationReferences> {
  const requestedKeys = requestedAutomationReferenceKeys(
    normalized.actions,
    normalized.notificationTargets,
  );
  const bindings = await tx
    .select()
    .from(automationResourceBindings)
    .where(eq(automationResourceBindings.automationId, automation.id));

  if (bindings.length !== requestedKeys.size) {
    throw new AutomationReferenceAuthorizationError();
  }
  for (const binding of bindings) {
    const key = automationReferenceKey(binding.resourceKind, binding.resourceId);
    if (binding.state !== 'active' || !requestedKeys.has(key)) {
      throw new AutomationReferenceAuthorizationError();
    }
  }

  const resolved = await resolveAutomationReferencesForOwner(
    tx,
    { orgId: automation.orgId, partnerId: automation.partnerId },
    normalized.actions,
    normalized.notificationTargets,
  );
  const descriptors = descriptorsFromResolvedReferences(resolved);
  for (const binding of bindings) {
    const descriptor = descriptors.get(automationReferenceKey(binding.resourceKind, binding.resourceId));
    if (
      !descriptor
      || descriptor.expectedResourceOrgId !== binding.expectedResourceOrgId
      || descriptor.expectedResourcePartnerId !== binding.expectedResourcePartnerId
      || descriptor.expectedResourceIsSystem !== binding.expectedResourceIsSystem
    ) {
      throw new AutomationReferenceAuthorizationError();
    }
  }
  return resolved;
}

function coerceToFilterValue(condition: Record<string, unknown>): string {
  return asString(condition.value) ?? '';
}

async function resolveLegacyConditionTargets(orgIds: string[], conditionsInput: unknown): Promise<string[]> {
  if (orgIds.length === 0) return [];
  const conditions = normalizeLegacyConditions(conditionsInput);
  if (conditions.length === 0) {
    const orgDevices = await db
      .select({ id: devices.id })
      .from(devices)
      .where(inArray(devices.orgId, orgIds));
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
    .where(inArray(devices.orgId, orgIds));

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
  // Dual-ownership fan-out (#2133): a partner-wide automation (orgId NULL)
  // resolves targets across EVERY org under the owning partner.
  const ownerOrgIds = await automationOwnerOrgIds(automation);
  if (ownerOrgIds.length === 0) return [];

  if (isDeploymentTargetConfig(automation.conditions)) {
    // resolveDeploymentTargets keeps its shared non-null-orgId contract —
    // loop per owner org and merge instead of widening its signature.
    const merged = new Set<string>();
    for (const orgId of ownerOrgIds) {
      const ids = await resolveDeploymentTargets({
        orgId,
        targetConfig: automation.conditions,
      });
      for (const id of ids) merged.add(id);
    }
    return [...merged];
  }

  if (Array.isArray(automation.conditions)) {
    return resolveLegacyConditionTargets(ownerOrgIds, automation.conditions);
  }

  const trigger = isPlainRecord(automation.trigger) ? automation.trigger : null;
  const triggerDeviceIds = trigger ? asStringArray(trigger.deviceIds) : [];

  if (triggerDeviceIds.length > 0) {
    const scopedDevices = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(inArray(devices.orgId, ownerOrgIds), inArray(devices.id, triggerDeviceIds)));
    return scopedDevices.map((device) => device.id);
  }

  const orgDevices = await db
    .select({ id: devices.id })
    .from(devices)
    .where(inArray(devices.orgId, ownerOrgIds));

  return orgDevices.map((device) => device.id);
}

/**
 * Returns true when the automation's target set is NOT statically bounded to an
 * explicit device list, i.e. it resolves to "every device in the org" (empty
 * conditions, legacy fallback, or a deployment config of type `all`/`filter`).
 *
 * Site-restricted callers must never own such an automation: even if the org
 * has zero out-of-scope devices today, a device added to a forbidden site
 * tomorrow would silently become a target of a schedule/event trigger that
 * runs with no caller context. We therefore reject these at create/update time.
 */
function isUnboundedOrgWideTarget(automation: Pick<AutomationRow, 'conditions' | 'trigger'>): boolean {
  if (isDeploymentTargetConfig(automation.conditions)) {
    const type = automation.conditions.type;
    // `devices` / `groups` enumerate a concrete set; `all` / `filter` do not.
    return type === 'all' || type === 'filter';
  }

  if (Array.isArray(automation.conditions)) {
    // Legacy condition arrays are evaluated against the full org device set.
    return true;
  }

  const trigger = isPlainRecord(automation.trigger) ? automation.trigger : null;
  const triggerDeviceIds = trigger ? asStringArray(trigger.deviceIds) : [];
  // No explicit deviceIds means the resolver falls back to all org devices.
  return triggerDeviceIds.length === 0;
}

export interface AutomationSiteScopeCheck {
  ok: boolean;
  /** Device IDs in the resolved target set that fall outside the allowlist. */
  outOfScopeDeviceIds: string[];
  /** True when the target set is org-wide/unbounded (rejected for restricted callers). */
  unbounded: boolean;
}

/**
 * Validates that every device an automation would target is within the caller's
 * site allowlist. Unrestricted callers (`allowedSiteIds` unset) always pass.
 *
 * Used at two seams:
 *  - create/update time: a site-restricted creator must not own an automation
 *    whose resolvable target set escapes their sites (this is the only gate for
 *    scheduled/event triggers, which run later with no caller context).
 *  - manual trigger/run time: re-validate against the *current* resolved set in
 *    case devices/sites drifted since creation.
 */
export async function checkAutomationTargetsWithinSiteScope(
  automation: AutomationRow,
  perms: Pick<UserPermissions, 'allowedSiteIds'> | undefined,
): Promise<AutomationSiteScopeCheck> {
  // Unrestricted (partner/system/org-admin without a site allowlist): unaffected.
  if (!perms?.allowedSiteIds) {
    return { ok: true, outOfScopeDeviceIds: [], unbounded: false };
  }

  const unbounded = isUnboundedOrgWideTarget(automation);
  if (unbounded) {
    return { ok: false, outOfScopeDeviceIds: [], unbounded: true };
  }

  const targetDeviceIds = await resolveAutomationTargetDeviceIds(automation);
  if (targetDeviceIds.length === 0) {
    return { ok: true, outOfScopeDeviceIds: [], unbounded: false };
  }

  const ownerOrgIds = await automationOwnerOrgIds(automation);
  const targetDevices = ownerOrgIds.length > 0
    ? await db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(and(inArray(devices.orgId, ownerOrgIds), inArray(devices.id, targetDeviceIds)))
    : [];

  const outOfScopeDeviceIds = targetDevices
    .filter((device) => !(typeof device.siteId === 'string' && canAccessSite(perms as UserPermissions, device.siteId)))
    .map((device) => device.id);

  return { ok: outOfScopeDeviceIds.length === 0, outOfScopeDeviceIds, unbounded: false };
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
  automation: Pick<AutomationRow, 'id' | 'orgId' | 'name' | 'createdBy' | 'managedByAgentId'>;
  runId: string;
  /** Present only for event-bound managed runs. */
  trigger?: AutomationTriggerContext;
  device: {
    id: string;
    // Worker-created child rows (alerts, notifications) always take the
    // DEVICE's org — a partner-wide automation has no org of its own (#2133).
    orgId: string;
    hostname: string;
    displayName: string | null;
    osType: 'windows' | 'macos' | 'linux';
    status: (typeof devices.$inferSelect)['status'];
    // Needed by dispatchScriptToDevice (#3409 PR0) for WS delivery — carried
    // through the device snapshot rather than re-queried per action.
    agentId: string;
    // #3409 PR3: sourced script parameters bind to device/site properties
    // (`builtin`) and to the device's custom fields (`deviceCustomField`).
    // They ride the run's ONE device snapshot — a per-device re-query at
    // resolution time would reintroduce exactly the N-query shape the
    // variable-scope hoist below removes. Not consumed yet; the resolver
    // lands in a later task.
    siteId: (typeof devices.$inferSelect)['siteId'];
    customFields: (typeof devices.$inferSelect)['customFields'];
  };
  scriptsById: Map<string, typeof scripts.$inferSelect>;
  channelsById: Map<string, typeof notificationChannels.$inferSelect>;
  /**
   * Preloaded ONCE per run over the run's distinct org set — see
   * {@link loadAutomationRunVariableScope}. Required (not optional) on
   * purpose: an absent scope would silently resolve every `{{var.*}}` token
   * to "missing" rather than failing loudly, so the type forces every runner
   * to have done the preload.
   */
  variableScope: TenantVariableScope;
};

/**
 * Preloads the tenant-variable scope ONCE per automation run (#3409 PR3 P2).
 *
 * Previously `executeRunScriptAction` called `loadTenantVariableScope` itself,
 * which put the load inside `runWithConcurrency(deviceRows, 5, …)` × the
 * action loop — i.e. once PER DEVICE PER run_script action, each one escaping
 * the ambient context and taking a second pooled connection. A 200-device
 * automation with two run_script actions issued 400 of them. `scriptExecution.ts`
 * has always done this correctly (once per fan-out over the distinct org set);
 * this is the automation path catching up, and it must happen BEFORE PR3 adds
 * a second (parameter-level) resolver on the same code path, which would
 * otherwise compound the trap.
 *
 * The gate is preserved, just widened from one script to the run's script set:
 * if no `run_script` action references a script that needs a scope, we pass
 * `[]` and `loadTenantVariableScope` short-circuits without querying at all
 * (tenantVariableResolution.ts) — so a variable-free run, which is the
 * overwhelming majority, still does exactly zero work.
 *
 * #3409 PR3 P1: the per-script predicate is `scriptNeedsVariableScope`, NOT
 * `hasVariableTokens(content)`. A `tenantVariable`-bound parameter lives in
 * `scripts.parameters`, not in the content, so a content-only gate would pass
 * `[]` here and every bound parameter would then resolve against an EMPTY
 * scope at dispatch — failing as "no value set" for a variable that exists.
 *
 * `loadTenantVariableScope` owns the `runOutsideDbContext(() =>
 * withSystemDbAccessContext(...))` double wrapper; do not add or unwrap one
 * here. Both wrappers, in that order, are load-bearing — a bare system
 * context nested inside a held org-scoped transaction does not elevate.
 */
export async function loadAutomationRunVariableScope(
  actions: AutomationAction[],
  scriptsById: Map<string, typeof scripts.$inferSelect>,
  deviceOrgIds: string[],
): Promise<TenantVariableScope> {
  const anyScriptUsesVariables = actions.some((action) => {
    if (action.type !== 'run_script') return false;
    const script = scriptsById.get(action.scriptId);
    return script !== undefined && scriptNeedsVariableScope(script);
  });
  return loadTenantVariableScope(anyScriptUsesVariables ? [...new Set(deviceOrgIds)] : []);
}

type ActionExecutionOutcome =
  | {
      status: 'queued' | 'delivered' | 'running';
      commandId?: string;
      scriptExecutionId?: string;
    }
  | { status: 'succeeded' }
  | { status: 'failed'; message?: string };

type ActionExecutionResult = {
  outcome: ActionExecutionOutcome;
  log: AutomationLogEntry;
};

/**
 * Which admission-gate skips are POLICY outcomes (cooldown, filters, kill
 * switch → the automation run stays green and the reason is logged) and which
 * are genuine integrity failures. `ownership_mismatch` and `device_not_in_org`
 * both mean the (org, device) pair we handed the gate does not hold — a data
 * bug or a cross-tenant move mid-flight, never an operator policy choice.
 *
 * Typed as a total Record over AgentRunSkipReason ON PURPOSE: when 3c adds a
 * new skip reason, this table stops compiling until someone classifies it. An
 * unclassified reason must never silently default to "green".
 */
const AI_TRIAGE_SKIP_IS_FAILURE: Readonly<Record<AgentRunSkipReason, boolean>> = Object.freeze({
  kill_switch_off: false,
  no_effective_agent: false,
  agent_disabled: false,
  mode_off: false,
  // Wave 6 PR 2 (#3828): the per-org circuit breaker refusing admission is a
  // deliberate safety gate, same class as kill_switch_off/agent_disabled —
  // not a data-integrity bug.
  circuit_open: false,
  trigger_filter_mismatch: false,
  maintenance_window: false,
  cooldown: false,
  max_concurrent_runs: false,
  max_runs_per_hour: false,
  org_budget_exceeded: false,
  agent_daily_budget_exceeded: false,
  duplicate: false,
  ownership_mismatch: true,
  device_not_in_org: true,
  // Phase 2 wave P2-1 (alert verdicts) — the verdict-profile equivalents of
  // max_concurrent_runs/max_runs_per_hour above: volume guards on a
  // high-frequency, cheap run shape, not an integrity failure.
  max_concurrent_verdict_runs: false,
  verdict_rate: false,
  // Phase 2 wave P2-2 (scheduled sweeps) — the sweep-profile equivalents,
  // same classification as the verdict pair above.
  max_concurrent_sweep_runs: false,
  sweep_rate: false,
  // Phase 2 wave P2-3 (weekly org narrative) — the narrative-profile
  // equivalents. Same classification again: a scheduled narrative run being
  // declined for volume is a cap doing its job, not a data-integrity bug.
  max_concurrent_narrative_runs: false,
  narrative_rate: false,
  // Phase 2 wave P2-4 (ticket triage) — the triage-profile equivalents. Same
  // classification again: a triage run being declined for volume is a cap
  // doing its job, not a data-integrity bug.
  max_concurrent_triage_runs: false,
  triage_rate: false,
});

// Exported for direct unit coverage of the script_executions correlation
// (#3162); the run loop still reaches it through executeAction below.
export async function executeRunScriptAction(
  action: RunScriptAction,
  actionIndex: number,
  context: ActionExecutionContext,
): Promise<ActionExecutionResult> {
  const script = context.scriptsById.get(action.scriptId);
  if (!script) {
    return {
      outcome: { status: 'failed', message: 'Script not found' },
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
      outcome: { status: 'failed', message: 'Script OS type does not match target device' },
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

  const parameters = action.parameters ?? {};

  // #3409 PR3 P2: the scope is preloaded ONCE per run by the caller (see
  // loadAutomationRunVariableScope) and threaded in on the context. Do NOT
  // load it here — this function runs once per device per run_script action,
  // inside runWithConcurrency, which is exactly the N-connection trap the
  // hoist removed.
  const variableScope = context.variableScope;

  // #3409 PR0: dispatchScriptToDevice owns the script_executions insert (#3162
  // — a REAL uuid row so handleScriptResult can correlate the agent's result),
  // payload build, sensitive-field encryption, queueCommand, and claim/decrypt/
  // WS-send. On a queueCommand throw it deletes its own pending execution row
  // before rethrowing (the old discardQueuelessExecution catch, now inside the
  // core). requireOnline:true reproduces queueCommandForExecution's online gate
  // — offline devices short-circuit before any insert, so there is no orphan
  // row to discard on that path either.
  const dispatch = await dispatchScriptToDevice({
    device: context.device,
    source: { kind: 'saved', script, automationRunId: context.runId },
    parameters,
    triggerType: 'automation',
    triggeredBy: context.automation.createdBy ?? null,
    createdBy: context.automation.createdBy ?? null,
    // #4888 — `action.runAs` is now narrowed to the `script_run_as` enum by
    // normalizeAutomationActions (anything else becomes undefined), so this no
    // longer forwards unchecked user input and needs no cast. The `??` is the
    // whole contract the automation form's "Script default" option relies on.
    runAs: action.runAs ?? script.runAs,
    requireOnline: true,
    variableScope,
  });

  if (!dispatch.ok) {
    return {
      outcome: { status: 'failed', message: dispatch.error },
      log: logEntry('Failed to queue run_script action command', 'error', {
        actionType: action.type,
        actionIndex,
        deviceId: context.device.id,
        details: { error: dispatch.error, scriptId: script.id },
      }),
    };
  }

  if (!dispatch.delivered && dispatch.executionId) {
    // Undelivered-but-queued: matches the old 'queued' status write; the core
    // only writes 'running' on actual delivery.
    await db
      .update(scriptExecutions)
      .set({ status: 'queued' })
      .where(and(
        eq(scriptExecutions.id, dispatch.executionId),
        eq(scriptExecutions.status, 'pending'),
      ));
  }

  return {
    outcome: {
      status: dispatch.delivered ? 'delivered' : 'queued',
      commandId: dispatch.commandId,
      ...(dispatch.executionId ? { scriptExecutionId: dispatch.executionId } : {}),
    },
    log: logEntry('Queued run_script action', 'info', {
      actionType: action.type,
      actionIndex,
      deviceId: context.device.id,
      commandId: dispatch.commandId,
      // deliveryOutcome lets an operator reading the run log distinguish
      // "queued, agent offline" (no_agent) from "we had a socket and failed
      // to reach it" (claim_lost/decrypt_failed/send_failed) — see
      // scriptDispatch.ts's DispatchScriptResult for the full enum.
      details: {
        scriptId: script.id,
        executionId: dispatch.executionId,
        deliveryOutcome: dispatch.deliveryOutcome,
        // #3409 PR3 §2.2 — the automation configured a value for a parameter
        // that is BOUND to a source, so the binding won and the configured
        // value was dropped. Automations have no parameter-capture UI, so the
        // run log is the ONLY place this warning can surface for them: an
        // author who set `parameters: {api_key: '...'}` before the script's
        // author flipped that key to a binding otherwise sees a silently
        // different run. Spread conditionally so a run log for the ~all of
        // today's automations is byte-identical to before.
        ...(dispatch.ignoredParameters.length > 0
          ? { ignoredParameterKeys: dispatch.ignoredParameters }
          : {}),
      },
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

  // No executionId / execution row: execute_command runs ad-hoc content with
  // no `scripts` row, and `script_executions.script_id` is NOT NULL, so it can
  // never have an execution row to correlate against (the raw source kind
  // creates none — #3162). The agent doesn't need one (the command id keys the
  // execution); only the separate `script_cancel` command type reads an
  // executionId payload field.
  const dispatch = await dispatchScriptToDevice({
    device: context.device,
    source: {
      kind: 'raw',
      content: action.command,
      language: shell === 'cmd' ? 'cmd' : shell,
      provenance: `automation:${context.automation.id}`,
    },
    timeoutSeconds: 300,
    runAs: 'system',
    createdBy: context.automation.createdBy ?? null,
    requireOnline: true,
  });

  if (!dispatch.ok) {
    return {
      outcome: { status: 'failed', message: dispatch.error },
      log: logEntry('Failed to queue execute_command action', 'error', {
        actionType: action.type,
        actionIndex,
        deviceId: context.device.id,
        details: { error: dispatch.error, shell },
      }),
    };
  }

  return {
    outcome: {
      status: dispatch.delivered ? 'delivered' : 'queued',
      commandId: dispatch.commandId,
    },
    log: logEntry('Queued execute_command action', 'info', {
      actionType: action.type,
      actionIndex,
      deviceId: context.device.id,
      commandId: dispatch.commandId,
      // See executeRunScriptAction above for why deliveryOutcome is worth
      // surfacing here.
      details: { shell, deliveryOutcome: dispatch.deliveryOutcome },
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
      outcome: { status: 'failed', message: 'Notification channel not found' },
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
    // The DEVICE's org — a partner-wide automation's orgId is NULL (#2133).
    orgId: context.device.orgId,
    alertId: syntheticAlertId,
    deviceId: context.device.id,
    deviceName: context.device.displayName ?? context.device.hostname,
  });

  if (!sendResult.success) {
    return {
      outcome: { status: 'failed', message: sendResult.error },
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
    outcome: { status: 'succeeded' },
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
  // Alert rows (and their backing rule/template) take the DEVICE's org —
  // playbook rule 5: a partner-wide automation (orgId NULL) never owns child
  // rows; each alert lands in the org whose device raised it (#2133).
  const ruleId = await ensureAutomationAlertRule(context.device.orgId);

  const title = action.alertTitle ?? `${context.automation.name} automation alert`;
  const message = action.alertMessage;

  const [createdAlert] = await db
    .insert(alerts)
    .values({
      ruleId,
      deviceId: context.device.id,
      orgId: context.device.orgId,
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
      outcome: { status: 'failed', message: 'Failed to create alert' },
      log: logEntry('Failed to create alert from create_alert action', 'error', {
        actionType: action.type,
        actionIndex,
        deviceId: context.device.id,
      }),
    };
  }

  await publishEvent(
    'alert.triggered',
    context.device.orgId,
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
    outcome: { status: 'succeeded' },
    log: logEntry('create_alert action created alert successfully', 'info', {
      actionType: action.type,
      actionIndex,
      deviceId: context.device.id,
      alertId: createdAlert.id,
    }),
  };
}

/**
 * AI agents wave 3d (#3824). Hands ONE alert to 3c's admission gate
 * (`createAndEnqueueAgentRun`) — the single entry point that resolves the
 * effective policy, applies trigger filters/cooldown/caps/dedupe, inserts the
 * ledger row and enqueues. This action never touches the ai-agent queue
 * directly and never runs an agent inline.
 *
 * The action carries no config: the agent comes from
 * `automation.managedByAgentId` and the device from the event-target binding
 * that `processTriggerEvent` established (`boundDeviceIds: [payload.deviceId]`),
 * so a managed run is one alert → one device → one agent run, never a fan-out
 * across the automation's configured target set.
 *
 * The loop guard — never triage an alert that an automation itself created —
 * lives UPSTREAM in `jobs/automationWorker.processTriggerEvent`
 * (`managed_automation_skips_automation_created_alerts`), because only the raw
 * event payload still carries `automationId`; `AutomationTriggerContext`
 * deliberately does not. Do not re-implement it here.
 */
async function executeAiTriageAction(
  _action: AiTriageAction,
  actionIndex: number,
  context: ActionExecutionContext,
): Promise<ActionExecutionResult> {
  const agentId = context.automation.managedByAgentId;
  if (!agentId) {
    const message = 'ai_triage action on an unmanaged automation — refusing';
    return {
      outcome: { status: 'failed', message },
      log: logEntry(message, 'error', {
        actionType: 'ai_triage',
        actionIndex,
        deviceId: context.device.id,
      }),
    };
  }

  const trigger = context.trigger;
  // Typed off the frozen 3c input rather than restated structurally, so a
  // change to the gate's alertContext shape surfaces here as a compile error.
  // Built ONLY when the trigger carries a severity: `alertContext.severity` is
  // required by the gate, and the device-tag lookup it needs is not worth a
  // query on a trigger that cannot populate it.
  let alertContext: CreateAgentRunInput['alertContext'];

  if (trigger?.severity) {
    const [deviceRow] = await db
      .select({ tags: devices.tags })
      .from(devices)
      .where(eq(devices.id, context.device.id))
      .limit(1);

    alertContext = {
      severity: trigger.severity,
      ruleId: trigger.ruleId,
      siteId: context.device.siteId,
      deviceTags: deviceRow?.tags ?? [],
    };
  }

  // managedByAgentId is attribution/bookkeeping. The admission gate resolves
  // the effective triage agent for the device org; an org override wins over
  // the managed baseline, while both ids remain traceable through triggerRef.
  const result = await createAndEnqueueAgentRun({
    orgId: context.device.orgId,
    kind: 'triage',
    triggerKind: 'alert',
    deviceId: context.device.id,
    alertId: trigger?.alertId ?? null,
    triggerEventId: trigger?.eventId ?? null,
    triggerRef: {
      automationId: context.automation.id,
      automationRunId: context.runId,
      alertRuleId: trigger?.ruleId ?? null,
      managedByAgentId: agentId,
    },
    ...(alertContext ? { alertContext } : {}),
    dedupeKey: trigger?.alertId
      ? `alert:${trigger.alertId}`
      : `event:${trigger?.eventId ?? context.runId}`,
  });

  if (result.created) {
    // `created` is NOT "queued". 3c's gate inserts the ledger row first and
    // announces/enqueues afterwards; when the publish or the BullMQ enqueue
    // throws (a Redis blip is enough) it marks the row `failed` /
    // `enqueue_failed` and STILL returns created:true with the failed run
    // (runService step 10). Branching on `created` alone would log
    // "queued agent run" at info, complete the automation run green, and leave
    // NO worker job — while the row now owns (org_id, dedupe_key), so every
    // redelivery of the same alert answers `duplicate` (a non-failure here) and
    // the alert is never triaged. The manual trigger route answers 503 on this
    // exact signal; the automation's equivalent is a failed action.
    if (result.run.status === 'failed' || result.run.errorCode === 'enqueue_failed') {
      const message = 'ai_triage agent run was created but could not be enqueued';
      return {
        outcome: { status: 'failed', message },
        log: logEntry(message, 'error', {
          actionType: 'ai_triage',
          actionIndex,
          deviceId: context.device.id,
          details: {
            agentRunId: result.run.id,
            errorCode: result.run.errorCode ?? 'enqueue_failed',
          },
        }),
      };
    }

    // The child agent run completes out-of-band and reports through
    // ai.agent.run.* events and 3c recipient notifications. The parent
    // automation action has no action-result correlation to that child run,
    // so its terminal contract is successful enqueue (not child completion).
    return {
      outcome: { status: 'succeeded' },
      log: logEntry('ai_triage queued agent run', 'info', {
        actionType: 'ai_triage',
        actionIndex,
        deviceId: context.device.id,
        details: { agentRunId: result.run.id },
      }),
    };
  }

  const hardFailure = AI_TRIAGE_SKIP_IS_FAILURE[result.skipped] ?? true;
  const message = `ai_triage skipped: ${result.skipped}`;
  return {
    outcome: hardFailure ? { status: 'failed', message } : { status: 'succeeded' },
    log: logEntry(message, hardFailure ? 'error' : 'info', {
      actionType: 'ai_triage', actionIndex, deviceId: context.device.id,
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

  if (action.type === 'ai_triage') {
    return executeAiTriageAction(action, actionIndex, context);
  }

  return {
    outcome: { status: 'failed', message: 'Unsupported action type' },
    log: logEntry(`Unsupported action type ${(action as { type?: string }).type ?? 'unknown'}`, 'error', {
      actionIndex,
      deviceId: context.device.id,
    }),
  };
}

async function persistActionExecutionOutcome(
  runId: string,
  deviceId: string,
  actionIndex: number,
  result: ActionExecutionResult,
): Promise<void> {
  const { outcome } = result;
  await recordAutomationRuntimeActionDispatch({
    runId,
    deviceId,
    actionIndex,
    status: outcome.status,
    ...('commandId' in outcome && outcome.commandId ? { commandId: outcome.commandId } : {}),
    ...('scriptExecutionId' in outcome && outcome.scriptExecutionId
      ? { scriptExecutionId: outcome.scriptExecutionId }
      : {}),
    message: outcome.status === 'failed'
      ? outcome.message ?? result.log.message
      : result.log.message,
  });
}

async function skipTrailingAutomationActions(
  runId: string,
  deviceId: string,
  actions: readonly AutomationAction[],
  failedActionIndex: number,
): Promise<void> {
  for (let actionIndex = failedActionIndex + 1; actionIndex < actions.length; actionIndex += 1) {
    await recordAutomationRuntimeActionDispatch({
      runId,
      deviceId,
      actionIndex,
      status: 'skipped',
      message: 'Skipped after an earlier automation action failed',
    });
  }
}

async function seedDeviceAutomationActions(
  runId: string,
  device: { id: string; orgId: string },
  actions: readonly AutomationAction[],
): Promise<void> {
  await withAutomationRuntimeDb(() => seedAutomationActionResults({
    runId,
    device,
    actions: actions.map((action, actionIndex) => ({ actionIndex, actionType: action.type })),
  }));
}

async function sendOnFailureNotifications(
  automation: AutomationRow,
  channelsById: Map<string, typeof notificationChannels.$inferSelect>,
  notificationTargets: NotificationTargets | undefined,
  details: {
    runId: string;
    deviceId: string;
    /** The failing DEVICE's org — automation.orgId is NULL for partner-wide (#2133). */
    deviceOrgId: string;
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
      orgId: details.deviceOrgId,
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

/**
 * Batched pass for `deploy_software` actions. Called ONCE per automation run
 * after the per-device action loop. Creates one softwareDeployments row per
 * action, filtering out devices whose OS is unsupported or whose installed
 * version is already current.
 */
export async function executeDeploySoftwareActions(args: {
  actions: AutomationAction[];
  /** Restrict a batched pass to these original normalized action indexes. */
  actionIndexes?: ReadonlySet<number>;
  // Devices carry their own orgId: deployments are org-owned child rows, so a
  // partner-wide automation (#2133) creates ONE deployment per device org.
  // For an org-owned automation every device shares its org — one deployment,
  // exactly the previous behavior.
  devices: Array<{ id: string; osType: 'windows' | 'macos' | 'linux'; orgId: string }>;
  createdBy: string | null;
  runId: string;
  resolvedReferences?: ResolvedAutomationReferences;
}): Promise<{ logs: AutomationLogEntry[]; deployedDeviceIds: Set<string>; failedDeviceIds: Set<string>; failed: boolean }> {
  const deployActions = args.actions
    .map((action, actionIndex) => ({ action, actionIndex }))
    .filter((entry): entry is { action: DeploySoftwareAction; actionIndex: number } =>
      entry.action.type === 'deploy_software'
      && (!args.actionIndexes || args.actionIndexes.has(entry.actionIndex)));
  const logs: AutomationLogEntry[] = [];
  const deployedDeviceIds = new Set<string>();
  // Devices whose deployment dispatch FAILED — used to reconcile per-device
  // result rows so a deploy-only run doesn't report those devices as `success`
  // (#2023). deployedDeviceIds and failedDeviceIds are disjoint.
  const failedDeviceIds = new Set<string>();
  let failed = false;
  if (deployActions.length === 0) return { logs, deployedDeviceIds, failedDeviceIds, failed };

  // Lazy imports — avoid pulling the agentWs→configurationPolicy chain into
  // partial-mock test suites at module-load time.
  const { createSoftwareDeployment } = await import('./softwareDeployment');
  const {
    isDeviceSoftwareCurrent,
    latestVersionsFromResolvedAutomationReferences,
    resolveLatestVersionsByCatalogId,
  } = await import('./softwareCurrency');

  // Protected runtime paths always pass ownership-resolved rows. The fallback
  // remains for isolated legacy callers of this exported batch helper only.
  const latest = args.resolvedReferences
    ? latestVersionsFromResolvedAutomationReferences(args.resolvedReferences)
    : await withAutomationRuntimeDb(() => resolveLatestVersionsByCatalogId(
      [...new Set(deployActions.map(({ action }) => action.catalogId))],
    ));

  for (const { actionIndex, action } of deployActions) {
    const info = latest.get(action.catalogId);
    if (!info) {
      failed = true;
      for (const device of args.devices) {
        failedDeviceIds.add(device.id);
        await recordAutomationRuntimeActionDispatch({
          runId: args.runId,
          deviceId: device.id,
          actionIndex,
          status: 'failed',
          message: 'No latest software version is available',
        });
      }
      logs.push(logEntry('deploy_software has no latest version for catalog', 'error', {
        actionType: action.type,
        actionIndex,
        details: { catalogId: action.catalogId },
      }));
      continue;
    }
    const supportedOs: string[] = Array.isArray(info.version.supportedOs)
      ? (info.version.supportedOs as string[])
      : [];
    // Deployments are org-owned: group eligible devices by their org so a
    // partner-wide automation creates one deployment per member org (#2133).
    const eligibleByOrg = new Map<string, string[]>();
    for (const device of args.devices) {
      if (supportedOs.length > 0 && !supportedOs.includes(device.osType)) {
        await recordAutomationRuntimeActionDispatch({
          runId: args.runId,
          deviceId: device.id,
          actionIndex,
          status: 'skipped',
          message: 'Software is not supported on this device OS',
        });
        logs.push(logEntry(`Skipped ${info.catalogName}: unsupported OS`, 'info', {
          actionType: action.type,
          actionIndex,
          deviceId: device.id,
          details: { deviceOsType: device.osType, supportedOs },
        }));
        continue;
      }
      if (await withAutomationRuntimeDb(() =>
        isDeviceSoftwareCurrent(device.id, action.catalogId, info.catalogName, info.version.version))) {
        await recordAutomationRuntimeActionDispatch({
          runId: args.runId,
          deviceId: device.id,
          actionIndex,
          status: 'skipped',
          message: 'Software is already current',
        });
        logs.push(logEntry(`Skipped ${info.catalogName}: already current`, 'info', {
          actionType: action.type,
          actionIndex,
          deviceId: device.id,
          details: { version: info.version.version },
        }));
        continue;
      }
      const bucket = eligibleByOrg.get(device.orgId) ?? [];
      bucket.push(device.id);
      eligibleByOrg.set(device.orgId, bucket);
    }
    if (eligibleByOrg.size === 0) continue;

    for (const [orgId, eligible] of eligibleByOrg) {
      const result = await withAutomationRuntimeDb(() => createSoftwareDeployment({
        orgId,
        softwareVersionId: info.version.id,
        deploymentType: 'install',
        deviceIds: eligible,
        scheduleType: 'immediate',
        createdBy: args.createdBy,
        name: `Automation: deploy ${info.catalogName}`,
      }));
      const exactDeviceResults = result.deviceResults ?? [];
      for (const deviceResult of exactDeviceResults) {
        await recordAutomationRuntimeActionDispatch({
          runId: args.runId,
          deviceId: deviceResult.deviceId,
          actionIndex,
          status: deviceResult.status,
          deploymentResultId: deviceResult.deploymentResultId,
          ...(deviceResult.deviceCommandId ? { commandId: deviceResult.deviceCommandId } : {}),
          ...(deviceResult.message ? { message: deviceResult.message } : {}),
        });
        if (deviceResult.status === 'failed') {
          failed = true;
          failedDeviceIds.add(deviceResult.deviceId);
        } else {
          deployedDeviceIds.add(deviceResult.deviceId);
        }
      }
      if (result.status === 'failed') {
        failed = true;
        for (const id of eligible) {
          if (!exactDeviceResults.some((deviceResult) => deviceResult.deviceId === id)) {
            failedDeviceIds.add(id);
            await recordAutomationRuntimeActionDispatch({
              runId: args.runId,
              deviceId: id,
              actionIndex,
              status: 'failed',
              message: result.message ?? 'Software deployment dispatch failed',
            });
          }
        }
        logs.push(logEntry(`deploy_software failed: ${result.message ?? 'unknown error'}`, 'error', {
          actionType: action.type,
          actionIndex,
          details: { catalogId: action.catalogId, deploymentId: result.deploymentId, orgId },
        }));
        continue;
      }
      for (const id of result.dispatchedDeviceIds) deployedDeviceIds.add(id);
      logs.push(logEntry(
        `Deploying ${info.catalogName} ${info.version.version} to ${eligible.length} device(s)`,
        'info',
        {
          actionType: action.type,
          actionIndex,
          details: { deploymentId: result.deploymentId, deviceIds: eligible },
        },
      ));
    }
  }
  return { logs, deployedDeviceIds, failedDeviceIds, failed };
}

type OrderedAutomationDevice = ActionExecutionContext['device'];

async function executeAutomationActionsInOrder(args: {
  actions: AutomationAction[];
  devices: OrderedAutomationDevice[];
  automation: AutomationRow;
  runId: string;
  scriptsById: ActionExecutionContext['scriptsById'];
  channelsById: ActionExecutionContext['channelsById'];
  variableScope: TenantVariableScope;
  trigger: AutomationTriggerContext | undefined;
  onFailure: 'stop' | 'continue' | 'notify';
  notificationTargets?: NotificationTargets;
  createdBy: string | null;
  resolvedReferences: ResolvedAutomationReferences;
}): Promise<{
  logs: AutomationLogEntry[];
  devicesSucceeded: number;
  devicesFailed: number;
  hasNonterminalActions: boolean;
}> {
  const logs: AutomationLogEntry[] = [];
  const activeDeviceIds = new Set(args.devices.map((device) => device.id));
  const failedDeviceIds = new Set<string>();
  let hasNonterminalActions = false;

  const handleFailure = async (
    device: OrderedAutomationDevice,
    actionIndex: number,
    message: string,
  ): Promise<void> => {
    failedDeviceIds.add(device.id);
    if (args.onFailure === 'notify') {
      try {
        logs.push(...await sendOnFailureNotifications(
          args.automation,
          args.channelsById,
          args.notificationTargets,
          {
            runId: args.runId,
            deviceId: device.id,
            deviceOrgId: device.orgId,
            message,
          },
        ));
      } catch (err) {
        // A best-effort failure notification must not strand later action rows
        // in pending or abort dispatch for unrelated devices.
        captureException(err);
        logs.push(logEntry('On-failure notification threw', 'error', {
          actionIndex,
          deviceId: device.id,
          details: { error: err instanceof Error ? err.message : String(err) },
        }));
      }
    }
    if (args.onFailure === 'stop' || args.onFailure === 'notify') {
      await skipTrailingAutomationActions(args.runId, device.id, args.actions, actionIndex);
      activeDeviceIds.delete(device.id);
    }
  };

  // Execute action-major, not device-major. Deployment dispatch is batched
  // across the still-active devices for one normalized action at a time. This
  // preserves both batching and stop/notify ordering: a refusal at action N is
  // known before action N+1 can dispatch on that device.
  for (const [actionIndex, action] of args.actions.entries()) {
    const activeDevices = args.devices.filter((device) => activeDeviceIds.has(device.id));
    if (activeDevices.length === 0) break;

    if (action.type === 'deploy_software') {
      try {
        const deployOutcome = await executeDeploySoftwareActions({
          actions: args.actions,
          actionIndexes: new Set([actionIndex]),
          devices: activeDevices.map((device) => ({
            id: device.id,
            osType: device.osType,
            orgId: device.orgId,
          })),
          createdBy: args.createdBy,
          runId: args.runId,
          resolvedReferences: args.resolvedReferences,
        });
        logs.push(...deployOutcome.logs);
        if (deployOutcome.deployedDeviceIds.size > 0) hasNonterminalActions = true;
        for (const device of activeDevices) {
          if (deployOutcome.failedDeviceIds.has(device.id)) {
            await handleFailure(device, actionIndex, 'Software deployment dispatch failed');
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[automationRuntime] software action threw during dispatch', {
          actionIndex,
          error: err,
        });
        captureException(err);
        for (const device of activeDevices) {
          await recordAutomationRuntimeActionDispatch({
            runId: args.runId,
            deviceId: device.id,
            actionIndex,
            status: 'failed',
            message,
          });
          await handleFailure(device, actionIndex, message);
        }
        logs.push(logEntry(`Automation action threw: ${message}`, 'error', { actionIndex }));
      }
      continue;
    }

    await runWithConcurrency(activeDevices, 5, async (device) => {
      try {
        const result = await withAutomationRuntimeDb(() => executeAction(action, actionIndex, buildActionExecutionContext({
          automation: args.automation,
          runId: args.runId,
          scriptsById: args.scriptsById,
          channelsById: args.channelsById,
          variableScope: args.variableScope,
          trigger: args.trigger,
        }, device)));
        logs.push(result.log);
        await persistActionExecutionOutcome(args.runId, device.id, actionIndex, result);
        if (
          result.outcome.status === 'queued'
          || result.outcome.status === 'delivered'
          || result.outcome.status === 'running'
        ) {
          hasNonterminalActions = true;
        }
        if (result.outcome.status === 'failed') {
          await handleFailure(device, actionIndex, result.log.message);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[automationRuntime] action threw during device dispatch', {
          deviceId: device.id,
          actionIndex,
          error: err,
        });
        captureException(err);
        logs.push(logEntry(`Automation action threw: ${message}`, 'error', {
          actionIndex,
          deviceId: device.id,
        }));
        await recordAutomationRuntimeActionDispatch({
          runId: args.runId,
          deviceId: device.id,
          actionIndex,
          status: 'failed',
          message,
        });
        await handleFailure(device, actionIndex, message);
      }
    });
  }

  return {
    logs,
    devicesSucceeded: args.devices.length - failedDeviceIds.size,
    devicesFailed: failedDeviceIds.size,
    hasNonterminalActions,
  };
}

export async function createAutomationRunRecord(options: {
  automation: AutomationRow;
  triggeredBy: string;
  details?: Record<string, unknown>;
  /** Event-target binding (#3824): when set, the run targets EXACTLY these
   * devices and resolveAutomationTargetDeviceIds is NOT consulted. */
  boundDeviceIds?: string[];
}): Promise<{ run: AutomationRunRow; targetDeviceIds: string[] }> {
  const normalized = normalizeAutomationInput({
    trigger: options.automation.trigger,
    actions: options.automation.actions,
    conditions: options.automation.conditions,
    onFailure: options.automation.onFailure,
    notificationTargets: options.automation.notificationTargets,
  });
  const targetDeviceIds = options.boundDeviceIds
    ?? await resolveAutomationTargetDeviceIds(options.automation);

  const run = await db.transaction(async (tx) => {
    await resolveStandaloneAutomationReferencesForAdmission(tx, options.automation, normalized);

    const [created] = await tx
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

    if (!created) {
      throw new Error('Failed to create automation run record');
    }

    await tx
      .update(automations)
      .set({
        runCount: sql`${automations.runCount} + 1`,
        lastRunAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(automations.id, options.automation.id));
    return created;
  });

  // Lifecycle events carry an org. An org-owned automation publishes to its
  // own org (unchanged); a partner-wide automation (orgId NULL, #2133) has no
  // org of its own, so publish once per distinct TARGET-device org — keeping
  // org-scoped consumers (event-triggered automations, alert bridges) working
  // in every member org the run touches.
  const eventOrgIds = options.automation.orgId
    ? [options.automation.orgId]
    : await distinctDeviceOrgIds(targetDeviceIds);
  if (eventOrgIds.length === 0) {
    // Partner-wide run with zero resolved targets: there is no org to publish
    // to, so lifecycle consumers see nothing. Leave a trace for operators.
    console.warn(
      `[AutomationRuntime] partner-wide automation ${options.automation.id} run ${run.id} resolved zero target devices — no automation.started event published`,
    );
  }
  for (const eventOrgId of eventOrgIds) {
    await publishEvent(
      'automation.started',
      eventOrgId,
      {
        automationId: options.automation.id,
        runId: run.id,
        triggeredBy: options.triggeredBy,
        devicesTargeted: targetDeviceIds.length,
      },
      'automation-runtime',
    );
  }

  return { run, targetDeviceIds };
}

async function distinctDeviceOrgIds(deviceIds: string[]): Promise<string[]> {
  if (deviceIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ orgId: devices.orgId })
    .from(devices)
    .where(inArray(devices.id, deviceIds));
  return rows.map((row) => row.orgId);
}

type DeviceExecutionRow = {
  id: string;
  orgId: string;
  hostname: string | null;
  displayName: string | null;
  osType: 'windows' | 'macos' | 'linux';
  status: string;
};

/**
 * Seed one `automation_run_device_results` row per targeted device in the
 * `pending` state (#2023). Called before the per-device execution loop so a
 * polling UI can show every target device up front. org_id is the DEVICE's org
 * (partner-wide automations have no org of their own). Idempotent per
 * (run_id, device_id) so a re-executed run doesn't duplicate rows.
 */
async function seedAutomationDeviceResults(
  runId: string,
  deviceRows: DeviceExecutionRow[],
): Promise<void> {
  if (deviceRows.length === 0) return;
  await db
    .insert(automationRunDeviceResults)
    .values(
      deviceRows.map((device) => ({
        runId,
        deviceId: device.id,
        orgId: device.orgId,
        status: 'pending' as const,
      })),
    )
    .onConflictDoNothing({
      target: [automationRunDeviceResults.runId, automationRunDeviceResults.deviceId],
    });
}

/**
 * Best-effort recovery when executeAutomationRun throws (#2023): a run left in
 * `running` (and its seeded device rows left `pending`/`running`) would show as
 * a perpetually in-progress run in the history UI and keep the client poller
 * spinning forever. Advance the run and any non-terminal device rows to
 * `failed`. Only touches a still-`running` run, so a throw that happens AFTER
 * the run already reached a terminal state (e.g. inside a completion
 * publishEvent) is left untouched.
 */
async function markAutomationRunFailedAfterError(runId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await db
    .update(automationRuns)
    .set({ status: 'failed', completedAt: new Date() })
    .where(and(eq(automationRuns.id, runId), eq(automationRuns.status, 'running')));
  await db
    .update(automationRunDeviceResults)
    .set({ status: 'failed', completedAt: new Date(), error: message, updatedAt: new Date() })
    .where(
      and(
        eq(automationRunDeviceResults.runId, runId),
        inArray(automationRunDeviceResults.status, ['pending', 'running']),
      ),
    );
}

export async function executeAutomationRun(
  runId: string,
  targetDeviceIdsFromQueue?: string[],
  triggerContext?: AutomationTriggerContext,
): Promise<{
  status: 'running' | 'completed' | 'failed' | 'partial';
  devicesSucceeded: number;
  devicesFailed: number;
}> {
  try {
    return await executeAutomationRunInner(runId, targetDeviceIdsFromQueue, triggerContext);
  } catch (err) {
    await withAutomationRuntimeDb(() => markAutomationRunFailedAfterError(runId, err)).catch((cleanupErr) => {
      console.error(
        `[AutomationRuntime] failed to mark run ${runId} failed after execution error:`,
        cleanupErr,
      );
    });
    throw err;
  }
}

/**
 * Builds the per-device ActionExecutionContext for one run. Extracted (and
 * exported for tests via __testOnly) so the #3824 event-target binding —
 * `trigger` reaching EVERY action's context — is unit-provable without
 * driving a full mocked run.
 */
function buildActionExecutionContext(base: {
  automation: ActionExecutionContext['automation'];
  runId: string;
  scriptsById: ActionExecutionContext['scriptsById'];
  channelsById: ActionExecutionContext['channelsById'];
  variableScope: ActionExecutionContext['variableScope'];
  /** REQUIRED (explicit `undefined` for unbound runs), not optional: an
   *  optional property would let the call site silently drop the event
   *  binding and still compile — the exact #3824 failure mode. */
  trigger: AutomationTriggerContext | undefined;
}, device: ActionExecutionContext['device']): ActionExecutionContext {
  return { ...base, device };
}

async function executeAutomationRunInner(
  runId: string,
  targetDeviceIdsFromQueue?: string[],
  triggerContext?: AutomationTriggerContext,
): Promise<{
  status: 'running' | 'completed' | 'failed' | 'partial';
  devicesSucceeded: number;
  devicesFailed: number;
}> {
  const [run] = await withAutomationRuntimeDb(() => db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.id, runId))
    .limit(1));

  if (!run) {
    throw new Error('Automation run not found');
  }

  if (!run.automationId) {
    throw new Error('Automation run is not linked to a standalone automation (may be a config policy run)');
  }
  const automationId = run.automationId;

  const [automation] = await withAutomationRuntimeDb(() => db
    .select()
    .from(automations)
    .where(eq(automations.id, automationId))
    .limit(1));

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

  // A queued job is not authorization. Re-check the active binding snapshot
  // and live resource ownership before any dispatch-side write.
  const resolvedReferences = await withAutomationRuntimeDb(() => db.transaction((tx) =>
    resolveStandaloneAutomationReferencesForAdmission(tx, automation, normalized)));

  const targetDeviceIds = targetDeviceIdsFromQueue && targetDeviceIdsFromQueue.length > 0
    ? targetDeviceIdsFromQueue
    : await withAutomationRuntimeDb(() => resolveAutomationTargetDeviceIds(automation));

  await withAutomationRuntimeDb(() => db
    .update(automationRuns)
    .set({
      devicesTargeted: targetDeviceIds.length,
    })
    .where(eq(automationRuns.id, run.id)));

  const deviceRows = targetDeviceIds.length > 0
    ? await withAutomationRuntimeDb(() => db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        hostname: devices.hostname,
        displayName: devices.displayName,
        osType: devices.osType,
        status: devices.status,
        agentId: devices.agentId,
        // #3409 PR3 P3 — sourced parameters (`builtin` / `deviceCustomField`)
        // resolve against these. Selected once here with the rest of the run's
        // device snapshot; see ActionExecutionContext.device.
        siteId: devices.siteId,
        customFields: devices.customFields,
      })
      .from(devices)
      .where(inArray(devices.id, targetDeviceIds)))
    : [];

  const scriptsById = resolvedReferences.scriptsById;
  const channelsById = resolvedReferences.notificationChannelsById;

  // Seed a per-device result row (pending) for every targeted device so the
  // execution-history UI can show live progress as each device finishes (#2023).
  await withAutomationRuntimeDb(() => seedAutomationDeviceResults(run.id, deviceRows));
  for (const device of deviceRows) {
    await seedDeviceAutomationActions(run.id, device, normalized.actions);
  }

  const existingLogs = getExistingLogs(run.logs);
  const logs: AutomationLogEntry[] = [...existingLogs];
  // ONE preload for the whole run, over the distinct org set of every device
  // this run targets (#3409 PR3 P2) — never inside the concurrency loop below.
  const variableScope = await loadAutomationRunVariableScope(
    normalized.actions,
    scriptsById,
    deviceRows.map((device) => device.orgId),
  );

  const actionOutcome = await executeAutomationActionsInOrder({
    actions: normalized.actions,
    devices: deviceRows,
    automation,
    createdBy: automation.createdBy ?? null,
    runId: run.id,
    scriptsById,
    channelsById,
    variableScope,
    trigger: triggerContext,
    onFailure: normalized.onFailure,
    notificationTargets: normalized.notificationTargets,
    resolvedReferences,
  });
  logs.push(...actionOutcome.logs);
  const { devicesSucceeded, devicesFailed, hasNonterminalActions } = actionOutcome;

  logs.push(logEntry('Automation dispatch phase finished', devicesFailed > 0 ? 'warning' : 'info', {
    details: {
      devicesSucceeded,
      devicesFailed,
      devicesTargeted: targetDeviceIds.length,
    },
  }));

  await withAutomationRuntimeDb(() => db.update(automationRuns).set({ logs }).where(eq(automationRuns.id, run.id)));
  await withAutomationRuntimeDb(() => reconcileAutomationRun(run.id));
  if (deviceRows.length === 0 || normalized.actions.length === 0) {
    await withAutomationRuntimeDb(() => db.update(automationRuns).set({
      status: 'completed',
      devicesSucceeded: 0,
      devicesFailed: 0,
      completedAt: new Date(),
    }).where(and(eq(automationRuns.id, run.id), eq(automationRuns.status, 'running'))));
  }
  const status: 'running' | 'completed' | 'failed' | 'partial' = hasNonterminalActions
    ? 'running'
    : devicesFailed === 0
      ? 'completed'
      : devicesSucceeded === 0
        ? 'failed'
        : 'partial';

  return {
    status,
    devicesSucceeded: hasNonterminalActions ? 0 : devicesSucceeded,
    devicesFailed: hasNonterminalActions ? 0 : devicesFailed,
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

export { isCronDue, matchesCronField } from './cronDue';

// ============================================
// Config Policy Automation Support
// ============================================

type ConfigPolicyAutomationRow = typeof configPolicyAutomations.$inferSelect;

async function resolveConfigPolicyAutomationContext(
  tx: DbTransaction,
  featureLinkId: string,
): Promise<{ configPolicyId: string; orgId: string | null; partnerId: string | null } | null> {
  const [row] = await tx
    .select({
      configPolicyId: configurationPolicies.id,
      orgId: configurationPolicies.orgId,
      partnerId: configurationPolicies.partnerId,
    })
    .from(configPolicyFeatureLinks)
    .innerJoin(
      configurationPolicies,
      eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
    )
    .where(eq(configPolicyFeatureLinks.id, featureLinkId))
    .limit(1);
  return row ?? null;
}

async function admitConfigPolicyAutomationRun(
  options: {
    automation: ConfigPolicyAutomationRow;
    targetDeviceIds: string[];
    triggeredBy: string;
    details?: Record<string, unknown>;
  },
  actions: readonly AutomationAction[] | null,
  requireOrgId: boolean,
): Promise<{
  run: AutomationRunRow;
  context: { configPolicyId: string; orgId: string | null; partnerId: string | null };
  resolvedReferences: ResolvedAutomationReferences | null;
}> {
  return db.transaction(async (tx) => {
    const context = await resolveConfigPolicyAutomationContext(tx, options.automation.featureLinkId);
    if (!context) {
      throw new Error(
        `Could not resolve configurationPolicies.id for config policy automation ${options.automation.id} (featureLinkId=${options.automation.featureLinkId})`,
      );
    }
    if (requireOrgId && !context.orgId) {
      throw new Error(`Could not resolve orgId for config policy automation ${options.automation.id}`);
    }

    const resolvedReferences = actions
      ? await resolveAutomationReferencesForOwner(
        tx,
        { orgId: context.orgId, partnerId: context.partnerId },
        actions,
      )
      : null;
    const [run] = await tx
      .insert(automationRuns)
      .values({
        automationId: null,
        configPolicyId: context.configPolicyId,
        configItemName: options.automation.name,
        triggeredBy: options.triggeredBy,
        status: 'running',
        devicesTargeted: options.targetDeviceIds.length,
        devicesSucceeded: 0,
        devicesFailed: 0,
        logs: [
          logEntry('Config policy automation run created', 'info', {
            details: {
              triggeredBy: options.triggeredBy,
              configPolicyAutomationId: options.automation.id,
              configItemName: options.automation.name,
              ...options.details,
            },
          }),
        ],
      })
      .returning();

    if (!run) throw new Error('Failed to create config policy automation run record');
    return { run, context, resolvedReferences };
  });
}

/**
 * Creates an automationRuns record for a config policy automation execution.
 * Uses `automationId: null` and fills `configPolicyId` + `configItemName`.
 *
 * `configPolicyId` is resolved to the owning `configurationPolicies.id` (NOT
 * the feature-link id on `automation.featureLinkId`) so the run is readable by
 * org-scoped consumers — see `resolveConfigPolicyId` / issue #1855.
 */
export async function createConfigPolicyAutomationRun(options: {
  automation: ConfigPolicyAutomationRow;
  targetDeviceIds: string[];
  triggeredBy: string;
  details?: Record<string, unknown>;
}): Promise<AutomationRunRow> {
  const actions = normalizeAutomationActions(options.automation.actions);
  const admission = await admitConfigPolicyAutomationRun(options, actions, false);
  return admission.run;
}

/**
 * Executes a config policy automation against a list of target devices.
 * Reuses the existing action execution infrastructure (executeAction) under the hood.
 */
export async function executeConfigPolicyAutomationRun(
  automation: ConfigPolicyAutomationRow,
  targetDeviceIds: string[],
  triggeredBy: string,
): Promise<{
  runId: string;
  status: 'running' | 'completed' | 'failed' | 'partial';
  devicesSucceeded: number;
  devicesFailed: number;
}> {
  let actions: AutomationAction[];
  try {
    actions = normalizeAutomationActions(automation.actions);
  } catch (error) {
    // Legacy/corrupt rows still produce an observable failed run, matching the
    // pre-authorization runtime contract. No action can be dispatched because
    // parsing failed, so this branch deliberately skips reference resolution.
    const admission = await withAutomationRuntimeDb(() => admitConfigPolicyAutomationRun(
      { automation, targetDeviceIds, triggeredBy },
      null,
      true,
    ));
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await withAutomationRuntimeDb(() => db
      .update(automationRuns)
      .set({
        status: 'failed',
        completedAt: new Date(),
        logs: [
          ...getExistingLogs(admission.run.logs),
          logEntry(`Failed to parse automation actions: ${errorMsg}`, 'error'),
        ],
      })
      .where(eq(automationRuns.id, admission.run.id)));

    return {
      runId: admission.run.id,
      status: 'failed',
      devicesSucceeded: 0,
      devicesFailed: targetDeviceIds.length,
    };
  }
  const admission = await withAutomationRuntimeDb(() => admitConfigPolicyAutomationRun(
    { automation, targetDeviceIds, triggeredBy },
    actions,
    true,
  ));
  if (!admission.resolvedReferences) {
    throw new Error('Config policy automation admission did not resolve references');
  }
  const orgId = admission.context.orgId!;
  const run = admission.run;

  const onFailure = automation.onFailure ?? 'stop';

  // Load target devices
  const deviceRows = targetDeviceIds.length > 0
    ? await withAutomationRuntimeDb(() => db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        hostname: devices.hostname,
        displayName: devices.displayName,
        osType: devices.osType,
        status: devices.status,
        agentId: devices.agentId,
        // #3409 PR3 P3 — mirrors the standalone runner's projection above;
        // both feed the same ActionExecutionContext.device.
        siteId: devices.siteId,
        customFields: devices.customFields,
      })
      .from(devices)
      .where(inArray(devices.id, targetDeviceIds)))
    : [];
  await withAutomationRuntimeDb(() => seedAutomationDeviceResults(run.id, deviceRows));
  for (const device of deviceRows) {
    await seedDeviceAutomationActions(run.id, device, actions);
  }

  const notificationChannelIds = new Set<string>();
  for (const action of actions) {
    if (action.type === 'send_notification') {
      notificationChannelIds.add(action.notificationChannelId);
    }
  }

  const scriptsById = admission.resolvedReferences.scriptsById;
  const channelsById = admission.resolvedReferences.notificationChannelsById;

  const syntheticAutomation = {
    id: automation.id,
    orgId,
    name: automation.name,
    createdBy: null,
    // Config-policy automations are never agent-managed (#3824): managed rows
    // live in `automations` and are resolved through managed_by_agent_id.
    managedByAgentId: null,
  };

  const existingLogs = getExistingLogs(run.logs);
  const logs: AutomationLogEntry[] = [...existingLogs];
  // ONE preload for the whole run (#3409 PR3 P2) — see the standalone runner.
  const variableScope = await loadAutomationRunVariableScope(
    actions,
    scriptsById,
    deviceRows.map((device) => device.orgId),
  );

  const notifyTargets: NotificationTargets | undefined = notificationChannelIds.size > 0
    ? { channelIds: [...notificationChannelIds] }
    : undefined;
  const actionOutcome = await executeAutomationActionsInOrder({
    actions,
    devices: deviceRows,
    automation: syntheticAutomation as AutomationRow,
    createdBy: null,
    runId: run.id,
    scriptsById,
    channelsById,
    variableScope,
    trigger: undefined,
    onFailure,
    notificationTargets: notifyTargets,
    resolvedReferences: admission.resolvedReferences,
  });
  logs.push(...actionOutcome.logs);
  const { devicesSucceeded, devicesFailed, hasNonterminalActions } = actionOutcome;

  logs.push(logEntry('Config policy automation dispatch phase finished', devicesFailed > 0 ? 'warning' : 'info', {
    details: {
      devicesSucceeded,
      devicesFailed,
      devicesTargeted: targetDeviceIds.length,
    },
  }));

  await withAutomationRuntimeDb(() => db.update(automationRuns).set({ logs }).where(eq(automationRuns.id, run.id)));
  await withAutomationRuntimeDb(() => reconcileAutomationRun(run.id));
  if (deviceRows.length === 0 || actions.length === 0) {
    await withAutomationRuntimeDb(() => db.update(automationRuns).set({
      status: 'completed',
      devicesSucceeded: 0,
      devicesFailed: 0,
      completedAt: new Date(),
    }).where(and(eq(automationRuns.id, run.id), eq(automationRuns.status, 'running'))));
  }
  const status: 'running' | 'completed' | 'failed' | 'partial' = hasNonterminalActions
    ? 'running'
    : devicesFailed === 0
      ? 'completed'
      : devicesSucceeded === 0
        ? 'failed'
        : 'partial';

  return {
    runId: run.id,
    status,
    devicesSucceeded: hasNonterminalActions ? 0 : devicesSucceeded,
    devicesFailed: hasNonterminalActions ? 0 : devicesFailed,
  };
}

// Exported for unit tests of the #3824 event-target binding. Internal helper,
// not part of the runtime's public surface.
export const __testOnly = {
  buildActionExecutionContext,
  executeAction,
  executeAiTriageAction,
};
