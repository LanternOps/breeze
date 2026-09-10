/**
 * Generic-webhook endpoint/header origin binding under concurrent PATCHes.
 *
 * The route validates DNS before its write, so it must not hold a row lock
 * across that potentially slow operation. These tests pre-hold the webhook
 * row, start a real JWT request as breeze_app, prove its UPDATE is blocked,
 * then commit the competing endpoint/header change. The stale request must
 * lose the optimistic URL+headers CAS without audit, queue, or egress.
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import postgres, { type Sql } from 'postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getTestDb } from './setup';
import { setupTestEnvironment, type TestEnvironment } from './db-utils';
import { webhooks } from '../../db/schema';
import { decryptWebhookHeaders } from '../../services/notificationChannelSecrets';
import { createAccessToken } from '../../services/jwt';

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  queueDelivery: vi.fn(),
  validateUrl: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: mocks.audit }));
vi.mock('../../workers/webhookDelivery', () => ({
  getWebhookWorker: () => ({ queueDelivery: mocks.queueDelivery }),
}));
vi.mock('../../services/notificationSenders/webhookSender', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/notificationSenders/webhookSender')>()),
  validateWebhookUrlSafetyWithDns: mocks.validateUrl,
}));

import { webhookRoutes } from '../../routes/webhooks';

const DATABASE_URL = process.env.DATABASE_URL!;
const runDb = it.runIf(Boolean(DATABASE_URL));

function app(): Hono {
  const instance = new Hono();
  instance.route('/webhooks', webhookRoutes);
  return instance;
}

function mfaToken(env: TestEnvironment): Promise<string> {
  return createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: env.organization.id,
    partnerId: env.partner.id,
    scope: 'organization',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });
}

async function waitForBlockedWebhookUpdate(monitor: Sql): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await monitor<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting
      FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND query ILIKE '%update "webhooks"%'
        AND cardinality(pg_catalog.pg_blocking_pids(pid)) > 0
    `;
    if ((rows[0]?.waiting ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error('expected route webhook UPDATE to block on row lock');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function racePatchAgainstCommittedTuple(params: {
  webhookId: string;
  token: string;
  requestBody: Record<string, unknown>;
  competingUpdate: (tx: Sql) => Promise<void>;
}): Promise<Response> {
  const blocker = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  const monitor = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  let release!: () => void;
  let lockHeld!: () => void;
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const lockHeldPromise = new Promise<void>((resolve) => { lockHeld = resolve; });
  let holder: Promise<unknown> | undefined;
  try {
    holder = blocker.begin(async (tx) => {
      await tx`SELECT id FROM webhooks WHERE id = ${params.webhookId}::uuid FOR UPDATE`;
      lockHeld();
      await releasePromise;
      await params.competingUpdate(tx as unknown as Sql);
    });
    await lockHeldPromise;

    const request = Promise.resolve(app().request(`/webhooks/${params.webhookId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.token}`,
      },
      body: JSON.stringify(params.requestBody),
    }));
    const settled = request.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason) => ({ status: 'rejected' as const, reason }),
    );
    await waitForBlockedWebhookUpdate(monitor);
    release();
    await holder;
    const result = await settled;
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  } finally {
    release?.();
    await holder?.catch(() => undefined);
    await Promise.all([blocker.end({ timeout: 1 }), monitor.end({ timeout: 1 })]);
  }
}

describe('generic webhook URL/header optimistic tuple binding', () => {
  beforeEach(() => vi.clearAllMocks());

  runDb('stale cross-origin URL change loses after a header update commits', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const [row] = await getTestDb().insert(webhooks).values({
      orgId: env.organization.id,
      name: 'Origin race',
      url: 'https://origin-a.example/hook',
      events: ['device.created'],
      headers: [{ key: 'Authorization', value: 'Bearer origin-a' }],
      createdBy: env.user.id,
    }).returning();
    expect(row).toBeTruthy();

    const response = await racePatchAgainstCommittedTuple({
      webhookId: row!.id,
      token: await mfaToken(env),
      requestBody: {
        url: 'https://origin-b.example/hook',
        headers: [{ key: 'Authorization', value: 'Bearer origin-b' }],
      },
      competingUpdate: async (tx) => {
        await tx`
          UPDATE webhooks
          SET headers = ${tx.json([{ key: 'Authorization', value: 'Bearer updated-a' }])}
          WHERE id = ${row!.id}::uuid
        `;
      },
    });

    expect(response.status).toBe(409);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.queueDelivery).not.toHaveBeenCalled();
    expect(mocks.validateUrl).toHaveBeenCalledTimes(1);
    const [stored] = await getTestDb().select().from(webhooks).where(eq(webhooks.id, row!.id));
    expect(stored?.url).toBe('https://origin-a.example/hook');
    expect(decryptWebhookHeaders(stored?.headers)).toEqual([
      { key: 'Authorization', value: 'Bearer updated-a' },
    ]);
  });

  runDb('stale masked-header preservation loses after an origin change commits', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const [row] = await getTestDb().insert(webhooks).values({
      orgId: env.organization.id,
      name: 'Header race',
      url: 'https://origin-a.example/hook',
      events: ['device.created'],
      headers: [{ key: 'Authorization', value: 'Bearer origin-a' }],
      createdBy: env.user.id,
    }).returning();
    expect(row).toBeTruthy();

    const response = await racePatchAgainstCommittedTuple({
      webhookId: row!.id,
      token: await mfaToken(env),
      requestBody: {
        headers: [{ key: 'Authorization', value: '********' }],
      },
      competingUpdate: async (tx) => {
        await tx`
          UPDATE webhooks
          SET url = ${'https://origin-b.example/hook'},
              headers = ${tx.json([{ key: 'Authorization', value: 'Bearer origin-b' }])}
          WHERE id = ${row!.id}::uuid
        `;
      },
    });

    expect(response.status).toBe(409);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.queueDelivery).not.toHaveBeenCalled();
    expect(mocks.validateUrl).not.toHaveBeenCalled();
    const [stored] = await getTestDb().select().from(webhooks).where(eq(webhooks.id, row!.id));
    expect(stored?.url).toBe('https://origin-b.example/hook');
    expect(decryptWebhookHeaders(stored?.headers)).toEqual([
      { key: 'Authorization', value: 'Bearer origin-b' },
    ]);
  });
});
