/**
 * Agent wake-status ingest under the agent's real DB context, on real Postgres
 * (#10838 W02).
 *
 * `PUT /agents/:id/wake-status` runs `ingestWakeStatusSnapshot` inside the
 * org-scoped context agentAuthMiddleware opens (scope 'organization', the
 * device org as the only accessible org, no partner-axis access). The upsert
 * must (a) keep the consecutive-timeout counter while the fingerprint is
 * unchanged and restart it when it changes, (b) never touch the sweep-owned
 * `proof_fingerprint` / `last_came_online_at`, and (c) be unable to land a row
 * for another org's device: RLS, not application code, is the guard.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { WakeStatusSnapshot } from '@breeze/shared';
import { db } from '../../db';
import { deviceWakeStatus } from '../../db/schema';
import { ingestWakeStatusSnapshot } from '../../services/wakeStatusIngest';
import { createOrganization, createPartner, createSite } from './db-utils';
import { inOrg, seedDevice, sys } from './policySetFixtures';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const CAME_ONLINE = new Date('2026-11-01T08:00:00.000Z');

const snapshot = (fingerprint: string, over: Partial<WakeStatusSnapshot> = {}): WakeStatusSnapshot => ({
  readinessState: 'ready',
  reasonCodes: [],
  vendor: 'dell',
  fingerprint,
  collectedAt: '2026-11-15T10:00:00.000Z',
  lastApplyAt: null,
  lastApplyResult: null,
  lastWiredAdapterSeenAt: null,
  details: { os: 'windows' },
  ...over,
});

const readRow = (deviceId: string) => sys(async () => {
  const [row] = await db.select().from(deviceWakeStatus).where(eq(deviceWakeStatus.deviceId, deviceId));
  return row;
});

describe('wake status ingest on real Postgres (#10838)', () => {
  runDb('keeps timeouts on an unchanged fingerprint, resets them on a change, and never touches the sweep columns', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const deviceId = await seedDevice(org.id, site.id, 'wsi-a');

    await sys(async () => {
      await db.insert(deviceWakeStatus).values({
        deviceId, orgId: org.id, readinessState: 'ready', fingerprint: 'fp1', proofFingerprint: 'fp1',
        lastCameOnlineAt: CAME_ONLINE, consecutiveTimeouts: 3,
      });
    });

    const t1 = new Date('2026-11-15T10:05:00.000Z');
    const same = await inOrg(org.id, partner.id, () => ingestWakeStatusSnapshot({
      deviceId, orgId: org.id, agentVersion: '0.130.0', snapshot: snapshot('fp1'), receivedAt: t1,
    }));
    expect(same).toEqual({ accepted: true });
    const afterSame = await readRow(deviceId);
    expect(afterSame!.consecutiveTimeouts).toBe(3);
    expect(afterSame!.proofFingerprint).toBe('fp1');
    expect(afterSame!.lastCameOnlineAt!.toISOString()).toBe(CAME_ONLINE.toISOString());
    expect(afterSame!.receivedAt!.toISOString()).toBe(t1.toISOString());
    expect(afterSame!.agentVersion).toBe('0.130.0');

    const t2 = new Date('2026-11-15T10:10:00.000Z');
    await inOrg(org.id, partner.id, () => ingestWakeStatusSnapshot({
      deviceId, orgId: org.id, agentVersion: '0.130.0', snapshot: snapshot('fp2', { readinessState: 'unproven' }), receivedAt: t2,
    }));
    const afterChange = await readRow(deviceId);
    expect(afterChange!.consecutiveTimeouts).toBe(0);
    expect(afterChange!.fingerprint).toBe('fp2');
    expect(afterChange!.readinessState).toBe('unproven');
    expect(afterChange!.proofFingerprint).toBe('fp1');
    expect(afterChange!.lastCameOnlineAt!.toISOString()).toBe(CAME_ONLINE.toISOString());
    expect(afterChange!.receivedAt!.toISOString()).toBe(t2.toISOString());
  });

  runDb('an agent context for one org cannot write a row for another org\'s device (RLS)', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });
    const dA = await seedDevice(orgA.id, siteA.id, 'wsi-rls-a');
    const dB = await seedDevice(orgB.id, siteB.id, 'wsi-rls-b');

    // One org per transaction: the partner-export lock trigger rejects a
    // multi-org transaction taken out of UUID order.
    await sys(async () => {
      await db.insert(deviceWakeStatus).values({
        deviceId: dB, orgId: orgB.id, readinessState: 'ready', fingerprint: 'fp-b', consecutiveTimeouts: 3,
      });
    });

    // Existing foreign row: the update must not land.
    const received = new Date('2026-11-15T11:00:00.000Z');
    const updateOutcome = await inOrg(orgA.id, partner.id, () => ingestWakeStatusSnapshot({
      deviceId: dB, orgId: orgB.id, agentVersion: '9.9.9', snapshot: snapshot('fp-evil', { readinessState: 'apply_failed' }), receivedAt: received,
    })).then(() => 'resolved', () => 'rejected');
    const untouched = await readRow(dB);
    expect(untouched!.fingerprint).toBe('fp-b');
    expect(untouched!.readinessState).toBe('ready');
    expect(untouched!.consecutiveTimeouts).toBe(3);
    expect(untouched!.agentVersion).toBeNull();

    // No foreign row yet: the insert must not land either.
    const dB2 = await seedDevice(orgB.id, siteB.id, 'wsi-rls-b2');
    const insertOutcome = await inOrg(orgA.id, partner.id, () => ingestWakeStatusSnapshot({
      deviceId: dB2, orgId: orgB.id, agentVersion: '9.9.9', snapshot: snapshot('fp-evil'), receivedAt: received,
    })).then(() => 'resolved', () => 'rejected');
    expect(await readRow(dB2)).toBeUndefined();

    // Positive control: the same context writes its own device's row.
    await inOrg(orgA.id, partner.id, () => ingestWakeStatusSnapshot({
      deviceId: dA, orgId: orgA.id, agentVersion: '0.130.0', snapshot: snapshot('fp-a'), receivedAt: received,
    }));
    expect((await readRow(dA))!.fingerprint).toBe('fp-a');

    // RLS refuses with an error rather than silently dropping the write.
    expect([updateOutcome, insertOutcome]).toEqual(['rejected', 'rejected']);
  });
});
