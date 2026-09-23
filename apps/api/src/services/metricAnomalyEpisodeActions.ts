import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { EpisodeAction } from '@breeze/shared';

import { db } from '../db';
import { alerts, metricAnomalies, metricAnomalyEpisodes } from '../db/schema';
import { resolveAlert } from './alertService';
import { EPISODE_SNOOZE_DAYS } from './metricAnomalyEpisodes';
import { promoteMetricAnomalyToAlert } from './metricAnomalyPromotion';
import { emitAlertStateFeedback, emitAnomalyEpisodeFeedback, emitAnomalyEpisodeMemberFeedback } from './mlFeedbackEmitters';

/**
 * Human actions on a metric anomaly episode (spec §8). Runs on the AMBIENT
 * request transaction (authMiddleware's withDbAccessContext). Never opens a
 * second context. resolveAlert / promoteMetricAnomalyToAlert join this
 * transaction because a nested withDbAccessContext returns fn() directly.
 *
 * Invariants:
 *  - The episode row is locked (SELECT … FOR UPDATE) before the precondition
 *    check, so two clicks and the auto-resolve stage serialize on it.
 *  - Member cascades touch ONLY status = 'open' rows (§8.2).
 *  - Member feedback is written by a throwing writer, so a lost label rolls
 *    the whole action back (spec deviation D-7).
 *  - The anomaly episode id is written to alerts.context.episodeId only.
 *    alerts.episode_id is the monitor breach episode (#5290).
 */

type EpisodeRow = typeof metricAnomalyEpisodes.$inferSelect;
type LabelledMember = { id: string; metricName: string; anomalyType: string };

export type EpisodeActionConflict =
  | 'episode_closed'
  | 'already_promoted'
  | 'not_snoozed'
  | 'no_promotable_member'
  | 'promotion_disabled';

export const EPISODE_ACTION_CONFLICT_MESSAGES: Record<EpisodeActionConflict, string> = {
  episode_closed: 'This anomaly has already closed',
  already_promoted: 'This anomaly is already linked to an alert',
  not_snoozed: 'This anomaly is not snoozed',
  no_promotable_member: 'This anomaly has no open detection left to promote',
  promotion_disabled: 'Anomaly alert promotion is disabled',
};

export const DEFAULT_EPISODE_RESOLVE_NOTE = 'Resolved with its anomaly episode';
export const DEFAULT_EPISODE_DISMISS_NOTE = 'Resolved: anomaly episode dismissed';
const DAY_MS = 86_400_000;

export function decideEpisodeAction(
  episode: { status: string; linkedAlertId: string | null; snoozedUntil: Date | null },
  action: EpisodeAction,
  now: Date,
): { ok: true } | { ok: false; reason: 'episode_closed' | 'already_promoted' | 'not_snoozed' } {
  if (action === 'unsnooze') {
    return episode.status === 'dismissed'
      && episode.snoozedUntil !== null
      && episode.snoozedUntil.getTime() > now.getTime()
      ? { ok: true }
      : { ok: false, reason: 'not_snoozed' };
  }
  if (episode.status !== 'open') return { ok: false, reason: 'episode_closed' };
  if (action === 'promote' && episode.linkedAlertId) return { ok: false, reason: 'already_promoted' };
  return { ok: true };
}

export interface ApplyEpisodeActionInput {
  orgId: string;
  deviceId: string;
  episodeId: string;
  action: EpisodeAction;
  note?: string;
  /** Only meaningful for `resolve` or `dismiss` on a promoted episode. Default true (§8.2, A7). */
  resolveAlert?: boolean;
  actorUserId: string;
  now?: Date;
}

export type ApplyEpisodeActionResult =
  | { status: 'not_found' }
  | { status: 'conflict'; reason: EpisodeActionConflict; message: string }
  | {
      status: 'ok';
      episodeId: string;
      action: EpisodeAction;
      alertId: string | null;
      alertResolved: boolean;
      labelledMemberIds: string[];
      feedbackInserted: number;
    };

function conflict(reason: EpisodeActionConflict): ApplyEpisodeActionResult {
  return { status: 'conflict', reason, message: EPISODE_ACTION_CONFLICT_MESSAGES[reason] };
}

async function lockEpisode(input: ApplyEpisodeActionInput): Promise<EpisodeRow | undefined> {
  const [row] = await db
    .select()
    .from(metricAnomalyEpisodes)
    .where(and(
      eq(metricAnomalyEpisodes.id, input.episodeId),
      eq(metricAnomalyEpisodes.orgId, input.orgId),
      eq(metricAnomalyEpisodes.deviceId, input.deviceId),
    ))
    .limit(1)
    .for('update');
  return row;
}

function episodeWhere(episode: EpisodeRow) {
  return and(eq(metricAnomalyEpisodes.id, episode.id), eq(metricAnomalyEpisodes.orgId, episode.orgId));
}

function memberWhere(episode: EpisodeRow) {
  return and(eq(metricAnomalies.orgId, episode.orgId), eq(metricAnomalies.episodeId, episode.id));
}

async function cascadeOpenMembers(
  episode: EpisodeRow,
  status: 'resolved' | 'dismissed' | 'promoted',
  now: Date,
  linkedAlertId?: string,
): Promise<LabelledMember[]> {
  return db
    .update(metricAnomalies)
    .set({
      status,
      resolvedAt: status === 'resolved' ? now : null,
      updatedAt: now,
      ...(linkedAlertId ? { linkedAlertId } : {}),
    })
    .where(and(memberWhere(episode), eq(metricAnomalies.status, 'open')))
    .returning({ id: metricAnomalies.id, metricName: metricAnomalies.metricName, anomalyType: metricAnomalies.anomalyType });
}

async function labelMembers(
  episode: EpisodeRow,
  outcome: 'dismissed' | 'promoted' | 'resolved',
  members: LabelledMember[],
  input: ApplyEpisodeActionInput,
  now: Date,
  extra: Record<string, unknown> = {},
): Promise<number> {
  if (members.length === 0) return 0;
  return emitAnomalyEpisodeMemberFeedback({
    orgId: episode.orgId,
    episodeId: episode.id,
    members,
    outcome,
    actorUserId: input.actorUserId,
    occurredAt: now,
    metadata: { route: 'devices.anomalyEpisodes.action', note: input.note, ...extra },
  });
}

function ok(
  episode: EpisodeRow,
  input: ApplyEpisodeActionInput,
  fields: { alertId: string | null; alertResolved: boolean; members: LabelledMember[]; feedbackInserted: number },
): ApplyEpisodeActionResult {
  return {
    status: 'ok',
    episodeId: episode.id,
    action: input.action,
    alertId: fields.alertId,
    alertResolved: fields.alertResolved,
    labelledMemberIds: fields.members.map((m) => m.id),
    feedbackInserted: fields.feedbackInserted,
  };
}

async function resolveEpisode(episode: EpisodeRow, input: ApplyEpisodeActionInput, now: Date): Promise<ApplyEpisodeActionResult> {
  await db
    .update(metricAnomalyEpisodes)
    .set({
      status: 'resolved',
      closeReason: 'user',
      resolvedAt: now,
      resolvedByUserId: input.actorUserId,
      note: input.note ?? episode.note,
      updatedAt: now,
    })
    .where(episodeWhere(episode));
  const members = await cascadeOpenMembers(episode, 'resolved', now);
  const feedbackInserted = await labelMembers(episode, 'resolved', members, input, now);
  // W03 (spec §8.3): one episode-level label, same transaction, same throwing
  // writer as the member rows (W02 D-7).
  await emitAnomalyEpisodeFeedback({
    orgId: episode.orgId,
    episodeId: episode.id,
    eventType: 'anomaly_episode.resolved',
    outcome: 'resolved',
    actorUserId: input.actorUserId,
    occurredAt: now,
    metadata: { route: 'devices.anomalyEpisodes.action', note: input.note, memberCount: members.length },
  });
  const alertResolved = await resolveLinkedAlert(episode, input, now, DEFAULT_EPISODE_RESOLVE_NOTE);
  return ok(episode, input, { alertId: episode.linkedAlertId ?? null, alertResolved, members, feedbackInserted });
}

/**
 * Resolve / dismiss of a PROMOTED episode also resolves its linked alert,
 * unless the caller passed resolveAlert: false (§8.2; A7 extended it to
 * dismiss). Joins the ambient request transaction; resolveAlert is a CAS, so
 * an alert a human already resolved returns false and nothing else happens.
 */
async function resolveLinkedAlert(
  episode: EpisodeRow,
  input: ApplyEpisodeActionInput,
  now: Date,
  defaultNote: string,
): Promise<boolean> {
  if (input.resolveAlert === false || !episode.linkedAlertId) return false;
  const resolved = await resolveAlert(episode.linkedAlertId, input.note ?? defaultNote, input.actorUserId);
  if (resolved) {
    await emitAlertStateFeedback({
      orgId: episode.orgId,
      alertId: episode.linkedAlertId,
      eventType: 'alert.resolved',
      outcome: 'resolved',
      actorUserId: input.actorUserId,
      occurredAt: now,
      metadata: { source: 'devices.anomalyEpisodes', episodeId: episode.id, action: input.action },
    });
  }
  return resolved;
}

async function dismissEpisode(episode: EpisodeRow, input: ApplyEpisodeActionInput, now: Date): Promise<ApplyEpisodeActionResult> {
  await db
    .update(metricAnomalyEpisodes)
    .set({
      status: 'dismissed',
      closeReason: 'user',
      resolvedAt: now,
      resolvedByUserId: input.actorUserId,
      snoozedUntil: new Date(now.getTime() + EPISODE_SNOOZE_DAYS * DAY_MS),
      note: input.note ?? episode.note,
      updatedAt: now,
    })
    .where(episodeWhere(episode));
  const members = await cascadeOpenMembers(episode, 'dismissed', now);
  const feedbackInserted = await labelMembers(episode, 'dismissed', members, input, now);
  // W03 (spec §8.3): one episode-level label, same transaction, same throwing
  // writer as the member rows (W02 D-7).
  await emitAnomalyEpisodeFeedback({
    orgId: episode.orgId,
    episodeId: episode.id,
    eventType: 'anomaly_episode.dismissed',
    outcome: 'dismissed',
    actorUserId: input.actorUserId,
    occurredAt: now,
    metadata: { route: 'devices.anomalyEpisodes.action', note: input.note, memberCount: members.length },
  });
  // A7: dismissing a promoted episode resolves its alert by default, exactly
  // like resolve — a tech who silences the signal is done with it; pass
  // resolveAlert: false to keep the alert for the alert workflow.
  const alertResolved = await resolveLinkedAlert(episode, input, now, DEFAULT_EPISODE_DISMISS_NOTE);
  return ok(episode, input, { alertId: episode.linkedAlertId ?? null, alertResolved, members, feedbackInserted });
}

async function stampEpisodeOnAlertContext(alertId: string, episode: EpisodeRow): Promise<void> {
  await db
    .update(alerts)
    .set({ context: sql`coalesce(${alerts.context}, '{}'::jsonb) || jsonb_build_object('episodeId', ${episode.id}::text)` })
    .where(and(
      eq(alerts.id, alertId),
      eq(alerts.orgId, episode.orgId),
      sql`NOT (coalesce(${alerts.context}, '{}'::jsonb) ? 'episodeId')`,
    ));
}

async function promoteEpisode(episode: EpisodeRow, input: ApplyEpisodeActionInput, now: Date): Promise<ApplyEpisodeActionResult> {
  // Snapshot BEFORE promotion: the service promotes the peak and its
  // same-window siblings itself, so they would be missing from the cascade's
  // RETURNING (spec deviation D-5).
  const openBefore = await db
    .select({ id: metricAnomalies.id })
    .from(metricAnomalies)
    .where(and(memberWhere(episode), eq(metricAnomalies.status, 'open')));

  // Never overwrite a label a human set through the per-row route.
  const [peak] = await db
    .select({ id: metricAnomalies.id })
    .from(metricAnomalies)
    .where(and(memberWhere(episode), inArray(metricAnomalies.status, ['open', 'promoted'])))
    .orderBy(desc(metricAnomalies.score), asc(metricAnomalies.id))
    .limit(1);
  if (!peak) return conflict('no_promotable_member');

  const promotion = await promoteMetricAnomalyToAlert({
    orgId: episode.orgId,
    deviceId: episode.deviceId,
    anomalyId: peak.id,
    actorUserId: input.actorUserId,
    requireCreateAlertsFlag: false,
    episodeId: episode.id,
  });
  if (promotion.status === 'not_found') return { status: 'not_found' };
  if (promotion.status === 'disabled') return conflict('promotion_disabled');
  if (!promotion.created) await stampEpisodeOnAlertContext(promotion.alertId, episode);

  await db
    .update(metricAnomalyEpisodes)
    .set({ linkedAlertId: promotion.alertId, note: input.note ?? episode.note, updatedAt: now })
    .where(episodeWhere(episode));
  const cascaded = await cascadeOpenMembers(episode, 'promoted', now, promotion.alertId);

  const candidateIds = [...new Set([...openBefore.map((m) => m.id), ...cascaded.map((m) => m.id)])];
  const labelled: LabelledMember[] = candidateIds.length === 0 ? [] : await db
    .select({ id: metricAnomalies.id, metricName: metricAnomalies.metricName, anomalyType: metricAnomalies.anomalyType })
    .from(metricAnomalies)
    .where(and(memberWhere(episode), eq(metricAnomalies.status, 'promoted'), inArray(metricAnomalies.id, candidateIds)));
  const feedbackInserted = await labelMembers(episode, 'promoted', labelled, input, now, {
    linkedAlertId: promotion.alertId,
    createdAlert: promotion.created,
  });
  return ok(episode, input, { alertId: promotion.alertId, alertResolved: false, members: labelled, feedbackInserted });
}

async function unsnoozeEpisode(episode: EpisodeRow, input: ApplyEpisodeActionInput, now: Date): Promise<ApplyEpisodeActionResult> {
  // Spec deviation D-4: assembly consults the MOST RECENT dismissed episode
  // for the key, and snoozed successors copy snoozed_until — so clear them all.
  await db
    .update(metricAnomalyEpisodes)
    .set({ snoozedUntil: null, updatedAt: now })
    .where(and(
      eq(metricAnomalyEpisodes.orgId, episode.orgId),
      eq(metricAnomalyEpisodes.deviceId, episode.deviceId),
      eq(metricAnomalyEpisodes.episodeKey, episode.episodeKey),
      eq(metricAnomalyEpisodes.status, 'dismissed'),
      gt(metricAnomalyEpisodes.snoozedUntil, now),
    ));
  return ok(episode, input, { alertId: episode.linkedAlertId ?? null, alertResolved: false, members: [], feedbackInserted: 0 });
}

export async function applyEpisodeAction(input: ApplyEpisodeActionInput): Promise<ApplyEpisodeActionResult> {
  const now = input.now ?? new Date();
  const episode = await lockEpisode(input);
  if (!episode) return { status: 'not_found' };

  const decision = decideEpisodeAction(episode, input.action, now);
  if (!decision.ok) return conflict(decision.reason);

  switch (input.action) {
    case 'resolve':
      return resolveEpisode(episode, input, now);
    case 'dismiss':
      return dismissEpisode(episode, input, now);
    case 'promote':
      return promoteEpisode(episode, input, now);
    case 'unsnooze':
      return unsnoozeEpisode(episode, input, now);
  }
}
