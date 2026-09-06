import './setup';

import { randomUUID } from 'crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { actionIntents, devices, intentOutbox, metricAnomalyIncidents, ticketOutbox, tickets } from '../../db/schema';
import { pruneTicketOutbox } from '../../jobs/ticketOutboxRetention';
import { pruneIntentOutbox } from '../../jobs/intentOutboxRetention';
import { pruneMetricAnomalyIncidents } from '../../jobs/metricAnomalyIncidentRetention';
import { MAX_PUBLISH_ATTEMPTS as TICKET_MAX_ATTEMPTS } from '../../jobs/ticketOutboxPublisher';
import { MAX_PUBLISH_ATTEMPTS as INTENT_MAX_ATTEMPTS } from '../../jobs/intentOutboxPublisher';
import { MAX_PUBLISH_ATTEMPTS as ANOMALY_MAX_ATTEMPTS } from '../../jobs/metricAnomalyIncidentPublisher';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

/**
 * Real-DB coverage for the delivered-vs-stuck-vs-mid-retry boundary in the
 * three new #4210 retention jobs. The unit tests in jobs/*Retention.test.ts
 * only assert that the rendered SQL text mentions the right columns/operator
 * (regex on `PgDialect().sqlToQuery(...)`) — that catches nothing if the
 * AND/OR nesting or the `>` vs `>=` comparison regresses, because `db.execute`
 * is fully mocked there. This file seeds real rows in every state the WHERE
 * clause distinguishes and asserts, by id, exactly which ones survive a real
 * DELETE — mirroring mlOutputRetention.integration.test.ts's boundary tests.
 *
 * The single most safety-critical assertion in every `it` below is that a
 * row still within its publisher's retry budget (`attempts <=
 * MAX_PUBLISH_ATTEMPTS`, unpublished) is NEVER deleted, no matter how old —
 * it may still be delivered on the next publisher pass.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

let ticketCounter = 0;
async function insertTicket(orgId: string): Promise<string> {
  ticketCounter++;
  const [row] = await getTestDb()
    .insert(tickets)
    .values({
      orgId,
      ticketNumber: `OUTBOX-RETENTION-${Date.now()}-${ticketCounter}`,
      subject: 'Outbox retention fixture ticket',
    })
    .returning({ id: tickets.id });
  if (!row) throw new Error('insertTicket returned no row');
  return row.id;
}

let deviceCounter = 0;
async function insertDevice(orgId: string, siteId: string): Promise<string> {
  deviceCounter++;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `outbox-retention-${Date.now()}-${deviceCounter}`,
      hostname: `outbox-retention-host-${deviceCounter}`,
      displayName: `outbox-retention-host-${deviceCounter}`,
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('insertDevice returned no row');
  return row.id;
}

async function insertTicketOutboxRow(
  orgId: string,
  ticketId: string,
  overrides: { publishedAt?: Date | null; publishAttempts?: number; createdAt?: Date },
): Promise<number> {
  const [row] = await getTestDb()
    .insert(ticketOutbox)
    .values({
      orgId,
      ticketId,
      eventType: 'ticket.created',
      payload: {},
      createdAt: overrides.createdAt ?? new Date(),
      publishedAt: overrides.publishedAt ?? null,
      publishAttempts: overrides.publishAttempts ?? 0,
    })
    .returning({ id: ticketOutbox.id });
  if (!row) throw new Error('insertTicketOutboxRow returned no row');
  return row.id;
}

let intentCounter = 0;
// intent_outbox has a parent-XOR check constraint (intent_id XOR
// pam_actuation_id) — a bare outbox row with both NULL is rejected, unlike
// ticket_outbox/metric_anomaly_incidents. actionIntents is the lighter of
// the two possible parents (pam_actuations needs an elevation_request +
// device FK chain); every column below without a schema DEFAULT is required.
// action_intents_one_actor_chk additionally requires EXACTLY ONE of
// requested_by_user_id / requesting_api_key_id / requesting_agent_run_id —
// a real user row satisfies that alongside source: 'chat'.
async function insertActionIntent(orgId: string, partnerId: string): Promise<string> {
  intentCounter++;
  const user = await createUser({ partnerId, orgId, email: `outbox-retention-${Date.now()}-${intentCounter}@example.com` });
  const [row] = await getTestDb()
    .insert(actionIntents)
    .values({
      orgId,
      requestedByUserId: user.id,
      source: 'chat',
      actionName: 'outbox_retention_fixture_action',
      argumentDigest: 'a'.repeat(64),
      targetSummary: 'Outbox retention fixture',
      impactSummary: 'Outbox retention fixture',
      riskTier: 1,
      idempotencyKey: `outbox-retention-${Date.now()}-${intentCounter}`,
      correlationId: randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: actionIntents.id });
  if (!row) throw new Error('insertActionIntent returned no row');
  return row.id;
}

async function insertIntentOutboxRow(
  intentId: string,
  overrides: { publishedAt?: Date | null; publishAttempts?: number; createdAt?: Date },
): Promise<number> {
  const [row] = await getTestDb()
    .insert(intentOutbox)
    .values({
      intentId,
      eventType: 'intent_created',
      payload: {},
      createdAt: overrides.createdAt ?? new Date(),
      publishedAt: overrides.publishedAt ?? null,
      publishAttempts: overrides.publishAttempts ?? 0,
    })
    .returning({ id: intentOutbox.id });
  if (!row) throw new Error('insertIntentOutboxRow returned no row');
  return row.id;
}

let windowCounter = 0;
async function insertAnomalyIncident(
  orgId: string,
  deviceId: string,
  overrides: {
    dispatchedAt?: Date | null;
    dispatchAttempts?: number;
    createdAt?: Date;
    lastSeenAt?: Date;
  },
): Promise<string> {
  windowCounter++;
  const windowStart = new Date(Date.now() - windowCounter * 60_000);
  const [row] = await getTestDb()
    .insert(metricAnomalyIncidents)
    .values({
      orgId,
      deviceId,
      anomalyType: 'spike',
      bucketSeconds: 300,
      windowStart,
      firstSeenAt: windowStart,
      lastSeenAt: overrides.lastSeenAt ?? windowStart,
      peakScore: '4.2',
      createdAt: overrides.createdAt ?? new Date(),
      dispatchedAt: overrides.dispatchedAt ?? null,
      dispatchAttempts: overrides.dispatchAttempts ?? 0,
    })
    .returning({ id: metricAnomalyIncidents.id });
  if (!row) throw new Error('insertAnomalyIncident returned no row');
  return row.id;
}

async function selectTicketOutboxIds(orgId: string): Promise<number[]> {
  return (
    await getTestDb().select({ id: ticketOutbox.id }).from(ticketOutbox).where(eq(ticketOutbox.orgId, orgId))
  ).map((r) => r.id);
}

async function selectIntentOutboxIdsByTicketId(ids: number[]): Promise<number[]> {
  // intent_outbox has no org_id (INTENTIONALLY UNSCOPED — see actionIntents.ts).
  // Fixtures are isolated per-test by asserting exactly the ids inserted in
  // that test still exist, rather than scoping the SELECT.
  const remaining = await getTestDb().select({ id: intentOutbox.id }).from(intentOutbox);
  const remainingIds = new Set(remaining.map((r) => r.id));
  return ids.filter((id) => remainingIds.has(id));
}

async function selectAnomalyIncidentIds(orgId: string): Promise<string[]> {
  return (
    await getTestDb()
      .select({ id: metricAnomalyIncidents.id })
      .from(metricAnomalyIncidents)
      .where(eq(metricAnomalyIncidents.orgId, orgId))
  ).map((r) => r.id);
}

describe('Outbox / anomaly-incident retention pruning integration (#4210)', () => {
  let orgId: string;
  let partnerId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    partnerId = partner.id;
    const org = await createOrganization({ partnerId: partner.id, name: `Outbox Retention Org ${randomUUID()}` });
    orgId = org.id;
  });

  describe('ticket_outbox', () => {
    it('deletes delivered and permanently-stuck rows, keeps recent and mid-retry rows', async () => {
      const ticketId = await insertTicket(orgId);
      const old = new Date(Date.now() - 45 * DAY_MS);
      const recent = new Date(Date.now() - 5 * DAY_MS);

      const deliveredOld = await insertTicketOutboxRow(orgId, ticketId, { publishedAt: old, createdAt: old });
      const deliveredRecent = await insertTicketOutboxRow(orgId, ticketId, { publishedAt: recent, createdAt: old });
      const stuckOld = await insertTicketOutboxRow(orgId, ticketId, {
        publishedAt: null,
        publishAttempts: TICKET_MAX_ATTEMPTS + 1,
        createdAt: old,
      });
      // The single most safety-critical case: unpublished, attempts still
      // within the publisher's retry budget, but old. Must survive.
      const midRetryOld = await insertTicketOutboxRow(orgId, ticketId, {
        publishedAt: null,
        publishAttempts: TICKET_MAX_ATTEMPTS,
        createdAt: old,
      });

      const result = await pruneTicketOutbox({ retentionDays: 14 });

      expect(result.deletedCount).toBe(2);
      const remaining = await selectTicketOutboxIds(orgId);
      expect(remaining.sort()).toEqual([deliveredRecent, midRetryOld].sort());
      expect(remaining).not.toContain(deliveredOld);
      expect(remaining).not.toContain(stuckOld);
    });

    it('never deletes an unpublished row within its retry budget, however old', async () => {
      const ticketId = await insertTicket(orgId);
      const ancient = new Date(Date.now() - 365 * DAY_MS);
      const survivor = await insertTicketOutboxRow(orgId, ticketId, {
        publishedAt: null,
        publishAttempts: 0,
        createdAt: ancient,
      });

      const result = await pruneTicketOutbox({ retentionDays: 1 });

      expect(result.deletedCount).toBe(0);
      expect(await selectTicketOutboxIds(orgId)).toEqual([survivor]);
    });
  });

  describe('intent_outbox', () => {
    it('deletes delivered and permanently-stuck rows, keeps recent and mid-retry rows', async () => {
      const intentId = await insertActionIntent(orgId, partnerId);
      const old = new Date(Date.now() - 45 * DAY_MS);
      const recent = new Date(Date.now() - 5 * DAY_MS);

      const deliveredOld = await insertIntentOutboxRow(intentId, { publishedAt: old, createdAt: old });
      const deliveredRecent = await insertIntentOutboxRow(intentId, { publishedAt: recent, createdAt: old });
      const stuckOld = await insertIntentOutboxRow(intentId, {
        publishedAt: null,
        publishAttempts: INTENT_MAX_ATTEMPTS + 1,
        createdAt: old,
      });
      const midRetryOld = await insertIntentOutboxRow(intentId, {
        publishedAt: null,
        publishAttempts: INTENT_MAX_ATTEMPTS,
        createdAt: old,
      });

      const result = await pruneIntentOutbox({ retentionDays: 14 });

      expect(result.deletedCount).toBe(2);
      const remaining = await selectIntentOutboxIdsByTicketId([deliveredOld, deliveredRecent, stuckOld, midRetryOld]);
      expect(remaining.sort()).toEqual([deliveredRecent, midRetryOld].sort());
    });

    it('never deletes an unpublished row within its retry budget, however old', async () => {
      const intentId = await insertActionIntent(orgId, partnerId);
      const ancient = new Date(Date.now() - 365 * DAY_MS);
      const survivor = await insertIntentOutboxRow(intentId, { publishedAt: null, publishAttempts: 0, createdAt: ancient });

      const result = await pruneIntentOutbox({ retentionDays: 1 });

      expect(result.deletedCount).toBe(0);
      expect(await selectIntentOutboxIdsByTicketId([survivor])).toEqual([survivor]);
    });
  });

  describe('metric_anomaly_incidents', () => {
    let deviceId: string;

    beforeEach(async () => {
      const site = await createSite({ orgId, name: 'Outbox Retention Site' });
      deviceId = await insertDevice(orgId, site.id);
    });

    it('deletes dispatched and permanently-stuck rows, keeps recent and mid-retry rows', async () => {
      const old = new Date(Date.now() - 45 * DAY_MS);
      const recent = new Date(Date.now() - 5 * DAY_MS);

      const dispatchedOld = await insertAnomalyIncident(orgId, deviceId, { dispatchedAt: old, createdAt: old });
      const dispatchedRecent = await insertAnomalyIncident(orgId, deviceId, { dispatchedAt: recent, createdAt: old });
      const stuckOld = await insertAnomalyIncident(orgId, deviceId, {
        dispatchedAt: null,
        dispatchAttempts: ANOMALY_MAX_ATTEMPTS + 1,
        createdAt: old,
      });
      const midRetryOld = await insertAnomalyIncident(orgId, deviceId, {
        dispatchedAt: null,
        dispatchAttempts: ANOMALY_MAX_ATTEMPTS,
        createdAt: old,
      });

      const result = await pruneMetricAnomalyIncidents({ retentionDays: 14 });

      expect(result.deletedCount).toBe(2);
      const remaining = await selectAnomalyIncidentIds(orgId);
      expect(remaining.sort()).toEqual([dispatchedRecent, midRetryOld].sort());
      expect(remaining).not.toContain(dispatchedOld);
      expect(remaining).not.toContain(stuckOld);
    });

    it('never deletes an unpublished row within its retry budget, however old', async () => {
      const ancient = new Date(Date.now() - 365 * DAY_MS);
      const survivor = await insertAnomalyIncident(orgId, deviceId, {
        dispatchedAt: null,
        dispatchAttempts: 0,
        createdAt: ancient,
      });

      const result = await pruneMetricAnomalyIncidents({ retentionDays: 1 });

      expect(result.deletedCount).toBe(0);
      expect(await selectAnomalyIncidentIds(orgId)).toEqual([survivor]);
    });

    // The detector's re-upsert (DO UPDATE) refreshes lastSeenAt on every
    // conflict without touching dispatchedAt (metricAnomalyIncidents.ts's own
    // doc comment). A dispatched incident that keeps recurring must still age
    // out on dispatchedAt — if a future refactor swapped the cutoff column to
    // lastSeenAt, this incident would never be pruned even though it was
    // dispatched (and presumably read) 45 days ago.
    it('prunes a dispatched row by dispatchedAt even when lastSeenAt was refreshed recently', async () => {
      const dispatchedOld = new Date(Date.now() - 45 * DAY_MS);
      const lastSeenRecent = new Date(Date.now() - 1 * DAY_MS);
      const recurring = await insertAnomalyIncident(orgId, deviceId, {
        dispatchedAt: dispatchedOld,
        createdAt: dispatchedOld,
        lastSeenAt: lastSeenRecent,
      });

      const result = await pruneMetricAnomalyIncidents({ retentionDays: 14 });

      expect(result.deletedCount).toBe(1);
      expect(await selectAnomalyIncidentIds(orgId)).not.toContain(recurring);
    });
  });
});
