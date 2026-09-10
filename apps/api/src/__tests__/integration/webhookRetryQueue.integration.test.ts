import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { alerts, alertNotifications, devices, notificationChannels } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const { calls } = vi.hoisted(() => ({ calls: [] as { path: string; time: number }[] }));
// Only provider I/O and unrelated in-app fan-out are synthetic. Sender,
// dispatcher, SQL state transitions, production enqueue options and BullMQ
// delayed/failed states all execute unchanged against the owned local lab.
vi.mock('../../services/urlSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/urlSafety')>();
  return { ...actual, safeFetch: vi.fn(async (url: string) => {
    const parsed = new URL(url);
    if (parsed.hostname !== 'example.com') throw new Error('Unexpected synthetic destination');
    calls.push({ path: parsed.pathname, time: Date.now() });
    const status = parsed.pathname === '/retry' ? 503 : parsed.pathname === '/terminal' ? 400 : 200;
    return new Response('synthetic response', { status });
  }) };
});
vi.mock('../../services/notificationSenders/inAppSender', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/notificationSenders/inAppSender')>();
  return { ...actual, sendInAppNotification: vi.fn(async () => ({ success: true, notificationCount: 0 })) };
});

import {
  createNotificationWorker, getNotificationQueue, processAlertNotifications,
  shutdownNotificationDispatcher,
} from '../../services/notificationDispatcher';
import { closeRedis } from '../../services/redis';

let worker: Worker | undefined;
afterAll(async () => {
  await worker?.close();
  await shutdownNotificationDispatcher();
  await closeRedis();
});

async function until(check: () => Promise<boolean>, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Synthetic queue state did not reach its bounded deadline');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('webhook durable retry scheduling', () => {
  it('releases the worker during real backoff, bounds retryable sends and terminates ordinary 4xx', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [device] = await db.insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: randomUUID(), hostname: 'synthetic-retry-host',
      osType: 'linux', osVersion: 'synthetic', architecture: 'x64', agentVersion: '1.0.0',
    }).returning();
    const [alert] = await db.insert(alerts).values({
      orgId: org.id, deviceId: device!.id, severity: 'high', title: 'Synthetic queue check',
    }).returning();
    const channels = await db.insert(notificationChannels).values(
      ['retry', 'terminal', 'healthy'].map((name) => ({
        orgId: org.id, name, type: 'webhook' as const,
        config: { url: `https://example.com/${name}`, retryCount: 2 },
      })),
    ).returning();
    const queue = getNotificationQueue();
    const result = await withSystemDbAccessContext(() => processAlertNotifications({ type: 'process-alert', alertId: alert!.id }));
    expect(result.queued).toBe(3);
    const jobFor = async (name: string) => queue.getJob(`alert-send-${alert!.id}-${channels.find((c) => c.name === name)!.id}-0`);
    const retry = (await jobFor('retry'))!;
    const terminal = (await jobFor('terminal'))!;
    expect(retry.opts.attempts).toBe(3);
    expect(retry.opts.backoff).toEqual({ type: 'exponential', delay: 30_000 });
    expect(terminal.opts.attempts).toBe(3);
    worker = createNotificationWorker();
    // Tighten only the harness worker capacity: one healthy job must progress
    // while the retry job waits. Production's actual backoff stays 30s/60s.
    worker.concurrency = 1;
    await until(async () => await retry.getState() === 'delayed' && await terminal.getState() === 'failed'
      && calls.some((call) => call.path === '/healthy'));
    expect(calls.filter((call) => call.path === '/retry')).toHaveLength(1);
    expect(calls.filter((call) => call.path === '/terminal')).toHaveLength(1);
    await until(async () => await retry.getState() === 'failed', 110_000);
    await worker.close();
    worker = undefined;
    const finalRetry = (await jobFor('retry'))!;
    const finalTerminal = (await jobFor('terminal'))!;
    expect(finalRetry.attemptsMade).toBe(3);
    expect(finalTerminal.attemptsMade).toBe(1);
    const retryCalls = calls.filter((call) => call.path === '/retry');
    expect(retryCalls).toHaveLength(3);
    expect(calls.filter((call) => call.path === '/terminal')).toHaveLength(1);
    expect(calls.filter((call) => call.path === '/healthy')).toHaveLength(1);
    expect(retryCalls[1]!.time - retryCalls[0]!.time).toBeGreaterThanOrEqual(29_000);
    expect(retryCalls[2]!.time - retryCalls[1]!.time).toBeGreaterThanOrEqual(59_000);
    expect(calls.find((call) => call.path === '/healthy')!.time).toBeLessThan(retryCalls[1]!.time);
    const rows = await db.select().from(alertNotifications).where(eq(alertNotifications.alertId, alert!.id));
    expect(rows).toHaveLength(3);
    for (const channel of channels) {
      expect(rows.find((row) => row.channelId === channel.id)?.status).toBe(channel.name === 'healthy' ? 'sent' : 'failed');
    }
  }, 125_000);
});
