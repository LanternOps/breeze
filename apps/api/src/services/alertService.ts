/**
 * Alert Service
 *
 * Core alert lifecycle management:
 * - Create alerts with deduplication and cooldown
 * - Find applicable rules for devices
 * - Auto-resolve alerts when conditions clear
 * - Interpolate template strings
 */

import { randomUUID } from 'node:crypto';
import type { MonitorKind } from '@breeze/shared';
import { db, withDbTransaction } from '../db';
import {
  alerts,
  alertRules,
  alertTemplates,
  devices,
  deviceGroups,
  deviceGroupMemberships,
  organizations,
  sites,
  monitorDefinitions,
  monitorDeviceState
} from '../db/schema';
import { eq, and, inArray, isNull, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { evaluateConditions, evaluateAutoResolveConditions, interpolateTemplate } from './alertConditions';
import { isCooldownActive, setCooldown, recordStateTransition, isFlapping } from './alertCooldown';
import { publishEvent } from './eventBus';
import { resolveDeviceSiteId } from './deviceSiteResolver';
import { enqueueAlertCorrelation } from '../jobs/alertCorrelation';
import { captureException } from './sentry';
import { resolveMonitorsForDevice } from './monitors/monitorResolver';
import { applyOverrides, getMonitorKindSpec } from './monitors/kinds';
import {
  recordMonitorEvaluation,
  detachMonitorFromDevice,
  linkEpisodeAlert,
  type MonitorObservation,
} from './monitors/episodeService';
import { fireEscalationLatch } from './monitors/escalationLatch';
import { evaluateSubjectAlerts } from './alertSubjects';

// Types for alert creation
export interface CreateAlertParams {
  ruleId: string;
  deviceId: string;
  orgId: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  message: string;
  context?: Record<string, unknown>;
  /**
   * #5289 — set when the firing rule was COMPILED from a monitor definition,
   * so the alert can link back to the monitor a technician actually authored
   * (the compiled rule is an implementation detail they never see).
   */
  monitorId?: string | null;
  kind?: MonitorKind | null;
  /** #5290 — the breach episode this alert belongs to. */
  episodeId?: string | null;
  /**
   * #5290 — recurrence escalation. A requires-human alert is NEVER
   * auto-resolved and never auto-suppressed by an AI verdict.
   */
  requiresHuman?: boolean;
  /**
   * W03 — component (subject) identity within the rule/device pair. A subject
   * alert is inserted atomically with `ON CONFLICT ... DO NOTHING`, staged for
   * outbox dispatch rather than published synchronously, and never runs the
   * device-level noise controls (cooldown/flapping) — those are subject-scoped
   * via Task 6's helpers, called above before the insert. Empty string is
   * invalid: it would collide with the NULL (legacy) identity under the
   * `COALESCE(subject_key, '')` uniqueness predicate.
   */
  subjectKey?: string;
  /**
   * W03 — lazily allocates (or adopts) the subject's episode. Called only
   * AFTER the subject wins its insert, never before — an episode must never
   * be opened for a subject that was suppressed or deduped.
   */
  allocateSubjectEpisode?: () => Promise<string>;
}

/**
 * W03 — the transactional outbox envelope staged on a subject alert's own row.
 * `alerts.context._subjectDispatch` (or `_subjectResolutionDispatch` for a
 * recovery) IS the outbox: no separate table, no in-memory callback list. Task
 * 10's drain reads it back only after the writing transaction has committed.
 */
export interface SubjectAlertDispatch {
  eventId: string;
  eventType: 'alert.triggered' | 'alert.resolved';
  publisher?: string;
  siteId: string | null | undefined;
  cooldownMinutes: number;
  payload: Record<string, unknown>;
  leaseToken?: string;
  leaseUntil?: string;
}

// Rule with template info for evaluation
export interface RuleWithTemplate {
  rule: typeof alertRules.$inferSelect;
  template: typeof alertTemplates.$inferSelect;
  effectiveConditions: unknown;
  effectiveSeverity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  effectiveCooldownMinutes: number;
  notificationChannelIds: string[];
  escalationPolicyId?: string;
  /**
   * #5290 — the monitor definition behind a compiled rule, carried through from
   * the batched read above so the episode seam needs no extra query per rule.
   * Null for an ordinary standalone rule.
   */
  monitor: typeof monitorDefinitions.$inferSelect | null;
}

/**
 * Publish `alert.triggered` for an already-inserted alert row, rolling the row
 * back if the publish fails.
 *
 * A committed `active` alert that was never published is worse than no alert at
 * all: every creator dedupes on open alerts, so the unpublished row makes them
 * skip re-creating it forever — the silent, inbox-only alert #5241 exists to
 * eliminate. Deleting it lets the next evaluation retry the whole
 * create + publish.
 *
 * @returns true when the event was published; false when the row was rolled
 *          back (the caller must not burn a cooldown or enqueue follow-up work).
 */
async function publishAlertTriggeredOrRollback(opts: {
  alertId: string;
  orgId: string;
  deviceId: string;
  /** Producing subsystem, used for the Sentry tag and log lines. */
  source: string;
  payload: Record<string, unknown>;
  publisher: string;
  siteId: string | null | undefined;
}): Promise<boolean> {
  const { alertId, orgId, deviceId, source, payload, publisher, siteId } = opts;

  try {
    await publishEvent('alert.triggered', orgId, payload, publisher, { siteId });
    return true;
  } catch (error) {
    captureException(error, undefined, {
      errorId: 'alert-triggered-publish-failed',
      alertId,
      alertSource: source,
      orgId,
      deviceId
    });
    console.error(
      `[AlertService] Failed to publish alert.triggered for ${source} alert ${alertId}; rolling the alert row back:`,
      error
    );
    try {
      await db.delete(alerts).where(eq(alerts.id, alertId));
    } catch (deleteError) {
      // Now the row IS stranded — unpublished and undeletable. Nothing else
      // will notice it, so report it under its own errorId. Note that
      // `captureException` is a no-op when Sentry is not initialised (the
      // common self-hosted shape), so on those deployments the console.error
      // below is the only durable trace — operators who want to be paged on
      // this need a log-based alert on it.
      captureException(deleteError, undefined, {
        errorId: 'alert-triggered-orphan-rollback-failed',
        alertId,
        alertSource: source,
        orgId,
        deviceId
      });
      console.error(
        `[AlertService] Could not roll back unpublished alert ${alertId}; it is stranded active with no notification:`,
        deleteError
      );
    }
    return false;
  }
}

async function monitorEventFields(monitorId: string | null | undefined, kind?: MonitorKind | null): Promise<{ monitorId: string | null; kind: MonitorKind | null }> {
  if (!monitorId) return { monitorId: null, kind: null };
  if (kind) return { monitorId, kind };
  const [definition] = await db.select({ kind: monitorDefinitions.kind })
    .from(monitorDefinitions).where(eq(monitorDefinitions.id, monitorId)).limit(1);
  return { monitorId, kind: definition?.kind ?? null };
}

/**
 * Create a new alert
 * - Checks cooldown to prevent duplicates
 * - Deduplicates against existing active alerts
 * - Publishes alert.triggered event
 *
 * @returns Created alert ID, or null if blocked by cooldown/dedupe
 */
export async function createAlert(params: CreateAlertParams): Promise<string | null> {
  const {
    ruleId, deviceId, orgId, severity, title, message, context, monitorId,
    episodeId, requiresHuman, subjectKey, allocateSubjectEpisode,
  } = params;

  if (subjectKey === '') {
    throw new Error('subjectKey must not be empty');
  }

  // Get the rule to check cooldown settings
  const [rule] = await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.id, ruleId))
    .limit(1);

  if (!rule) {
    console.warn(`[AlertService] Rule ${ruleId} not found`);
    return null;
  }

  // Get template for cooldown setting
  const [template] = await db
    .select()
    .from(alertTemplates)
    .where(eq(alertTemplates.id, rule.templateId))
    .limit(1);

  // Check override or template cooldown
  const overrides = rule.overrideSettings as Record<string, unknown> | null;
  const cooldownMinutes = (overrides?.cooldownMinutes as number) ??
    template?.cooldownMinutes ?? 5;

  // Check cooldown
  const cooldownActive = await isCooldownActive(ruleId, deviceId, subjectKey);
  if (cooldownActive) {
    console.log(`[AlertService] Cooldown active for rule=${ruleId} device=${deviceId} subject=${subjectKey ?? 'null'}`);
    return null;
  }

  // Check for existing open alert (dedupe). Skip if there's any non-resolved
  // alert for the SAME identity — active, acknowledged, or suppressed all mean
  // the user is already aware of / managing this condition. `IS NOT DISTINCT
  // FROM` treats NULL subjectKey (legacy) as its own identity, matching the
  // `COALESCE(subject_key, '')` uniqueness predicate the insert below uses.
  const [existingAlert] = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.ruleId, ruleId),
        eq(alerts.deviceId, deviceId),
        sql`${alerts.subjectKey} IS NOT DISTINCT FROM ${subjectKey ?? null}`,
        inArray(alerts.status, ['active', 'acknowledged', 'suppressed'])
      )
    )
    .limit(1);

  if (existingAlert) {
    console.log(`[AlertService] Open alert (${existingAlert.status}) already exists for rule=${ruleId} device=${deviceId} subject=${subjectKey ?? 'null'}`);
    return null;
  }

  // Phase 6a: Flapping detection — suppress if rapid state changes detected
  const flapping = await isFlapping(ruleId, deviceId, undefined, undefined, subjectKey);
  if (flapping) {
    console.log(`[AlertService] Flapping detected for rule=${ruleId} device=${deviceId} subject=${subjectKey ?? 'null'}, suppressing alert`);
    // Still set cooldown to prevent immediate re-evaluation — only for the
    // legacy (NULL-subject) path. A subject path burns no Redis writes at all
    // (see the module doc on SubjectAlertDispatch): its own noise controls
    // already ran above, and every effect from here belongs to the winning
    // insert's committed transaction, not to a suppressed evaluation.
    if (subjectKey === undefined) {
      await setCooldown(ruleId, deviceId, cooldownMinutes);
    }
    return null;
  }

  const monitorFields = await monitorEventFields(monitorId ?? rule.managedByMonitorId, params.kind);

  const insert = async (): Promise<{ id: string } | undefined> => {
    const [row] = await db.execute<{ id: string }>(sql`
      INSERT INTO alerts (rule_id, device_id, org_id, severity, title, message, context,
        monitor_id, episode_id, requires_human, subject_key, status, triggered_at)
      VALUES (${ruleId}, ${deviceId}, ${orgId}, ${severity}, ${title}, ${message},
        ${JSON.stringify(context ?? {})}::jsonb, ${monitorFields.monitorId}, ${episodeId ?? null},
        ${requiresHuman ?? false}, ${subjectKey ?? null}, 'active', now())
      ON CONFLICT (rule_id, device_id, COALESCE(subject_key, ''))
        WHERE rule_id IS NOT NULL AND status IN ('active', 'acknowledged', 'suppressed')
      DO NOTHING RETURNING id`);
    return row;
  };

  if (subjectKey !== undefined) {
    // All three writes share a savepoint AND the caller's outer commit. No
    // event or Redis write may escape before that outer transaction commits —
    // Task 10 drains `_subjectDispatch` only after the outer commit lands.
    return withDbTransaction(async () => {
      const newAlert = await insert();
      if (!newAlert) return null;
      const subjectEpisodeId = episodeId ?? (allocateSubjectEpisode ? await allocateSubjectEpisode() : null);
      const responsesOwner = subjectEpisodeId ? (await linkEpisodeAlert(subjectEpisodeId, newAlert.id)).owner : false;
      const pending: SubjectAlertDispatch = {
        eventId: newAlert.id,
        eventType: 'alert.triggered',
        siteId: await resolveDeviceSiteId(deviceId),
        cooldownMinutes,
        payload: {
          alertId: newAlert.id, ruleId, deviceId, severity, title, message,
          ...monitorFields, episodeId: subjectEpisodeId, subjectKey, responsesOwner,
        },
      };
      await db.update(alerts)
        .set({ episodeId: subjectEpisodeId, context: { ...context, _subjectDispatch: pending } })
        .where(eq(alerts.id, newAlert.id));
      return newAlert.id;
    });
  }

  const newAlert = await insert();
  if (!newAlert) {
    console.error('[AlertService] Failed to create alert');
    return null;
  }

  // Publish event — attach the device's site so site-restricted users see it.
  // The cooldown and the correlation job are deliberately set only AFTER a
  // successful publish: on a rollback the next evaluation must be free to retry
  // the whole create + publish, and nothing may point at the deleted row.
  const siteId = await resolveDeviceSiteId(deviceId);
  const published = await publishAlertTriggeredOrRollback({
    alertId: newAlert.id,
    orgId,
    deviceId,
    source: 'alert_rule',
    payload: {
      alertId: newAlert.id,
      ruleId,
      deviceId,
      severity,
      title,
      message,
      ...monitorFields,
      subjectKey: null,
      responsesOwner: true,
    },
    publisher: 'alert-service',
    siteId
  });

  if (!published) {
    return null;
  }

  await recordStateTransition(ruleId, deviceId, 'triggered');

  // Set cooldown
  await setCooldown(ruleId, deviceId, cooldownMinutes, undefined);

  enqueueAlertCorrelationForDevice(orgId, deviceId);

  console.log(`[AlertService] Created alert ${newAlert.id} for rule=${ruleId} device=${deviceId}`);

  return newAlert.id;
}

/**
 * Parameters for {@link createSourcedAlert}.
 */
export interface CreateSourcedAlertParams {
  deviceId: string;
  orgId: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  message: string;
  /**
   * Persisted to `alerts.context`. `source` names the producing subsystem and
   * is also what the caller's own dedupe query keys on.
   */
  context: Record<string, unknown> & { source: string };
  /** Event-bus publisher label, e.g. `'monitor-worker'`. */
  publisher: string;
  /** Extra fields merged into the `alert.triggered` payload. */
  eventPayload?: Record<string, unknown>;
  triggeredAt?: Date;
  /** Human label for the producing config item, e.g. `'warranty_expiry'`. */
  configItemName?: string | null;
  /**
   * Site to scope the published event to. Omit to resolve it from the device;
   * pass it explicitly (including `null`) when the caller already knows it.
   */
  siteId?: string | null;
  /**
   * #5289 — the monitor definition behind this alert, when there is one. A
   * rule-less monitor alert (the recurrence escalation) sources its delivery
   * channels and escalation policy from the monitor via this id.
   */
  monitorId?: string | null;
  kind?: MonitorKind | null;
  /** #5290 — the breach episode this alert belongs to. */
  episodeId?: string | null;
  /**
   * #5290 — recurrence escalation. NEVER auto-resolved, never auto-suppressed
   * by an AI verdict, always its own correlation root.
   */
  requiresHuman?: boolean;
}

/**
 * Create an alert that has no `alert_rules` row behind it and publish
 * `alert.triggered` for it.
 *
 * Rule-less producers (network monitors, warranty, network baseline, …) cannot
 * use {@link createAlert}: that path looks up `alertRules`/`alertTemplates` by
 * `ruleId` for its cooldown + dedupe settings and bails when the rule does not
 * exist. Inserting into `alerts` directly instead — which is what
 * `monitorWorker` did before #5241 — makes the alert visible in the inbox but
 * invisible to every `alert.triggered` consumer: no notifications, no
 * escalation, no automations, no AI verdict.
 *
 * This helper is the shared insert + publish tail. Cooldown, dedupe and
 * flap-suppression stay with the caller, whose keys are source-specific
 * (a monitor rule id, a warranty end date, …) rather than an `alertRules` id.
 *
 * @returns the new alert id, or null if the insert produced no row or the
 *          publish failed and the row was rolled back — in either case nothing
 *          was published and the caller should not burn its cooldown.
 */
export async function createSourcedAlert(params: CreateSourcedAlertParams): Promise<string | null> {
  const { deviceId, orgId, severity, title, message, context, publisher, eventPayload, triggeredAt } = params;
  const monitorFields = await monitorEventFields(params.monitorId, params.kind);

  const [newAlert] = await db
    .insert(alerts)
    .values({
      ruleId: null,
      deviceId,
      orgId,
      configItemName: params.configItemName ?? null,
      severity,
      title,
      message,
      context,
      monitorId: params.monitorId ?? null,
      episodeId: params.episodeId ?? null,
      requiresHuman: params.requiresHuman ?? false,
      status: 'active',
      triggeredAt: triggeredAt ?? new Date()
    })
    .returning({ id: alerts.id });

  const alertId = newAlert?.id;
  if (!alertId) {
    const err = new Error(
      `[AlertService] Insert returned no row for ${context.source} alert (org=${orgId} device=${deviceId}); nothing published`
    );
    console.error(err.message);
    captureException(err, undefined, { alertSource: context.source, orgId, deviceId });
    return null;
  }

  // Attach the device's site so site-restricted users see it, same as createAlert.
  const siteId = params.siteId !== undefined ? params.siteId : await resolveDeviceSiteId(deviceId);
  const published = await publishAlertTriggeredOrRollback({
    alertId,
    orgId,
    deviceId,
    source: context.source,
    payload: {
      alertId,
      ruleId: null,
      deviceId,
      severity,
      title,
      message,
      // `source` last so it is always the one persisted in context — a caller
      // cannot accidentally publish a source that disagrees with the row.
      ...eventPayload,
      ...monitorFields,
      source: context.source
    },
    publisher,
    siteId
  });

  if (!published) {
    return null;
  }

  // Only correlate an alert that actually published — a rolled-back row must
  // not leave a correlation job pointing at a deleted alert.
  enqueueAlertCorrelationForDevice(orgId, deviceId);

  return alertId;
}

/**
 * Check if an alert should be auto-resolved
 * Evaluates auto-resolve conditions and resolves if met
 *
 * @returns true if alert was auto-resolved
 */
export async function checkAutoResolve(alertId: string): Promise<boolean> {
  // Get the alert
  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert || alert.status !== 'active') {
    return false;
  }

  // W03 — a subject (component) alert reconciles through evaluateSubjectAlerts
  // under the sweep's own lock, never through this device-level path.
  if (alert.subjectKey) {
    return false;
  }

  // #5290 — a recurrence escalation is closed by a human, never by the machine.
  // Checked BEFORE any condition evaluation so the machine never even asks.
  if (alert.requiresHuman) {
    return false;
  }

  // History-only policy alerts have no rule and remain open for human review.
  if (!alert.ruleId) {
    return false;
  }

  // Get rule and template
  const [rule] = await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.id, alert.ruleId))
    .limit(1);

  if (!rule) {
    return false;
  }

  const [template] = await db
    .select()
    .from(alertTemplates)
    .where(eq(alertTemplates.id, rule.templateId))
    .limit(1);

  if (!template) {
    return false;
  }

  // Check if auto-resolve is enabled
  const overrides = rule.overrideSettings as Record<string, unknown> | null;
  const autoResolve = (overrides?.autoResolve as boolean) ?? template.autoResolve;

  if (!autoResolve) {
    return false;
  }

  // Get auto-resolve conditions (inverse conditions)
  const autoResolveConditions = (overrides?.autoResolveConditions as unknown) ??
    template.autoResolveConditions;

  if (!autoResolveConditions) {
    // If no specific auto-resolve conditions, use inverse of trigger conditions
    const triggerConditions = (overrides?.conditions as unknown) ?? template.conditions;
    const result = await evaluateConditions(triggerConditions, alert.deviceId);

    // Auto-resolve if trigger conditions are NO LONGER met.
    // Report what resolveAlert's compare-and-swap actually did: returning a bare
    // `true` here made every caller that LOST the race look like a resolver, which
    // is what inflates `checkAllAutoResolve`'s count (#4094).
    if (!result.triggered) {
      return await resolveAlert(alertId, 'Auto-resolved: conditions cleared');
    }
  } else {
    // Evaluate specific auto-resolve conditions
    const result = await evaluateAutoResolveConditions(autoResolveConditions, alert.deviceId);

    if (result.shouldResolve) {
      return await resolveAlert(alertId, `Auto-resolved: ${result.reason}`);
    }
  }

  return false;
}

/**
 * Resolve an alert
 */
/**
 * The two terminal statuses are `resolved` and `dismissed`; everything else is
 * still resolvable. Exported with the predicate builder below so tests can
 * assert the COMPILED SQL — a mocked-drizzle assertion that only checks column
 * names appear cannot tell `and` from `or`, nor catch this list gaining a
 * terminal status, and both mutations turn the CAS into a no-op or a
 * fleet-wide overwrite.
 */
export const RESOLVABLE_ALERT_STATUSES = ['active', 'acknowledged', 'suppressed'] as const;

/** The `alert_status` enum, as the column itself types it. */
type AlertStatus = (typeof alerts.$inferSelect)['status'];

/**
 * What a resolve path reports when it LOSES the compare-and-swap.
 *
 * Deliberately states only what the code can verify — that the row is no longer in
 * a resolvable status. It does NOT claim "another request resolved it": an empty
 * `RETURNING` is also what an RLS-invisible write produces, and naming the benign
 * cause in user-visible text forecloses the one hypothesis worth chasing when the
 * cause is not benign.
 */
export const ALERT_CAS_LOST_MESSAGE =
  'Alert is no longer resolvable — it already reached a terminal status (resolved or dismissed).';

/**
 * The compare-and-swap predicate for resolving ONE alert by id. See the note above.
 *
 * This is the single definition of "this alert is still resolvable" for every
 * single-alert resolve path (#4094): `resolveAlert`, both HTTP resolve routes, the
 * `manage_alerts` AI tool, and the warranty auto-resolve sweep. Building a second
 * copy inline is how the predicate and its compiled-SQL test drifted apart once
 * already.
 *
 * Two paths deliberately do NOT use this builder because they write many rows at
 * once and need `inArray(alerts.id, ...)` rather than an id equality — they compose
 * `RESOLVABLE_ALERT_STATUSES` directly instead:
 *   - the correlation-group resolve (`routes/alerts/correlations.ts`);
 *   - the bulk alert action (`routes/alerts/alerts.ts`), which is stricter still —
 *     it pins each row to the exact status its snapshot saw.
 */
export function buildResolveAlertCas(alertId: string) {
  return buildAlertStatusCas(alertId, RESOLVABLE_ALERT_STATUSES);
}

/**
 * The one status an alert can be acknowledged FROM.
 *
 * Deliberately narrower than the resolvable set and not derivable from it: every
 * acknowledge call site already refuses a non-active alert at its pre-read, and
 * re-acknowledging an acknowledged alert is not a workflow anybody asked for. What
 * the pre-read could never do is stop the write, which is the #4101 bug — see
 * `buildAcknowledgeAlertCas`.
 */
export const ACKNOWLEDGEABLE_ALERT_STATUSES = ['active'] as const;

/**
 * The statuses an alert can be suppressed FROM: everything except the two terminal
 * ones. `suppressed` is in the set on purpose — re-timing an existing mute
 * (extending or shortening it) is a legitimate operation, unlike re-acknowledging.
 *
 * Textually identical to `RESOLVABLE_ALERT_STATUSES` today, and kept a separate
 * constant anyway: the two express different invariants ("still silenceable" vs
 * "still resolvable") and must be free to diverge when a status is added. Aliasing
 * them would make a future non-terminal status silently inherit both answers.
 * `alertService.ackCasSql.test.ts` derives both from the `alert_status` enum so a
 * new value forces the classification instead of defaulting to one.
 */
export const SUPPRESSIBLE_ALERT_STATUSES = ['active', 'acknowledged', 'suppressed'] as const;

/**
 * What an acknowledge path reports when it LOSES the compare-and-swap.
 *
 * Same discipline as `ALERT_CAS_LOST_MESSAGE`: state only what the code can verify
 * (the row is no longer active), never "another request acknowledged it" — an empty
 * `RETURNING` is also what an RLS-invisible write produces, and naming the benign
 * cause in user-visible text forecloses the hypothesis worth chasing when the cause
 * is not benign.
 */
export const ALERT_ACKNOWLEDGE_CAS_LOST_MESSAGE =
  'Alert is no longer acknowledgeable — its status is no longer active.';

/** What a suppress path reports when it LOSES the compare-and-swap. */
export const ALERT_SUPPRESS_CAS_LOST_MESSAGE =
  'Alert is no longer suppressible — it already reached a terminal status (resolved or dismissed).';

/**
 * The statuses an alert can be dismissed FROM: every one except `dismissed` itself.
 *
 * The widest of the four sets, and deliberately the only one containing a TERMINAL
 * status. Dismiss is the "make this go away for good" action and is documented as
 * legal from any other status — clearing an already-`resolved` alert off the list is
 * the workflow it exists for, so excluding `resolved` here would break a supported
 * operation rather than close a race.
 *
 * `dismissed` is excluded for the opposite reason, and that exclusion is the entire
 * guard: with it in the set the predicate would match an already-dismissed row, the
 * losing caller's UPDATE would succeed, and `dismissedAt`/`dismissedBy` would be
 * re-stamped over the winner's — a CAS present in the code and absent in effect.
 */
export const DISMISSIBLE_ALERT_STATUSES = [
  'active',
  'acknowledged',
  'suppressed',
  'resolved',
] as const;

/**
 * What a dismiss path reports when it LOSES the compare-and-swap.
 *
 * Same discipline as the three above: state only what the code can verify. An empty
 * `RETURNING` here means the row is no longer dismissible, which is also what an
 * RLS-invisible or deleted row produces — so this does not claim "another request
 * dismissed it", however likely that is.
 *
 * Phrased "already reached the dismissed status" rather than "has already been
 * dismissed" for exactly that reason: the first states the eligibility fact the CAS
 * establishes, in the same shape `ALERT_CAS_LOST_MESSAGE` uses, while the second
 * reads as a claim about an actor and would quietly foreclose the RLS/deleted-row
 * hypothesis — the one worth chasing when the cause is not benign.
 */
export const ALERT_DISMISS_CAS_LOST_MESSAGE =
  'Alert is no longer dismissible — it already reached the dismissed status.';

/**
 * The compare-and-swap predicate for acknowledging ONE alert by id (#4101).
 *
 * The acknowledge handlers had the identical check-then-act shape the resolve paths
 * carried before #4094/#4099: read the status, then UPDATE by id unconditionally.
 * The damage is worse than a double-acknowledge. Tech A resolves — the resolve CAS
 * wins, `alert.resolved` publishes, the escalation is cancelled. Tech B's stale list
 * still shows the alert active and B clicks Acknowledge; B's id-only UPDATE stamps
 * `status='acknowledged'` over the resolution, leaving a reopened alert that still
 * carries `resolvedAt`/`resolvedBy` and whose escalation is already gone.
 *
 * Single definition for every single-alert acknowledge path: both HTTP routes
 * (`routes/alerts/alerts.ts`, `routes/mobile.ts`) and the `manage_alerts` AI tool.
 * The two multi-row acknowledge paths compose the status predicate directly because
 * they need `inArray(alerts.id, ...)` rather than an id equality:
 *   - the correlation-group acknowledge (`routes/alerts/correlations.ts`);
 *   - the bulk alert action (`routes/alerts/alerts.ts`), stricter still — it pins
 *     each row to the exact status its snapshot saw.
 */
export function buildAcknowledgeAlertCas(alertId: string) {
  return buildAlertStatusCas(alertId, ACKNOWLEDGEABLE_ALERT_STATUSES);
}

/**
 * The compare-and-swap predicate for suppressing ONE alert by id (#4101). Same
 * check-then-act defect and the same fix shape as `buildAcknowledgeAlertCas`; a
 * stale suppress landing on a just-resolved alert un-resolves it.
 */
export function buildSuppressAlertCas(alertId: string) {
  return buildAlertStatusCas(alertId, SUPPRESSIBLE_ALERT_STATUSES);
}

/**
 * The compare-and-swap predicate for dismissing ONE alert by id (#4293) — the last
 * single-alert transition to get one.
 *
 * What a lost race costs here is narrower than #4101 and is NOT a reopened alert:
 * because dismiss is legal from every other status, a dismiss landing on a
 * just-resolved alert is the intended outcome. The casualty is PROVENANCE. Two techs
 * dismiss the same alert; both id-only UPDATEs matched, so `dismissedAt`/`dismissedBy`
 * described whichever write landed second while BOTH callers got a 200, an ML feedback
 * emit and an audit row claiming the transition. For the terminal action, "who
 * dismissed this and when" is the field most likely to be asked about later.
 *
 * Unlike the other three transitions, dismiss has exactly ONE other write path, not
 * two: the bulk alert action. There is no correlation-group dismiss — `mutateAlerts`
 * in `routes/alerts/correlations.ts` takes only `'acknowledge' | 'resolve'`. Bulk
 * composes its predicate directly because it needs `inArray(alerts.id, ...)`, and it
 * pins each row to the exact status its snapshot saw, which is stricter than this set
 * but correct there — bulk reports a `skipped` count rather than an error, so a
 * concurrent change costs the caller a retry hint, not a refused operation.
 */
export function buildDismissAlertCas(alertId: string) {
  return buildAlertStatusCas(alertId, DISMISSIBLE_ALERT_STATUSES);
}

/**
 * The one place the CAS SHAPE lives. The four builders above differ only in which
 * statuses they admit; funnelling them through here means a change to the shape
 * (`and` → `or`, dropping the id equality) cannot land on one transition and miss
 * the other three — which is exactly how a predicate and its compiled-SQL test have
 * drifted apart in this file before.
 */
function buildAlertStatusCas(alertId: string, statuses: readonly AlertStatus[]) {
  return and(
    eq(alerts.id, alertId),
    inArray(alerts.status, [...statuses]),
  );
}

export async function resolveAlert(
  alertId: string,
  resolutionNote?: string,
  resolvedBy?: string,
  deferSubjectEffects = false,
): Promise<boolean> {
  // Winner-takes-all. The status predicate IS the concurrency control: reading
  // the row first and then updating by id unconditionally lets two callers
  // both "resolve" the same alert and both run the fan-out below — the state
  // transition, the cooldown write, and an `alert.resolved` publish that
  // cancels escalations and feeds the AI triage loop guard.
  //
  // Two callers is not hypothetical: policy.compliant redelivery, the
  // auto-resolve sweep and monitorWorker can all reach the same alert, and
  // wave 3.5c makes event delivery at-least-once.
  //
  // RETURNING replaces the previous SELECT. Note it returns the POST-update
  // row: safe only because nothing below reads a column this SET writes
  // (status / resolvedAt / resolvedBy / resolutionNote). Adding such a read
  // later would silently observe the new value.
  const [alert] = await db
    .update(alerts)
    .set({
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: resolvedBy ?? null,
      resolutionNote: resolutionNote ?? null
    })
    .where(buildResolveAlertCas(alertId))
    .returning();

  // Already resolved by someone else (or gone). Not an error — just not ours.
  if (!alert) return false;

  // W03 — a subject recovery under the locked sweep commits its resolution and
  // pending `alert.resolved` event TOGETHER (in the SAME outer transaction as
  // the caller's other subject writes) and does no Redis write or publication
  // here. `deferSubjectEffects` defaults to false so every OTHER caller —
  // manual resolution, checkAutoResolve, the config-policy sweep — keeps
  // today's synchronous behaviour unchanged; only Tasks 9 and 12 opt in.
  if (deferSubjectEffects && alert.subjectKey) {
    const [rule] = alert.ruleId
      ? await db.select().from(alertRules).where(eq(alertRules.id, alert.ruleId)).limit(1)
      : [];
    const [template] = rule
      ? await db.select().from(alertTemplates).where(eq(alertTemplates.id, rule.templateId)).limit(1)
      : [];
    const overrides = rule?.overrideSettings as Record<string, unknown> | null;
    const pending: SubjectAlertDispatch = {
      eventId: randomUUID(),
      eventType: 'alert.resolved',
      siteId: await resolveDeviceSiteId(alert.deviceId),
      cooldownMinutes: (overrides?.cooldownMinutes as number) ?? template?.cooldownMinutes ?? 15,
      payload: {
        alertId, ruleId: alert.ruleId, deviceId: alert.deviceId, subjectKey: alert.subjectKey, resolutionNote,
        resolvedAt: alert.resolvedAt!.toISOString(), resolvedBy: alert.resolvedBy,
        triggeredAt: alert.triggeredAt.toISOString(),
      },
    };
    await db.update(alerts).set({
      context: sql`jsonb_set(
    COALESCE(${alerts.context}, '{}'::jsonb) - '_subjectDispatch', '{_subjectResolutionDispatch}', ${JSON.stringify(pending)}::jsonb)`,
    }).where(eq(alerts.id, alertId));
    return true;
  }

  // Phase 6a: Record resolution state transition for flapping detection
  try {
    if (alert.ruleId) {
      await recordStateTransition(alert.ruleId, alert.deviceId, 'resolved', alert.subjectKey ?? undefined);

    }
  } catch (error) {
    console.error(`[AlertService] Failed to record state transition for resolved alert:`, error instanceof Error ? error.message : error);
  }

  // Set a cooldown after resolution to prevent immediate re-trigger.
  // Uses the rule's configured cooldown so the condition must persist
  // beyond the cooldown window before a new alert is created.
  // Retired policy alerts are history-only and need no cooldown.
  if (alert.ruleId) {
    // Legacy standalone alert rule
    const [rule] = await db
      .select()
      .from(alertRules)
      .where(eq(alertRules.id, alert.ruleId))
      .limit(1);

    if (rule) {
      const [template] = await db
        .select()
        .from(alertTemplates)
        .where(eq(alertTemplates.id, rule.templateId))
        .limit(1);

      const overrides = rule.overrideSettings as Record<string, unknown> | null;
      const cooldownMinutes = (overrides?.cooldownMinutes as number) ??
        template?.cooldownMinutes ?? 15;
      await setCooldown(alert.ruleId, alert.deviceId, cooldownMinutes, alert.subjectKey ?? undefined);
    }
  }

  // Publish event — attach the device's site so site-restricted users see it.
  //
  // C2 fix: resolvedAt/resolvedBy/triggeredAt ride on the payload so a
  // subscriber never has to re-read this row to learn the resolve state —
  // a re-read on a fresh connection can observe this transaction's write
  // before it commits (the auto-resolve sweep and monitorWorker both call
  // this function from inside one `withSystemDbAccessContext` transaction
  // spanning the whole sweep). See `alertVerdictSubscriber.ts`'s contract
  // comment. Values come from `alert`, the RETURNING row this same UPDATE
  // just produced — never a second read.
  const siteId = await resolveDeviceSiteId(alert.deviceId);
  await publishEvent(
    'alert.resolved',
    alert.orgId,
    {
      alertId,
      ruleId: alert.ruleId,
      deviceId: alert.deviceId,
      resolutionNote,
      resolvedAt: alert.resolvedAt!.toISOString(),
      resolvedBy: alert.resolvedBy,
      triggeredAt: alert.triggeredAt.toISOString(),
    },
    'alert-service',
    { siteId }
  );

  console.log(`[AlertService] Resolved alert ${alertId}`);
  return true;
}

/**
 * Rule-ownership condition for EVALUATION (#2128): a device is governed by the
 * standalone rules owned by its OWN org, plus the partner-wide rules (org_id
 * NULL) owned by that org's partner. Exported for the offline detector, which
 * runs the same standalone-rule sweep.
 */
export async function alertRuleOwnershipConditionForOrg(orgId: string): Promise<SQL> {
  const [ownerOrg] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const partnerId = ownerOrg?.partnerId ?? null;
  if (!partnerId) {
    // Orphaned org (no partner): only its own rules apply.
    return eq(alertRules.orgId, orgId) as unknown as SQL;
  }
  return sql`(${alertRules.orgId} = ${orgId} OR (${alertRules.orgId} IS NULL AND ${alertRules.partnerId} = ${partnerId}))`;
}

export async function getApplicableRules(deviceId: string): Promise<RuleWithTemplate[]> {
  // Get device info
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return [];
  }

  // Get device's group memberships
  const groupMemberships = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));

  const groupIds = groupMemberships.map(g => g.groupId);

  // Build conditions for rule matching
  const targetConditions = [
    eq(alertRules.targetType, 'all'),
    and(eq(alertRules.targetType, 'org'), eq(alertRules.targetId, device.orgId)),
    and(eq(alertRules.targetType, 'site'), eq(alertRules.targetId, device.siteId)),
    and(eq(alertRules.targetType, 'device'), eq(alertRules.targetId, deviceId))
  ];

  // Add group conditions if device is in any groups
  if (groupIds.length > 0) {
    targetConditions.push(
      and(eq(alertRules.targetType, 'group'), inArray(alertRules.targetId, groupIds))
    );
  }

  // #5289 — the 'monitor' target type. A compiled monitor rule reaches a device
  // only through configuration-policy attachment, never by org/site/group
  // targeting, so the resolver is the authority on which ones apply. A monitor
  // the resolution says is DISABLED for this device contributes no rule at all.
  // `device_missing` (the device raced a delete between the check above and
  // here) contributes no monitor-target rules either — same as a genuine zero,
  // since this function already returned [] earlier if the device never
  // existed for the `device` lookup above (#5677).
  const monitorResolution = await resolveMonitorsForDevice(deviceId);
  const effectiveMonitors = monitorResolution.kind === 'resolved' ? monitorResolution.monitors : [];
  const enabledMonitorIds = effectiveMonitors.filter((m) => m.enabled).map((m) => m.monitorId);
  if (enabledMonitorIds.length > 0) {
    targetConditions.push(
      and(eq(alertRules.targetType, 'monitor'), inArray(alertRules.targetId, enabledMonitorIds))
    );
  }

  // Get all active rules that apply to this device: the device org's own
  // rules plus its partner's partner-wide rules (#2128).
  const ownershipCondition = await alertRuleOwnershipConditionForOrg(device.orgId);
  const rules = await db
    .select()
    .from(alertRules)
    .where(
      and(
        ownershipCondition,
        eq(alertRules.isActive, true),
        isNull(alertRules.retiredAt),
        or(...targetConditions)
      )
    );

  if (rules.length === 0) {
    return [];
  }

  // Get templates for all rules
  const templateIds = [...new Set(rules.map(r => r.templateId))];
  const templates = await db
    .select()
    .from(alertTemplates)
    .where(inArray(alertTemplates.id, templateIds));

  const templateMap = new Map(templates.map(t => [t.id, t]));

  // Per-device monitor overrides (threshold tweaks, severity) come from the
  // winning ATTACHMENT, so two devices can run the same monitor at different
  // thresholds. One batched read for the managed rules in this call.
  const managedMonitorIds = [...new Set(rules.map(r => r.managedByMonitorId).filter((id): id is string => !!id))];
  const monitorDefinitionsById = new Map<string, typeof monitorDefinitions.$inferSelect>();
  if (managedMonitorIds.length > 0) {
    const defs = await db
      .select()
      .from(monitorDefinitions)
      .where(inArray(monitorDefinitions.id, managedMonitorIds));
    for (const def of defs) monitorDefinitionsById.set(def.id, def);
  }

  // Build rule-with-template objects
  const result: RuleWithTemplate[] = [];

  for (const rule of rules) {
    const template = templateMap.get(rule.templateId);
    if (!template) continue;

    const overrides = rule.overrideSettings as Record<string, unknown> | null;

    let effectiveConditions: unknown = (overrides?.conditions as unknown) ?? template.conditions;
    let effectiveSeverity =
      (overrides?.severity as 'critical' | 'high' | 'medium' | 'low' | 'info') ?? template.severity;

    if (rule.managedByMonitorId) {
      const effective = effectiveMonitors.find((m) => m.monitorId === rule.managedByMonitorId);
      const def = monitorDefinitionsById.get(rule.managedByMonitorId);
      if (effective?.overrides && def) {
        try {
          const spec = getMonitorKindSpec(def.kind);
          const base = spec.conditionSchema.parse(def.condition);
          effectiveConditions = spec.toAlertCondition(applyOverrides(spec, base, effective.overrides), { monitorId: def.id });
          effectiveSeverity =
            (effective.overrides.severity as typeof effectiveSeverity | undefined) ?? effectiveSeverity;
        } catch (error) {
          // A per-attachment override that no longer validates (the monitor's
          // kind changed under it) must NOT silently disable the monitor —
          // fall back to the compiled, un-overridden condition and say so.
          //
          // Reported to Sentry as well as the log: this is invisible to the
          // technician who set the override (it still saves fine; only
          // evaluation rejects it), so a console line nobody reads would leave
          // a device evaluating a different threshold than the UI shows,
          // indefinitely.
          console.error(
            `[AlertService] Ignoring invalid monitor override for monitor=${rule.managedByMonitorId} device=${deviceId}:`,
            error
          );
          captureException(error, undefined, {
            area: 'monitors',
            issue: 'invalid_monitor_override',
            monitorId: rule.managedByMonitorId,
            deviceId,
          });
        }
      }
    }

    result.push({
      rule,
      template,
      effectiveConditions,
      effectiveSeverity,
      effectiveCooldownMinutes: (overrides?.cooldownMinutes as number) ?? template.cooldownMinutes,
      notificationChannelIds: (overrides?.notificationChannelIds as string[]) ?? [],
      escalationPolicyId: overrides?.escalationPolicyId as string | undefined,
      monitor: rule.managedByMonitorId
        ? monitorDefinitionsById.get(rule.managedByMonitorId) ?? null
        : null
    });
  }

  return result;
}

/**
 * Which rules one `evaluateDeviceAlerts` pass is responsible for (#6353).
 *
 * `device_sweep` is the per-device alert worker job: every rule EXCEPT
 * `network_check` monitors, which have no per-device verdict (one probe per
 * org, read back off `network_monitor_results`) and would otherwise raise one
 * alert per online device the policy reaches.
 *
 * `network_check` is the device-independent sweep
 * (`services/monitors/networkCheckAlertSweep.ts`): ONLY the `network_check`
 * monitors in `monitorIds` — the checks this device is the resolved alert
 * device for — evaluated whether or not the device is online.
 */
type DeviceEvaluationMode =
  | { kind: 'device_sweep' }
  | { kind: 'network_check'; monitorIds: ReadonlySet<string> };

/**
 * Evaluate all rules for a device and create alerts as needed
 * Returns list of created alert IDs
 */
export async function evaluateDeviceAlerts(deviceId: string): Promise<string[]> {
  return evaluateDeviceAlertsInMode(deviceId, { kind: 'device_sweep' });
}

/**
 * #6353 — evaluate the `network_check` monitors in `monitorIds` for the device
 * the sweep resolved as their alert device. Same pipeline as the per-device
 * sweep (episode seam, cooldown, flapping, dedupe per rule+device) so the alert
 * is indistinguishable from any other monitor alert; only the rule selection
 * and the detach scan differ. The device may be OFFLINE — that is the point.
 */
export async function evaluateNetworkCheckAlertsForDevice(
  deviceId: string,
  monitorIds: ReadonlySet<string>,
): Promise<string[]> {
  if (monitorIds.size === 0) return [];
  return evaluateDeviceAlertsInMode(deviceId, { kind: 'network_check', monitorIds });
}

async function evaluateDeviceAlertsInMode(deviceId: string, mode: DeviceEvaluationMode): Promise<string[]> {
  const applicableRules = await getApplicableRules(deviceId);

  if (applicableRules.length === 0) {
    return [];
  }

  // Get device info for template interpolation
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return [];
  }

  const createdAlerts: string[] = [];
  // #5290 — every monitor the sweep actually evaluated for this device. Any
  // monitor_device_state row NOT in this set has stopped resolving to the
  // device (attachment removed, policy unassigned, attachment disabled), which
  // closes its open episode as `monitor_detached` after the loop.
  const evaluatedMonitorIds = new Set<string>();

  for (const { rule, template, effectiveConditions, effectiveSeverity, effectiveCooldownMinutes, monitor } of applicableRules) {
    // #6353 — a network_check has ONE verdict per org, evaluated by the
    // device-independent sweep on the check's alert device. The per-device
    // sweep skips it (but still counts it as evaluated, or the detach scan
    // below would close the alert device's open episode every minute); the
    // network_check sweep evaluates nothing else, and only the checks this
    // device was resolved as the alert device for.
    const isNetworkCheck = monitor?.kind === 'network_check';
    if (mode.kind === 'device_sweep') {
      if (isNetworkCheck) {
        if (rule.managedByMonitorId) evaluatedMonitorIds.add(rule.managedByMonitorId);
        continue;
      }
    } else if (!isNetworkCheck || !rule.managedByMonitorId || !mode.monitorIds.has(rule.managedByMonitorId)) {
      continue;
    }

    try {
      // Evaluate conditions
      const result = await evaluateConditions(effectiveConditions, deviceId);

      // W03 Task 10 — a hardware/RAID leaf reports per-COMPONENT evidence
      // instead of one device-level verdict. Its whole reconciliation
      // (create/recover, episode allocation/adoption, the final observation)
      // runs inside one savepoint under an advisory lock so concurrent sweeps
      // cannot close an episode between another sweep's creation and its
      // ownership claim — and, critically, so nothing it does (publish,
      // Redis write, correlation enqueue) can escape before the CALLER's
      // outer transaction commits. Task 10's outbox drains the staged
      // envelope only after that commit. This branch never falls through to
      // the legacy NULL-subject block below.
      if (result.subjects !== undefined) {
        if (rule.managedByMonitorId) evaluatedMonitorIds.add(rule.managedByMonitorId);
        const subjectAlertIds: string[] = [];
        await withDbTransaction(async () => {
          await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hardware-subject:${rule.id}:${deviceId}`}, 0))`);
          const evidence = await evaluateConditions(effectiveConditions, deviceId);
          if (evidence.subjects === undefined) {
            throw new Error('Subject evidence disappeared during evaluation');
          }
          const observation = await evaluateSubjectAlerts({
            rule: {
              ...rule,
              overrideSettings: {
                ...(rule.overrideSettings as Record<string, unknown> | null),
                severity: effectiveSeverity,
                cooldownMinutes: effectiveCooldownMinutes,
              },
            },
            template, device, monitor, evidence: { ...evidence, createdAlertIds: subjectAlertIds },
          });
          if (monitor) {
            await recordMonitorEvaluation({ monitor, deviceId, orgId: device.orgId, observation });
          }
        });
        createdAlerts.push(...subjectAlertIds);
        continue;
      }

      // #5290 — the episode seam sits HERE, after the evaluation and BEFORE
      // createAlert, on purpose:
      //   * cooldown and flapping (both inside createAlert) gate the ALERT but
      //     never the episode — noise controls cannot hide a loop;
      //   * the escalation latch and its pause are durable before createAlert
      //     publishes `alert.triggered`, so the compiled response automation
      //     can never be queued between the latch and the pause;
      //   * a non-triggering evaluation, which today does nothing at all, now
      //     closes the open episode.
      let episodeId: string | null = null;
      if (rule.managedByMonitorId && monitor) {
        evaluatedMonitorIds.add(rule.managedByMonitorId);
        try {
          const observation: MonitorObservation = result.triggered
            ? 'breach'
            : result.dataState === 'unknown'
              ? 'unknown'
              : 'ok';
          const outcome = await recordMonitorEvaluation({
            monitor,
            deviceId,
            // ALWAYS the DEVICE's org (#5290): a partner-wide monitor has no
            // org of its own and its episodes are org-scoped.
            orgId: device.orgId,
            observation,
          });
          episodeId = outcome.episodeId;
          // `needsEscalationAlert` retries an alert that the latch failed to
          // raise earlier — the pause is already durable, so without the retry
          // the device's responses stay held with nothing telling a human why.
          if ((outcome.latched || outcome.needsEscalationAlert) && outcome.episodeId) {
            await fireEscalationLatch({
              monitor,
              deviceId,
              orgId: device.orgId,
              episodeId: outcome.episodeId,
              episodesInWindow: outcome.episodesInWindow,
            });
          }
        } catch (error) {
          // Episode bookkeeping must never cost the device its alert.
          console.error(
            `[AlertService] Episode bookkeeping failed for monitor=${rule.managedByMonitorId} device=${deviceId}:`,
            error
          );
          captureException(error, undefined, {
            area: 'monitors',
            issue: 'episode_record_failed',
            monitorId: rule.managedByMonitorId,
            deviceId,
          });
        }
      }

      if (result.triggered) {
        // Build template context
        const templateContext: Record<string, unknown> = {
          deviceName: device.displayName || device.hostname,
          hostname: device.hostname,
          osType: device.osType,
          osVersion: device.osVersion,
          ruleName: rule.name,
          severity: effectiveSeverity,
          ...result.context
        };

        // Interpolate title and message
        const title = interpolateTemplate(template.titleTemplate, templateContext);
        const message = interpolateTemplate(template.messageTemplate, templateContext);

        // Create alert — ALWAYS in the DEVICE's org (alerts.org_id NOT NULL):
        // a partner-wide rule (#2128) has no org of its own, and for org-owned
        // rules device.orgId is identical to rule.orgId by the ownership match
        // above. Notifications then route via the firing org's own channels.
        const alertId = await createAlert({
          ruleId: rule.id,
          deviceId,
          orgId: device.orgId,
          severity: effectiveSeverity,
          title,
          message,
          // #5289 — provenance, so the alert links to the authored monitor
          // rather than to the compiled rule the technician never sees.
          monitorId: rule.managedByMonitorId ?? null,
          kind: monitor?.kind ?? null,
          episodeId,
          context: {
            ...result.context,
            conditionsMet: result.conditionsMet,
            conditionsNotMet: result.conditionsNotMet,
            templateId: template.id,
            cooldownMinutes: effectiveCooldownMinutes
          }
        });

        if (alertId) {
          createdAlerts.push(alertId);
          if (episodeId) {
            await linkEpisodeAlert(episodeId, alertId).catch((error) => {
              console.error(
                `[AlertService] Failed to link alert ${alertId} to episode ${episodeId}:`,
                error
              );
              // Reported as well as logged: a run of these silently degrades the
              // episode → alert traceability the Activity tab is built on, and
              // nothing else would ever notice the pattern.
              captureException(error, undefined, {
                area: 'monitors',
                issue: 'episode_alert_link_failed',
                episodeId,
                alertId,
              });
            });
          }
        }
      }
    } catch (error) {
      console.error(`[AlertService] Error evaluating rule ${rule.id} for device ${deviceId}:`, error);
      // Also the only guard around the hardware subject transaction (W03):
      // report it, or a recurring failure silently stops hardware alerts.
      captureException(error, undefined, {
        errorId: 'alert-rule-evaluation-failed',
        ruleId: rule.id,
        deviceId,
      });
    }
  }

  // Only the per-device sweep saw every monitor that resolves to this device;
  // the network_check pass saw a subset and must not detach the rest.
  if (mode.kind === 'device_sweep') {
    await detachUnresolvedMonitors(deviceId, evaluatedMonitorIds);
  }

  return createdAlerts;
}

/**
 * #5290 — close the open episode of every monitor that still has state for this
 * device but no longer resolves to it. One indexed read per sweep
 * (`monitor_device_state_device_idx`).
 */
async function detachUnresolvedMonitors(
  deviceId: string,
  evaluatedMonitorIds: Set<string>
): Promise<void> {
  try {
    const open = await db
      .select({ monitorId: monitorDeviceState.monitorId })
      .from(monitorDeviceState)
      .where(
        and(
          eq(monitorDeviceState.deviceId, deviceId),
          isNotNull(monitorDeviceState.currentEpisodeId)
        )
      );

    for (const row of open) {
      if (evaluatedMonitorIds.has(row.monitorId)) continue;
      await detachMonitorFromDevice(row.monitorId, deviceId);
    }
  } catch (error) {
    console.error(`[AlertService] Failed to detach stale monitor episodes for device ${deviceId}:`, error);
    captureException(error, undefined, {
      area: 'monitors',
      issue: 'episode_detach_failed',
      deviceId,
    });
  }
}

/**
 * Check all active alerts for auto-resolution
 * Returns count of resolved alerts
 */
export async function checkAllAutoResolve(orgId?: string): Promise<number> {
  // Get active alerts (optionally filtered by org)
  // #5290 — a requires-human alert is never auto-resolved, so it is excluded in
  // the SELECT rather than skipped per-row: the sweep must not even load it.
  const conditions = [eq(alerts.status, 'active'), eq(alerts.requiresHuman, false)];
  if (orgId) {
    conditions.push(eq(alerts.orgId, orgId));
  }

  const activeAlerts = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(...conditions));

  let resolvedCount = 0;

  for (const alert of activeAlerts) {
    try {
      const resolved = await checkAutoResolve(alert.id);
      if (resolved) {
        resolvedCount++;
      }
    } catch (error) {
      console.error(`[AlertService] Error checking auto-resolve for alert ${alert.id}:`, error);
    }
  }

  return resolvedCount;
}

function enqueueAlertCorrelationForDevice(orgId: string, deviceId: string): void {
  void enqueueAlertCorrelation({ orgId, deviceId }).catch((error) => {
    console.error(
      `[AlertService] Failed to enqueue alert correlation for org=${orgId} device=${deviceId}:`,
      error
    );
  });
}

/**
 * Get alert statistics for an organization
 */
export async function getAlertStats(orgId: string): Promise<{
  active: number;
  acknowledged: number;
  resolved: number;
  suppressed: number;
  bySeverity: Record<string, number>;
}> {
  const allAlerts = await db
    .select({
      status: alerts.status,
      severity: alerts.severity
    })
    .from(alerts)
    .where(eq(alerts.orgId, orgId));

  const stats = {
    active: 0,
    acknowledged: 0,
    resolved: 0,
    suppressed: 0,
    bySeverity: {} as Record<string, number>
  };

  for (const alert of allAlerts) {
    // Count by status
    if (alert.status === 'active') stats.active++;
    else if (alert.status === 'acknowledged') stats.acknowledged++;
    else if (alert.status === 'resolved') stats.resolved++;
    else if (alert.status === 'suppressed') stats.suppressed++;

    // Count by severity (only for active/acknowledged)
    if (alert.status === 'active' || alert.status === 'acknowledged') {
      stats.bySeverity[alert.severity] = (stats.bySeverity[alert.severity] || 0) + 1;
    }
  }

  return stats;
}
