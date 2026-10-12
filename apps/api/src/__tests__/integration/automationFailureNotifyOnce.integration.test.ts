/**
 * #7188 — an automation's on-failure notification is sent once per failed
 * action, including across a BullMQ stalled-job replay, against real
 * PostgreSQL.
 *
 * #3189 made a replay never re-send the notification for a failure an earlier
 * attempt recorded, so a worker that died between recording the failure and
 * sending the alert lost it. The runtime now claims the send with a CAS on
 * `automation_action_results.failure_notified_at`:
 *
 *  - concurrent claims on one failed action: exactly one wins;
 *  - a replay of a run whose first attempt recorded the failure but died
 *    before notifying sends the alert, and further (concurrent) replays send
 *    nothing more.
 *
 * Tenants, devices and the webhook channel are synthetic; the webhook sender
 * is mocked, so nothing leaves the process.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import {
  automationActionResults,
  automationRuns,
  automations,
  devices,
  notificationChannelConfigs,
  notificationChannels,
} from '../../db/schema';
import {
  claimAutomationFailureNotification,
  seedAutomationActionResults,
} from '../../services/automationActionResults';
import { db, withSystemDbAccessContext } from '../../db';
import {
  type AutomationAction,
  executeAutomationRun,
  replaceAutomationResourceBindings,
  resolveAutomationReferencesForOwner,
} from '../../services/automationRuntime';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const { publishEventMock, sendWebhookNotificationMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn().mockResolvedValue('event-id'),
  sendWebhookNotificationMock: vi.fn(),
}));
vi.mock('../../services/eventBus', () => ({ publishEvent: publishEventMock }));
vi.mock('../../services/notificationSenders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/notificationSenders')>();
  return { ...actual, sendWebhookNotification: sendWebhookNotificationMock };
});

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function fixture() {
  const adminDb = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const [device] = await adminDb.insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId: `notify-once-${randomUUID()}`,
    hostname: 'notify-once',
    osType: 'linux' as const,
    osVersion: 'test',
    architecture: 'amd64',
    agentVersion: 'test',
    status: 'online' as const,
  }).returning({ id: devices.id });
  const [channel] = await adminDb.insert(notificationChannels).values({
    orgId: org.id,
    partnerId: null,
    name: 'On-failure webhook',
    type: 'webhook',
  }).returning({ id: notificationChannels.id });
  await adminDb.insert(notificationChannelConfigs).values({
    channelId: channel!.id,
    config: { url: 'https://hooks.example.invalid/automation', method: 'POST' },
  });
  const [automation] = await adminDb.insert(automations).values({
    orgId: org.id,
    partnerId: null,
    name: `Notify once ${randomUUID()}`,
    trigger: { type: 'manual' },
    conditions: { type: 'devices', deviceIds: [device!.id] },
    actions: [
      { type: 'execute_command', command: 'synthetic-notify-first' },
      { type: 'execute_command', command: 'synthetic-notify-second' },
    ],
    onFailure: 'notify',
    notificationTargets: { channelIds: [channel!.id] },
  }).returning();
  // Inserted directly, so perform the reference admission + durable binding
  // replacement the create route would.
  const axes = { orgId: org.id, partnerId: null };
  await withSystemDbAccessContext(() => db.transaction(async (tx) => {
    const resolved = await resolveAutomationReferencesForOwner(
      tx,
      axes,
      automation!.actions as AutomationAction[],
      automation!.notificationTargets ?? undefined,
    );
    await replaceAutomationResourceBindings(tx, automation!.id, axes, resolved);
  }));
  const [run] = await adminDb.insert(automationRuns).values({
    automationId: automation!.id,
    triggeredBy: 'notify-once-integration',
    status: 'running',
    devicesTargeted: 1,
  }).returning();
  await seedAutomationActionResults({
    runId: run!.id,
    device: { id: device!.id, orgId: org.id },
    actions: [
      { actionIndex: 0, actionType: 'execute_command' },
      { actionIndex: 1, actionType: 'execute_command' },
    ],
  });
  return { runId: run!.id, deviceId: device!.id };
}

/** The first attempt recorded action 0 as failed, then died before notifying. */
async function failFirstActionWithoutNotifying(runId: string, deviceId: string) {
  await getTestDb().update(automationActionResults)
    .set({ status: 'failed', message: 'Synthetic dispatch failure', completedAt: new Date() })
    .where(and(
      eq(automationActionResults.runId, runId),
      eq(automationActionResults.deviceId, deviceId),
      eq(automationActionResults.actionIndex, 0),
    ));
}

async function notifiedAt(runId: string, deviceId: string, actionIndex: number) {
  const [row] = await getTestDb()
    .select({ failureNotifiedAt: automationActionResults.failureNotifiedAt })
    .from(automationActionResults)
    .where(and(
      eq(automationActionResults.runId, runId),
      eq(automationActionResults.deviceId, deviceId),
      eq(automationActionResults.actionIndex, actionIndex),
    ));
  return row?.failureNotifiedAt ?? null;
}

describe('automation on-failure notification is sent once — real PostgreSQL (#7188)', () => {
  runDb('concurrent claims on one failed action: exactly one wins', async () => {
    const f = await fixture();
    await failFirstActionWithoutNotifying(f.runId, f.deviceId);

    const results = await Promise.all(Array.from({ length: 8 }, () => claimAutomationFailureNotification({
      runId: f.runId,
      deviceId: f.deviceId,
      actionIndex: 0,
    })));

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await notifiedAt(f.runId, f.deviceId, 0)).not.toBeNull();
    expect(await claimAutomationFailureNotification({
      runId: f.runId,
      deviceId: f.deviceId,
      actionIndex: 0,
    })).toBe(false);
    // The claim is per action row: the device's other action is untouched.
    expect(await notifiedAt(f.runId, f.deviceId, 1)).toBeNull();
  });

  runDb('a replay sends the alert a crashed first attempt never sent, and later replays send nothing', async () => {
    sendWebhookNotificationMock.mockReset();
    sendWebhookNotificationMock.mockResolvedValue({ success: true });
    const f = await fixture();
    await failFirstActionWithoutNotifying(f.runId, f.deviceId);
    expect(await notifiedAt(f.runId, f.deviceId, 0)).toBeNull();

    // Stalled-job recovery: two replays of the same execute-run job at once.
    await Promise.all([
      executeAutomationRun(f.runId, [f.deviceId]),
      executeAutomationRun(f.runId, [f.deviceId]),
    ]);

    expect(sendWebhookNotificationMock).toHaveBeenCalledTimes(1);
    expect(await notifiedAt(f.runId, f.deviceId, 0)).not.toBeNull();

    // A further replay finds the notification claimed and sends nothing.
    await executeAutomationRun(f.runId, [f.deviceId]);
    expect(sendWebhookNotificationMock).toHaveBeenCalledTimes(1);
  });
});
