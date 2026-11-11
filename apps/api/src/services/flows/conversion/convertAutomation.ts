/**
 * Tool Catalog W06 (#5221) Task A7 — the pure converter from a standalone
 * legacy automation ("Job") to a flow document, with a fidelity class and
 * coded findings (plan, Conversion map). Total and deterministic: the same
 * row and context always give the same bytes; nothing here reads the clock,
 * the database or the environment (the context carries every fact).
 *
 * Execution model. Legacy runs ACTION-MAJOR with a per-device stop: every
 * active device runs action 0, then action 1, …; under `stop`/`notify` a
 * device whose action failed is dropped from later actions, under `continue`
 * it stays. The flow keeps that order with one fleet step per device action
 * (`run_script_on_targets`, onFailure 'continue' so other devices go on) and
 * chains the next step on its `succeededDeviceIds` (stop/notify) or
 * `dispatchedDeviceIds` (continue). A per-device notice or alert is a
 * for-each over the active set's devices (with hostnames) from a
 * `resolve_targets` step. Step ids: `targets`, `a<i>_<kind>`, `a<i>_devices`,
 * `a<i>_failed`, `a<i>_failnotice_<n>`.
 *
 * Blockers return no document (preview only). `detail` strings carry ids and
 * field names only.
 */
import { createHash } from 'node:crypto';
import {
  CONVERSION_TARGET_HEADROOM,
  FLEET_MAX_TARGETS,
  FLOW_RUN_LIMITS,
  LEGACY_CONDITION_TYPES,
  fidelityOf,
  isStructurallyValidCron,
  type FlowConversionFidelity,
  type FlowConversionFinding,
  type FlowDocumentV1,
} from '@breeze/shared';
import type { automations } from '../../../db/schema';
import { canonicalizeArguments } from '../../actionIntents/canonicalize';
import { isCronDue } from '../../cronDue';
import { isChannelMessageType } from '../../notificationSenders/channelMessageTypes';
import type { ToolOwnerRef } from '../../toolSources/resolver';
import { classifyAutomation } from './classify';
import { finding, sortFindings } from './findings';

type AutomationRow = typeof automations.$inferSelect;
type FlowStep = FlowDocumentV1['steps'][number];

export interface ConversionContext {
  owner: ToolOwnerRef;
  flowsEnabled: boolean;
  eventDispatchDurable: boolean;
  legacySecretHeaderAllowed: boolean;
  /** The Job's current static target set; null = event-bound (the triggering device). */
  currentTargets: { count: number; osTypes: ReadonlySet<'windows' | 'macos' | 'linux'> } | null;
  channels: Map<string, { type: string; ownedByOwner: boolean }>;
  scripts: Map<string, { ownedByOwner: boolean; effectiveRunAs: 'system' | 'user' | 'elevated'; preApprovable: boolean }>;
  isRemediationTarget: boolean;
  liveMonitorConversion: boolean;
  creatorHasSiteCeiling: boolean;
  partnerOrgs: { live: number; total: number } | null;
  limits: { monthlyRunsPerFlow: number; monthlyRunsPerOwner: number; ownerRunsThisMonth: number };
  observedMonthlyRuns: number | null;
}

export interface GeneratedScriptSpec {
  stepId: string;
  name: string;
  language: 'bash' | 'powershell' | 'cmd';
  body: string;
}

export interface ConversionResult {
  fidelity: FlowConversionFidelity;
  findings: FlowConversionFinding[];
  document: FlowDocumentV1 | null;
  preApprovalCandidates: { stepId: string; currentTargetCount: number | null }[];
  generatedScripts: GeneratedScriptSpec[];
  sourceDigest: string;
  sourceSnapshot: Record<string, unknown>;
  documentDigest: string | null;
  estimatedMonthlyRuns: number | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** The fields that decide what a Job does — never its webhook secret, name or owner. */
export function automationSourceSnapshot(row: Pick<AutomationRow, 'trigger' | 'conditions' | 'actions' | 'onFailure' | 'notificationTargets'>): Record<string, unknown> {
  const trigger = isRecord(row.trigger) ? { ...row.trigger } : row.trigger;
  if (isRecord(trigger)) {
    delete trigger.secret;
    delete trigger.webhookSecret;
    delete trigger.webhookUrl;
  }
  return {
    trigger: trigger ?? null,
    conditions: row.conditions ?? null,
    actions: row.actions ?? null,
    onFailure: row.onFailure,
    notificationTargets: row.notificationTargets ?? null,
  };
}

export function automationSourceDigest(row: Pick<AutomationRow, 'trigger' | 'conditions' | 'actions' | 'onFailure' | 'notificationTargets'>): string {
  return sha256(canonicalizeArguments(automationSourceSnapshot(row)));
}

/** A placeholder id for a script the switch will create (rewritten into the draft then). Stable per Job + action. */
export function generatedScriptPlaceholderId(automationId: string, actionIndex: number): string {
  const h = sha256(`flow-conversion-generated-script:${automationId}:${actionIndex}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Fixed window so the estimate is deterministic: 30 days from 2027-01-04 (a Monday). */
const ESTIMATE_WINDOW_START = Date.UTC(2027, 0, 4);
const ESTIMATE_MINUTES = 30 * 24 * 60;

function scheduledRunsPerMonth(cron: string, tz: string): number {
  let n = 0;
  for (let m = 0; m < ESTIMATE_MINUTES; m++) {
    if (isCronDue(cron, tz, new Date(ESTIMATE_WINDOW_START + m * 60_000))) n++;
  }
  return n;
}

const SEVERITY_TO_NOTICE: Record<string, 'info' | 'warning' | 'critical'> = {
  critical: 'critical', high: 'warning', medium: 'warning', low: 'info', info: 'info',
};

/** Legacy create_alert device placeholders (interpolateAlertTemplate), mapped onto the for-each item. */
const ALERT_PLACEHOLDERS: Record<string, string> = {
  device: '{{item.name}}',
  deviceName: '{{item.name}}',
  'device.name': '{{item.name}}',
  hostname: '{{item.hostname}}',
  'device.hostname': '{{item.hostname}}',
};

const TEMPLATE_TOKEN_RE = /\{\{([\w.]+)\}\}/g;

function alertText(text: string): string | null {
  const mapped = text.replace(TEMPLATE_TOKEN_RE, (m, key: string) => ALERT_PLACEHOLDERS[key] ?? m);
  // Anything else that a flow would read as a template cannot be carried exactly.
  const leftover = mapped.replace(/\{\{item\.(name|hostname)\}\}/g, '');
  return leftover.includes('{{') ? null : mapped;
}

const EVENT_FILTER_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_.]{0,127}$/;

interface Selector {
  input: Record<string, unknown>;
  /** Literal target set, or the triggering device. */
  kind: 'target' | 'conditions' | 'trigger_device';
}

export function convertAutomation(row: AutomationRow, ctx: ConversionContext): ConversionResult {
  const findings: FlowConversionFinding[] = [];
  const sourceSnapshot = automationSourceSnapshot(row);
  const sourceDigest = sha256(canonicalizeArguments(sourceSnapshot));
  const done = (document: FlowDocumentV1 | null, extra: Partial<ConversionResult> = {}): ConversionResult => {
    const sorted = sortFindings(findings);
    const fidelity = fidelityOf(sorted);
    const doc = fidelity === 'unconvertible' ? null : document;
    return {
      fidelity,
      findings: sorted,
      document: doc,
      preApprovalCandidates: doc ? extra.preApprovalCandidates ?? [] : [],
      generatedScripts: doc ? extra.generatedScripts ?? [] : [],
      sourceDigest,
      sourceSnapshot,
      documentDigest: doc ? sha256(canonicalizeArguments(doc as unknown as Record<string, unknown>)) : null,
      estimatedMonthlyRuns: extra.estimatedMonthlyRuns ?? null,
    };
  };

  // ── 1. rows never converted ──────────────────────────────────────────────
  const cls = classifyAutomation(row);
  if (cls === 'M' || cls === 'A') {
    findings.push(finding('managed_row', null, `class ${cls}`));
    return done(null);
  }
  if (cls === 'P') {
    findings.push(finding('policy_workflow', null, 'trigger.filter._policyWorkflow'));
    return done(null);
  }
  if (cls === 'retired' || ctx.liveMonitorConversion) {
    findings.push(finding('already_retired', null, cls === 'retired' ? 'retired_at is set' : 'a live monitor conversion exists'));
    return done(null);
  }
  if (ctx.isRemediationTarget) {
    findings.push(finding('compliance_remediation_target', null, 'a compliance policy remediates through this Job'));
    return done(null);
  }
  if (!ctx.flowsEnabled) findings.push(finding('flows_disabled', null, 'FLOWS_ENABLED is off'));

  const name = row.name.length > 120 ? row.name.slice(0, 120) : row.name;
  if (row.name.length > 120) findings.push(finding('name_truncated', null, `name length ${row.name.length}`));
  const partnerWide = !row.orgId;

  // ── 2. trigger ───────────────────────────────────────────────────────────
  const t = isRecord(row.trigger) ? row.trigger : {};
  let trigger: FlowDocumentV1['trigger'];
  let estimatedMonthlyRuns: number | null = ctx.observedMonthlyRuns;
  const triggerType = str(t.type);
  if (triggerType === 'schedule') {
    const cron = str(t.cronExpression) ?? str(t.cron) ?? '';
    const tz = str(t.timezone) ?? 'UTC';
    if (!isStructurallyValidCron(cron) || !validTimeZone(tz)) {
      findings.push(finding('cron_semantics_differ', null, 'trigger.cronExpression / trigger.timezone'));
    } else {
      estimatedMonthlyRuns = scheduledRunsPerMonth(cron, tz);
    }
    findings.push(finding('schedule_outage_catch_up', null, 'trigger.schedule'));
    trigger = { type: 'schedule', cron, timezone: tz };
  } else if (triggerType === 'event') {
    const event = str(t.eventType) ?? str(t.event) ?? '';
    const rawFilter = isRecord(t.filter) ? t.filter : {};
    const filter: Record<string, string | number | boolean | null> = {};
    const keys = Object.keys(rawFilter);
    if (keys.length > 20) findings.push(finding('event_filter_not_strict', null, `trigger.filter has ${keys.length} keys`));
    for (const key of keys.sort()) {
      const v = rawFilter[key];
      if (!EVENT_FILTER_KEY_RE.test(key) || Array.isArray(v) || isRecord(v)) {
        findings.push(finding('event_filter_not_strict', null, `trigger.filter.${key.slice(0, 128)}`));
      } else if (v === null) {
        findings.push(finding('event_filter_null', null, `trigger.filter.${key}`));
      } else if (typeof v === 'string') {
        findings.push(finding('event_filter_string_coercion', null, `trigger.filter.${key}`));
        filter[key] = v;
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        filter[key] = v;
      } else {
        findings.push(finding('event_filter_not_strict', null, `trigger.filter.${key}`));
      }
    }
    if (t.durationMinutes !== undefined) findings.push(finding('duration_minutes_ignored', null, 'trigger.durationMinutes'));
    if (!ctx.eventDispatchDurable) findings.push(finding('event_dispatch_not_durable', null, 'EVENT_DISPATCH_MODE / EVENT_DISPATCH_QUEUE_SUBSCRIBERS'));
    trigger = { type: 'event', event, filter };
  } else if (triggerType === 'webhook') {
    if (partnerWide) findings.push(finding('partner_wide_webhook', null, 'a partner-wide webhook flow needs an org resolver'));
    findings.push(finding('webhook_body_shape', null, 'flow webhooks accept JSON-object bodies only'));
    findings.push(finding('webhook_url_changes', null, 'the legacy URL forwards until retirement'));
    if (ctx.legacySecretHeaderAllowed) findings.push(finding('legacy_secret_header_possible', null, 'AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET'));
    trigger = { type: 'webhook', auth: 'hmac' };
  } else if (triggerType === 'manual') {
    trigger = { type: 'manual' };
  } else {
    findings.push(finding('cron_semantics_differ', null, `trigger.type ${String(triggerType).slice(0, 32)}`));
    trigger = { type: 'manual' };
  }

  // ── 3. owner fan-out ─────────────────────────────────────────────────────
  if (partnerWide && ctx.partnerOrgs) {
    const blocker = ctx.partnerOrgs.total > FLEET_MAX_TARGETS;
    findings.push(finding('partner_wide_org_set_differs', null, `${ctx.partnerOrgs.live} of ${ctx.partnerOrgs.total} orgs`, blocker ? 'blocker' : 'review'));
    if (estimatedMonthlyRuns !== null) estimatedMonthlyRuns *= Math.max(1, ctx.partnerOrgs.live);
  }
  if (ctx.creatorHasSiteCeiling) findings.push(finding('site_ceiling_removed', null, 'created_by has a site ceiling'));

  // ── 4. targets ───────────────────────────────────────────────────────────
  const selector = selectorOf(row, triggerType === 'event', findings, partnerWide);
  if (ctx.currentTargets && ctx.currentTargets.count > CONVERSION_TARGET_HEADROOM) {
    findings.push(finding('targets_over_cap', null, `${ctx.currentTargets.count} current targets`));
  }
  const activeCount = ctx.currentTargets ? ctx.currentTargets.count : 1;

  // ── 5. actions ───────────────────────────────────────────────────────────
  const onFailure = row.onFailure === 'continue' || row.onFailure === 'notify' ? row.onFailure : 'stop';
  const chainSet: 'succeeded' | 'dispatched' = onFailure === 'continue' ? 'dispatched' : 'succeeded';
  const notice = isRecord(row.notificationTargets) ? row.notificationTargets : {};
  const failureChannels = onFailure === 'notify' && Array.isArray(notice.channelIds)
    ? (notice.channelIds as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];
  if (Array.isArray(notice.emails) && notice.emails.length > 0) {
    findings.push(finding('notification_emails_unused', null, 'notificationTargets.emails'));
  }
  for (const c of failureChannels) checkChannel(c, null, ctx, findings);

  const actions = Array.isArray(row.actions) ? row.actions.filter(isRecord) : [];
  const steps: FlowStep[] = [];
  const candidates: ConversionResult['preApprovalCandidates'] = [];
  const generated: GeneratedScriptSpec[] = [];
  const step = (s: Omit<FlowStep, 'approval' | 'onFailure' | 'timeoutSec'> & Partial<FlowStep>): FlowStep =>
    ({ approval: 'default', onFailure: 'continue', timeoutSec: 300, ...s }) as FlowStep;

  let active: { stepId: string; kind: 'resolve' | 'fleet' } | null = null;
  const isDeviceAction = (a: Record<string, unknown>) => a.type === 'run_script' || a.type === 'execute_command';
  if (actions.length > 0 && !isDeviceAction(actions[0]!)) {
    steps.push(step({ id: 'targets', tool: 'resolve_targets', input: selector.input, onFailure: 'stop' }));
    active = { stepId: 'targets', kind: 'resolve' };
  }
  /** The for-each items (devices with hostnames) of the current active set; may add a resolve step. */
  const activeDevices = (i: number): string => {
    if (active?.kind === 'resolve') return `steps.${active.stepId}.output.devices`;
    if (!active) {
      steps.push(step({ id: 'targets', tool: 'resolve_targets', input: selector.input, onFailure: 'stop' }));
      active = { stepId: 'targets', kind: 'resolve' };
      return 'steps.targets.output.devices';
    }
    const id = `a${i}_devices`;
    steps.push(step({ id, tool: 'resolve_targets', input: { fromStep: { stepId: active.stepId, set: chainSet } } }));
    return `steps.${id}.output.devices`;
  };

  let notices = 0;
  let sawScript = false;
  const isWebhook = triggerType === 'webhook';
  for (const [i, a] of actions.entries()) {
    const type = str(a.type);
    if (type === 'run_script' || type === 'execute_command') {
      let scriptId: string;
      let runAs: 'system' | 'user' | undefined;
      let kind: string;
      let preApprovable = false;
      if (type === 'run_script') {
        kind = 'run_script';
        scriptId = str(a.scriptId) ?? str(a.script_id) ?? '';
        const s = ctx.scripts.get(scriptId);
        if (!s || !s.ownedByOwner) {
          findings.push(finding('reference_not_owned', i, `actions[${i}].scriptId`));
        } else {
          const explicit = a.runAs === 'system' || a.runAs === 'user' || a.runAs === 'elevated' ? a.runAs : undefined;
          const effective = explicit ?? s.effectiveRunAs;
          if (effective === 'elevated') findings.push(finding('run_as_elevated', i, `actions[${i}].runAs`));
          if (explicit === 'system' || explicit === 'user') runAs = explicit;
          preApprovable = s.preApprovable && effective !== 'elevated';
        }
      } else {
        kind = 'command';
        if (a.kind === 'restart_service') {
          findings.push(finding('restart_service_monitor_only', i, `actions[${i}].kind`));
          continue;
        }
        findings.push(finding('command_becomes_script', i, `actions[${i}].command`));
        const shell = a.shell === 'bash' || a.shell === 'powershell' || a.shell === 'cmd' ? a.shell : undefined;
        let language: 'bash' | 'powershell' | 'cmd' | undefined = shell;
        if (!language) {
          const oses = ctx.currentTargets ? [...ctx.currentTargets.osTypes] : [];
          if (oses.length === 1) language = oses[0] === 'windows' ? 'powershell' : 'bash';
          else findings.push(finding('command_mixed_os', i, ctx.currentTargets ? `actions[${i}].shell unset over ${oses.length} OS types` : `actions[${i}].shell unset and the target OS is not known in advance`));
        }
        scriptId = generatedScriptPlaceholderId(row.id, i);
        generated.push({
          stepId: `a${i}_command`,
          name: `Moved from Job "${row.name.slice(0, 80)}" — command ${generated.length + 1}`,
          language: language ?? 'bash',
          body: typeof a.command === 'string' ? a.command : '',
        });
        preApprovable = true;
      }
      const id = `a${i}_${kind}`;
      const input: Record<string, unknown> = { scriptId };
      if (type === 'run_script' && isRecord(a.parameters) && Object.keys(a.parameters).length > 0) input.parameters = a.parameters;
      if (runAs) input.runAs = runAs;
      input.whenOffline = a.whenOffline === 'skip' ? 'skip' : 'queue';
      Object.assign(input, active ? { fromStep: { stepId: active.stepId, set: chainSet } } : selector.input);
      steps.push(step({ id, tool: 'run_script_on_targets', input, timeoutSec: 3600 }));
      if (preApprovable && !isWebhook) {
        candidates.push({ stepId: id, currentTargetCount: ctx.currentTargets ? ctx.currentTargets.count : null });
      } else {
        findings.push(finding('approval_each_run', i, isWebhook ? 'webhook runs never honour pre-approval' : `actions[${i}] is not pre-approvable`));
      }
      sawScript = true;
      const fleetStepId = id;
      active = { stepId: fleetStepId, kind: 'fleet' };
      if (failureChannels.length > 0) {
        const when = `length(steps.${fleetStepId}.output.failedDeviceIds) > 0`;
        const failedId = `a${i}_failed`;
        steps.push(step({ id: failedId, tool: 'resolve_targets', input: { fromStep: { stepId: fleetStepId, set: 'failed' } }, when }));
        failureChannels.forEach((channelId, n) => {
          steps.push(step({
            id: `a${i}_failnotice_${n}`, tool: 'notify', when,
            forEach: { items: `steps.${failedId}.output.devices`, as: 'item', maxItems: FLEET_MAX_TARGETS, concurrency: 1 },
            input: { channelId, title: `${name} action failed`, message: `Automation ${name} action ${i + 1} failed on {{item.hostname}}: {{item.failureReason}}`, severity: 'warning' },
          }));
        });
        if (activeCount * failureChannels.length > FLOW_RUN_LIMITS.notifyPerRunMax) {
          findings.push(finding('failure_notice_cap', i, `${failureChannels.length} channels`));
        }
      }
      continue;
    }

    if (type === 'send_notification') {
      const channelId = str(a.notificationChannelId) ?? str(a.channelId) ?? str(a.notification_channel_id) ?? '';
      checkChannel(channelId, i, ctx, findings);
      const title = str(a.title) ?? `${name} notification`;
      const message = str(a.message) ?? `Automation ${name} executed on {{item.hostname}}`;
      if ((str(a.title) ?? '').includes('{{') || (str(a.message) ?? '').includes('{{')) {
        findings.push(finding('text_template_unsupported', i, `actions[${i}].title / message`));
      }
      const sev = str(a.severity) ?? 'info';
      const mapped = SEVERITY_TO_NOTICE[sev] ?? 'info';
      if (sev !== mapped) findings.push(finding('severity_mapped', i, `${sev} → ${mapped}`));
      notices += 1;
      const items = activeDevices(i);
      steps.push(step({
        id: `a${i}_notify`, tool: 'notify',
        forEach: { items, as: 'item', maxItems: FLEET_MAX_TARGETS, concurrency: 1 },
        input: { channelId, title: title.slice(0, 200), message: message.slice(0, 4000), severity: mapped },
      }));
      continue;
    }

    if (type === 'create_alert') {
      const sev = str(a.alertSeverity) ?? str(a.severity) ?? 'medium';
      const title = alertText(str(a.alertTitle) ?? str(a.title) ?? `${name} automation alert`);
      const message = alertText(str(a.alertMessage) ?? str(a.message) ?? '');
      if (title === null || message === null) findings.push(finding('text_template_unsupported', i, `actions[${i}].alertTitle / alertMessage`));
      const items = activeDevices(i);
      steps.push(step({
        id: `a${i}_alert`, tool: 'create_alert',
        forEach: { items, as: 'item', maxItems: FLEET_MAX_TARGETS, concurrency: 1 },
        input: { deviceId: '{{item.id}}', severity: sev, title: (title ?? name).slice(0, 200), message: (message ?? '-').slice(0, 4000) || '-' },
      }));
      continue;
    }

    if (type === 'deploy_software') {
      findings.push(finding('deploy_software_unmapped', i, `actions[${i}]`));
      continue;
    }
    // ai_triage (class A only) or anything unknown.
    findings.push(finding('managed_row', i, `actions[${i}].type ${String(type).slice(0, 32)}`));
  }
  if (sawScript) findings.push(finding('queued_is_success', null, 'a queued dispatch counts as success'));
  findings.push(finding('delegator_pause', null, 'the switching user becomes the delegator'));
  if (activeCount * notices > FLOW_RUN_LIMITS.notifyPerRunMax) {
    findings.push(finding('notify_per_run_cap', null, `${activeCount} devices × ${notices} notices`));
  }

  // ── 6. volume ────────────────────────────────────────────────────────────
  if (estimatedMonthlyRuns !== null) {
    if (estimatedMonthlyRuns > ctx.limits.monthlyRunsPerFlow) {
      findings.push(finding('monthly_cap_exceeded', null, `${estimatedMonthlyRuns} runs a month`));
    } else if (ctx.limits.ownerRunsThisMonth + estimatedMonthlyRuns > 0.8 * ctx.limits.monthlyRunsPerOwner) {
      findings.push(finding('owner_cap_pressure', null, `${estimatedMonthlyRuns} runs a month`));
    }
  }

  const description = `${row.description ? `${row.description}\n\n` : ''}Moved from Job ${row.name}`.slice(0, 2000);
  const document: FlowDocumentV1 = { version: 1, name, description, trigger, inputs: [], steps };
  return done(steps.length > 0 ? document : null, { preApprovalCandidates: candidates, generatedScripts: generated, estimatedMonthlyRuns });
}

function checkChannel(channelId: string, i: number | null, ctx: ConversionContext, findings: FlowConversionFinding[]): void {
  const where = i === null ? 'notificationTargets.channelIds' : `actions[${i}].notificationChannelId`;
  const c = ctx.channels.get(channelId);
  if (!c || !c.ownedByOwner) {
    findings.push(finding('reference_not_owned', i, where));
  } else if (!isChannelMessageType(c.type)) {
    findings.push(finding('channel_type_not_supported', i, `${where} (${c.type.slice(0, 32)})`));
  }
}

/** The legacy target, as a fleet selector. */
function selectorOf(row: AutomationRow, eventBound: boolean, findings: FlowConversionFinding[], partnerWide: boolean): Selector {
  // An event whose payload names a device binds that device (legacy: boundDeviceIds = [payload.deviceId]).
  if (eventBound) return { kind: 'trigger_device', input: { deviceIds: ['{{trigger.device.id}}'] } };
  const c = row.conditions;
  if (isRecord(c) && typeof c.type === 'string') {
    if (partnerWide && c.type === 'groups') findings.push(finding('partner_wide_group_target', null, 'conditions.type groups'));
    const target: Record<string, unknown> = { type: c.type };
    if (Array.isArray(c.deviceIds)) target.deviceIds = c.deviceIds;
    if (Array.isArray(c.groupIds)) target.groupIds = c.groupIds;
    if (c.filter !== undefined) target.filter = c.filter;
    return { kind: 'target', input: { target } };
  }
  if (Array.isArray(c)) {
    const out: Array<Record<string, unknown>> = [];
    for (const [n, raw] of c.entries()) {
      if (!isRecord(raw)) continue;
      const type = str(raw.type);
      const value = typeof raw.value === 'string' || typeof raw.value === 'number' ? String(raw.value) : '';
      // Legacy treats a condition with no type or no value as `true` — dropped (same set).
      if (!type || !value) continue;
      if (!(LEGACY_CONDITION_TYPES as readonly string[]).includes(type)) {
        findings.push(finding('condition_unknown_type', null, `conditions[${n}].type`));
        continue;
      }
      const operator = raw.operator === 'is_not' || raw.operator === 'contains' || raw.operator === 'not_contains' ? raw.operator : 'is';
      out.push({ type, operator, value: value.slice(0, 200) });
    }
    return { kind: 'conditions', input: { conditions: out } };
  }
  const t = isRecord(row.trigger) ? row.trigger : {};
  if (Array.isArray(t.deviceIds) && t.deviceIds.length > 0) {
    return { kind: 'target', input: { target: { type: 'devices', deviceIds: t.deviceIds } } };
  }
  return { kind: 'conditions', input: { conditions: [] } };
}
