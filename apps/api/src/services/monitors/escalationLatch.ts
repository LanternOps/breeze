/**
 * Side effects of the recurrence escalation latch (#5287 W03 / #5290).
 *
 * **Ordering (deliberate deviation from the spec's literal wording, same safety
 * property).** The spec says the latch and the pause are set "in the same
 * transaction as the episode insert, so a response cannot slip through between
 * them". `episodeService.recordMonitorEvaluation` does exactly that for the
 * STATE: `escalated_at` and `responses_paused` are written under the state row's
 * `FOR UPDATE` lock, before this function is called at all. The requires-human
 * alert is created AFTER that transaction commits, because `createSourcedAlert`
 * publishes an event with rollback-on-publish-failure semantics that must not
 * nest inside another transaction. The safety property is preserved: the pause
 * is durable before any alert is published, so the compiled response automation
 * can never be queued between the latch and the pause.
 *
 * **Known gap — recurrence actions are NOT executed here (tracked as #5767).**
 * `monitor_definitions.recurrence_actions` has no execution path in this wave.
 * Running an arbitrary action list requires an `automation_runs` row, whose
 * `automation_id` is a real FK, and the executor re-reads the action list from
 * the `automations` row rather than accepting it in memory — so a run cannot
 * carry ad-hoc actions. The monitor's own compiled automation cannot be reused
 * either: it holds the RESPONSE actions and is exactly what the latch pauses,
 * and `automations_managed_by_monitor_uidx` forbids a second managed row per
 * monitor. Rather than invent a mechanism, authored-but-unrun actions are
 * surfaced on the escalation alert as `recurrenceActionsPending` so a
 * technician sees them, and the execution path is filed as #5767.
 */

import { eq, and } from 'drizzle-orm';
import { db } from '../../db';
import { devices, monitorDeviceState } from '../../db/schema';
import type { MonitorDefinitionRow } from '../../db/schema';
import { createSourcedAlert } from '../alertService';
import { captureException } from '../sentry';

export type AlertSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

const SEVERITY_LADDER: readonly AlertSeverity[] = ['info', 'low', 'medium', 'high', 'critical'];

/**
 * One step up the ladder, with a floor of `high`: a condition that has recurred
 * past its threshold is never a low-priority item, whatever the monitor's own
 * severity says.
 */
export function escalationSeverityFor(base: AlertSeverity): AlertSeverity {
  const index = SEVERITY_LADDER.indexOf(base);
  const bumped = SEVERITY_LADDER[Math.min((index < 0 ? 0 : index) + 1, SEVERITY_LADDER.length - 1)]!;
  return SEVERITY_LADDER.indexOf(bumped) >= SEVERITY_LADDER.indexOf('high') ? bumped : 'high';
}

export type MonitorForEscalation = Pick<
  MonitorDefinitionRow,
  'id' | 'name' | 'severity' | 'recurrenceThreshold' | 'recurrenceWindowHours' | 'recurrenceActions'
>;

export interface FireEscalationLatchInput {
  monitor: MonitorForEscalation;
  deviceId: string;
  /** The DEVICE's org, always. */
  orgId: string;
  episodeId: string;
  episodesInWindow: number;
}

function windowPhrase(windowHours: number | null): string {
  if (!windowHours) return 'the recurrence window';
  if (windowHours < 24) {
    return `${windowHours} ${windowHours === 1 ? 'hour' : 'hours'}`;
  }
  const days = Math.round(windowHours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

export async function fireEscalationLatch(
  input: FireEscalationLatchInput,
): Promise<{ escalationAlertId: string | null; recurrenceActionsPending: number }> {
  const { monitor, deviceId, orgId, episodeId, episodesInWindow } = input;
  const recurrenceActions = Array.isArray(monitor.recurrenceActions)
    ? monitor.recurrenceActions
    : [];
  const recurrenceActionsPending = recurrenceActions.length;

  try {
    const [device] = await db
      .select({ displayName: devices.displayName, hostname: devices.hostname })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    const deviceName = device?.displayName || device?.hostname || deviceId;

    const occurrences = `${episodesInWindow} ${episodesInWindow === 1 ? 'time' : 'times'}`;
    const title = `${monitor.name} recurred ${occurrences} in ${windowPhrase(monitor.recurrenceWindowHours)} on ${deviceName}`;

    const escalationAlertId = await createSourcedAlert({
      deviceId,
      orgId,
      severity: escalationSeverityFor(monitor.severity as AlertSeverity),
      title,
      message:
        `${monitor.name} has opened ${occurrences} on ${deviceName} within `
        + `${windowPhrase(monitor.recurrenceWindowHours)}. Automatic responses for this device are `
        + 'held until a human resets the escalation.',
      context: {
        source: 'monitor_recurrence',
        monitorId: monitor.id,
        episodeId,
        episodesInWindow,
        recurrenceThreshold: monitor.recurrenceThreshold,
        recurrenceWindowHours: monitor.recurrenceWindowHours,
        // Authored recurrence actions that this wave does not execute — see the
        // module header. Surfaced so a technician can run them by hand.
        recurrenceActionsPending,
      },
      publisher: 'monitor-escalation',
      eventPayload: { monitorId: monitor.id, episodeId, requiresHuman: true },
      monitorId: monitor.id,
      episodeId,
      requiresHuman: true,
    });

    if (escalationAlertId) {
      // Its own catch: the alert EXISTS now, so a failed write-back must not be
      // reported as "no alert was raised" — the next sweep would then see
      // escalation_alert_id still null and raise a second one.
      try {
        await db
          .update(monitorDeviceState)
          .set({ escalationAlertId, updatedAt: new Date() })
          .where(
            and(
              eq(monitorDeviceState.monitorId, monitor.id),
              eq(monitorDeviceState.deviceId, deviceId),
            ),
          );
      } catch (error) {
        captureException(error, undefined, {
          errorId: 'monitor-escalation-alert-link-failed',
          monitorId: monitor.id,
          deviceId,
          escalationAlertId,
        });
        console.error(
          `[EscalationLatch] Raised alert ${escalationAlertId} but could not stamp it on monitor_device_state for monitor ${monitor.id} device ${deviceId}; the next sweep may raise a duplicate:`,
          error,
        );
      }
    }

    return { escalationAlertId, recurrenceActionsPending };
  } catch (error) {
    // The latch itself is already durable in monitor_device_state. A failure to
    // raise its alert must not propagate into the sweep and abort the remaining
    // rules for this device.
    captureException(error, undefined, {
      errorId: 'monitor-escalation-latch-failed',
      monitorId: monitor.id,
      deviceId,
      orgId,
    });
    console.error(
      `[EscalationLatch] Failed to raise the requires-human alert for monitor ${monitor.id} device ${deviceId}:`,
      error,
    );
    return { escalationAlertId: null, recurrenceActionsPending };
  }
}
