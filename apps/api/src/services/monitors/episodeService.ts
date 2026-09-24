/**
 * Monitor breach episodes and the recurrence latch (#5287 W03 / #5290).
 *
 * One (monitor, device) pair has exactly one `monitor_device_state` row and at
 * most one OPEN `monitor_episodes` row. `recordMonitorEvaluation` is the single
 * writer of that pair's operational state.
 *
 * Legacy monitors record their observation before alert creation. Hardware
 * subjects allocate only after an alert passes noise admission and wins its
 * insert; allocation writes no observation. The sweep records one final
 * observation from admitted open alerts, then activates recurrence and pause.
 *
 * State changes serialize under SELECT FOR UPDATE on monitor_device_state.
 * Episode insertion uses ON CONFLICT DO NOTHING against the one-open-episode
 * index; an existing allocation is read back without aborting the transaction.
 * Only the final breach observation activates an allocated subject episode.
 *
 * `org_id` is ALWAYS the device's org, never the monitor definition's: a
 * partner-wide monitor produces org-scoped episodes.
 */

import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { monitorDeviceState, monitorEpisodes } from '../../db/schema';
import type { MonitorDefinitionRow } from '../../db/schema';
import type { MonitorResponseOutcome } from '../../db/schema/monitorEpisodes';

export type MonitorObservation = 'breach' | 'ok' | 'unknown';

export type MonitorForEvaluation = Pick<
  MonitorDefinitionRow,
  'id' | 'recurrenceThreshold' | 'recurrenceWindowHours' | 'pauseResponsesOnEscalation'
>;

export interface RecordEvaluationInput {
  monitor: MonitorForEvaluation;
  deviceId: string;
  /** The DEVICE's org, always (#5290). */
  orgId: string;
  observation: MonitorObservation;
  /** Injectable for tests. */
  now?: Date;
}

export interface RecordEvaluationResult {
  /** The open episode after this observation, null when the pair is healthy. */
  episodeId: string | null;
  /** True only on the sweep that opened this episode. */
  episodeOpened: boolean;
  /** True only on the sweep that closed one. */
  episodeClosed: boolean;
  /** Episodes counted inside the recurrence window, after pruning by age. */
  episodesInWindow: number;
  /** True only on the sweep that latched escalation (never on a re-latch). */
  latched: boolean;
  /**
   * The pair IS escalated but has no `escalation_alert_id` — the requires-human
   * alert was never created (a transient failure in `fireEscalationLatch`, whose
   * error is deliberately swallowed so it cannot cost the device its ordinary
   * alert). The sweep retries the alert on this signal; without it the responses
   * stay paused forever with nothing telling a technician why.
   */
  needsEscalationAlert: boolean;
  responsesPaused: boolean;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * W03 — allocate (or adopt) a subject's episode WITHOUT recording an
 * observation. Called only after a subject alert passes noise admission and
 * wins its insert (Task 8's `createAlert`, under the outer transaction Task
 * 10 opens), never speculatively — a rollback of that outer transaction
 * removes both the new alert row and this allocation together.
 *
 * Uses the SAME state lock and open-episode index as `recordMonitorEvaluation`
 * but changes neither `lastState`, the recurrence window counter, nor the
 * pause latch: only the sweep's FINAL admitted breach observation (via
 * `recordMonitorEvaluation`) adopts an allocated episode and runs that
 * calculation, exactly once per sweep.
 */
export async function allocateSubjectEpisode(
  input: Pick<RecordEvaluationInput, 'monitor' | 'deviceId' | 'orgId' | 'now'>,
): Promise<string> {
  return db.transaction(async (tx) => {
    await tx
      .insert(monitorDeviceState)
      .values({
        monitorId: input.monitor.id,
        deviceId: input.deviceId,
        orgId: input.orgId,
      })
      .onConflictDoNothing({
        target: [monitorDeviceState.monitorId, monitorDeviceState.deviceId],
      });

    await tx
      .select()
      .from(monitorDeviceState)
      .where(
        and(
          eq(monitorDeviceState.monitorId, input.monitor.id),
          eq(monitorDeviceState.deviceId, input.deviceId),
        ),
      )
      .for('update');

    const [created] = await tx
      .insert(monitorEpisodes)
      .values({
        monitorId: input.monitor.id,
        deviceId: input.deviceId,
        orgId: input.orgId,
        startedAt: input.now ?? new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: monitorEpisodes.id });
    if (created) return created.id;

    const [open] = await tx
      .select({ id: monitorEpisodes.id })
      .from(monitorEpisodes)
      .where(
        and(
          eq(monitorEpisodes.monitorId, input.monitor.id),
          eq(monitorEpisodes.deviceId, input.deviceId),
          isNull(monitorEpisodes.endedAt),
        ),
      )
      .limit(1);
    if (!open) throw new Error('Subject episode allocation lost its open episode');
    return open.id;
  });
}

export async function recordMonitorEvaluation(
  input: RecordEvaluationInput,
): Promise<RecordEvaluationResult> {
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    // Upsert first so the lock below always has a row to take.
    await tx
      .insert(monitorDeviceState)
      .values({
        monitorId: input.monitor.id,
        deviceId: input.deviceId,
        orgId: input.orgId,
      })
      .onConflictDoNothing({
        target: [monitorDeviceState.monitorId, monitorDeviceState.deviceId],
      });

    const [state] = await tx
      .select()
      .from(monitorDeviceState)
      .where(
        and(
          eq(monitorDeviceState.monitorId, input.monitor.id),
          eq(monitorDeviceState.deviceId, input.deviceId),
        ),
      )
      .for('update');

    const current = state ?? {
      currentEpisodeId: null as string | null,
      episodesInWindow: 0,
      escalatedAt: null as Date | null,
      escalationAlertId: null as string | null,
      resetAt: null as Date | null,
      responsesPaused: false,
    };

    const openEpisodeId: string | null = current.currentEpisodeId ?? null;

    // ---- unknown: observe only. Never opens, never closes. ----
    if (input.observation === 'unknown') {
      await tx
        .update(monitorDeviceState)
        .set({ lastEvaluatedAt: now, lastState: 'unknown', updatedAt: now })
        .where(
          and(
            eq(monitorDeviceState.monitorId, input.monitor.id),
            eq(monitorDeviceState.deviceId, input.deviceId),
          ),
        );
      return {
        episodeId: openEpisodeId,
        episodeOpened: false,
        episodeClosed: false,
        episodesInWindow: current.episodesInWindow ?? 0,
        latched: false,
        // Always false on the non-breach branches: the caller can only fire the
        // latch with an episode id, and `unknown` means we could not observe the
        // device at all. The next breach sweep carries the retry.
        needsEscalationAlert: false,
        responsesPaused: current.responsesPaused ?? false,
      };
    }

    // ---- ok ----
    if (input.observation === 'ok') {
      if (openEpisodeId) {
        await tx
          .update(monitorEpisodes)
          .set({ endedAt: now, endReason: 'recovered', updatedAt: now })
          .where(and(eq(monitorEpisodes.id, openEpisodeId), isNull(monitorEpisodes.endedAt)));
      }
      await tx
        .update(monitorDeviceState)
        .set({
          currentEpisodeId: null,
          lastEvaluatedAt: now,
          lastState: 'ok',
          updatedAt: now,
        })
        .where(
          and(
            eq(monitorDeviceState.monitorId, input.monitor.id),
            eq(monitorDeviceState.deviceId, input.deviceId),
          ),
        );
      return {
        episodeId: null,
        episodeOpened: false,
        episodeClosed: Boolean(openEpisodeId),
        // The window counter is NOT decremented: episodes leave the window by
        // age, not by recovery.
        episodesInWindow: current.episodesInWindow ?? 0,
        latched: false,
        needsEscalationAlert: false,
        responsesPaused: current.responsesPaused ?? false,
      };
    }

    // ---- breach with an episode already open: a continuous breach is ONE
    // episode however many sweeps see it. ----
    if (openEpisodeId) {
      await tx
        .update(monitorDeviceState)
        .set({ lastEvaluatedAt: now, lastState: 'breach', updatedAt: now })
        .where(
          and(
            eq(monitorDeviceState.monitorId, input.monitor.id),
            eq(monitorDeviceState.deviceId, input.deviceId),
          ),
        );
      return {
        episodeId: openEpisodeId,
        episodeOpened: false,
        episodeClosed: false,
        episodesInWindow: current.episodesInWindow ?? 0,
        latched: false,
        // The latch fires as an episode OPENS, so a just-latched pair sits on
        // THIS branch from the very next sweep onward. Reporting false here
        // would make the retry wait for a recover + re-breach, and a device
        // stuck in continuous breach would never get its requires-human alert.
        needsEscalationAlert: Boolean(current.escalatedAt) && !current.escalationAlertId,
        responsesPaused: current.responsesPaused ?? false,
      };
    }

    // ---- breach, no open episode: open one (or adopt an allocation, or a
    // concurrent sweep's episode — all via ON CONFLICT DO NOTHING against the
    // one-open-episode index, never a caught 23505). ----
    const [inserted] = await tx
      .insert(monitorEpisodes)
      .values({
        monitorId: input.monitor.id,
        deviceId: input.deviceId,
        orgId: input.orgId,
        startedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: monitorEpisodes.id });
    let episodeId: string | null = inserted?.id ?? null;
    if (!episodeId) {
      const [existing] = await tx
        .select({ id: monitorEpisodes.id })
        .from(monitorEpisodes)
        .where(
          and(
            eq(monitorEpisodes.monitorId, input.monitor.id),
            eq(monitorEpisodes.deviceId, input.deviceId),
            isNull(monitorEpisodes.endedAt),
          ),
        )
        .limit(1);
      episodeId = existing?.id ?? null;
    }
    if (!episodeId) throw new Error('Admitted breach has no open episode');
    const episodeOpened = Boolean(inserted);

    const threshold = input.monitor.recurrenceThreshold;
    const windowHours = input.monitor.recurrenceWindowHours;
    const counterOn = threshold !== null && threshold !== undefined && !!windowHours;

    let episodesInWindow = 0;
    let windowStartedAt: Date | null = null;

    if (counterOn) {
      // The window is FLOORED at the last human reset. Without this floor the
      // recompute would still see every pre-reset episode, so the very next
      // breach would re-latch and the reset would be useless — exactly what
      // `resetMonitorEscalation` promises not to happen.
      const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
      const resetAt = current.resetAt ? new Date(current.resetAt) : null;
      const cutoff = resetAt && resetAt > windowStart ? resetAt : windowStart;
      // A recomputed count, not an incremented counter, so a pruned window and
      // a replayed sweep agree.
      const rows = await tx
        .select({ startedAt: monitorEpisodes.startedAt })
        .from(monitorEpisodes)
        .where(
          and(
            eq(monitorEpisodes.monitorId, input.monitor.id),
            eq(monitorEpisodes.deviceId, input.deviceId),
            gte(monitorEpisodes.startedAt, cutoff),
          ),
        );
      episodesInWindow = rows.length;
      windowStartedAt = rows.reduce<Date | null>((oldest, row) => {
        const started = row.startedAt instanceof Date ? row.startedAt : new Date(row.startedAt);
        return !oldest || started < oldest ? started : oldest;
      }, null);
    }

    const alreadyEscalated = Boolean(current.escalatedAt);
    const latched =
      counterOn && !alreadyEscalated && episodesInWindow >= (threshold as number);
    // Already latched, but its requires-human alert never landed: ask the sweep
    // to retry the alert without touching the (correct) state.
    const needsEscalationAlert = alreadyEscalated && !current.escalationAlertId;
    const responsesPaused = latched
      ? Boolean(input.monitor.pauseResponsesOnEscalation)
      : (current.responsesPaused ?? false);

    const update: Record<string, unknown> = {
      currentEpisodeId: episodeId,
      episodesInWindow,
      windowStartedAt,
      lastEvaluatedAt: now,
      lastState: 'breach',
      updatedAt: now,
    };
    if (latched) {
      update.escalatedAt = now;
      update.responsesPaused = responsesPaused;
    }

    await tx
      .update(monitorDeviceState)
      .set(update)
      .where(
        and(
          eq(monitorDeviceState.monitorId, input.monitor.id),
          eq(monitorDeviceState.deviceId, input.deviceId),
        ),
      );

    return {
      episodeId,
      episodeOpened,
      episodeClosed: false,
      episodesInWindow,
      latched,
      needsEscalationAlert,
      responsesPaused,
    };
  });
}

/**
 * Close any open episode because the monitor no longer resolves to this device
 * (attachment removed, policy unassigned, attachment disabled). NOT for
 * definition deletion, which cascades.
 */
export async function detachMonitorFromDevice(
  monitorId: string,
  deviceId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const closed = await tx
      .update(monitorEpisodes)
      .set({ endedAt: now, endReason: 'monitor_detached', updatedAt: now })
      .where(
        and(
          eq(monitorEpisodes.monitorId, monitorId),
          eq(monitorEpisodes.deviceId, deviceId),
          isNull(monitorEpisodes.endedAt),
        ),
      )
      .returning({ id: monitorEpisodes.id });

    if (closed.length === 0) return;

    await tx
      .update(monitorDeviceState)
      .set({ currentEpisodeId: null, updatedAt: now })
      .where(
        and(
          eq(monitorDeviceState.monitorId, monitorId),
          eq(monitorDeviceState.deviceId, deviceId),
        ),
      );
  });
}

/**
 * Stamp the alert that represents this breach onto its episode, atomically.
 * The `alertId is null` guard makes this claim a compare-and-swap: only the
 * first caller to reach an episode still carrying no alert wins ownership of
 * the episode's automation responses (W03 — two subjects racing to open the
 * same episode must produce exactly one response run).
 */
export async function linkEpisodeAlert(episodeId: string, alertId: string): Promise<{ owner: boolean }> {
  const claimed = await db
    .update(monitorEpisodes)
    .set({ alertId, updatedAt: new Date() })
    .where(and(eq(monitorEpisodes.id, episodeId), isNull(monitorEpisodes.alertId)))
    .returning({ id: monitorEpisodes.id });
  return { owner: claimed.length === 1 };
}

export interface RecordEpisodeResponseInput {
  monitorId: string;
  deviceId: string;
  runId?: string | null;
  outcome: MonitorResponseOutcome;
}

/**
 * Write the response outcome onto the OPEN episode for the pair. No-op when no
 * episode is open.
 *
 * A `queued` write never walks a terminal outcome backwards: a BullMQ retry of
 * the trigger must not overwrite `completed`/`failed` with `queued`.
 */
export async function recordEpisodeResponse(
  input: RecordEpisodeResponseInput,
): Promise<void> {
  const set: Record<string, unknown> = {
    responseOutcome: input.outcome,
    updatedAt: new Date(),
  };
  if (input.runId) set.responseRunId = input.runId;

  const conditions = [
    eq(monitorEpisodes.monitorId, input.monitorId),
    eq(monitorEpisodes.deviceId, input.deviceId),
    isNull(monitorEpisodes.endedAt),
  ];
  if (input.outcome === 'queued') {
    conditions.push(
      sql`(${monitorEpisodes.responseOutcome} IS NULL OR ${monitorEpisodes.responseOutcome} = 'queued')`,
    );
  }

  await db.update(monitorEpisodes).set(set).where(and(...conditions));
}

export type { Tx };
