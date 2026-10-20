/**
 * #9050 — the nightly retention scrub also nulls `action_intents.result` for
 * expired TERMINAL intents. Real Postgres through the unprivileged
 * `breeze_app` pool (forced RLS): a write that forgot system scope matches zero
 * rows and fails here. `result` must not be covered by the
 * `action_intents_block_content_update` trigger — this proves it.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema';
import { scrubOrgToolOutputs } from '../../jobs/aiToolOutputRetention';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY_MS);
const OPTS = { batchSize: 100, maxBatches: 10, now: NOW };

describe('aiToolOutputRetention: action_intents.result (#9050)', () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    orgId = (await createOrganization({ partnerId: partner.id, name: 'Intent Retention Org' })).id;
    userId = (await createUser({ partnerId: partner.id, orgId, email: `intent-${randomUUID()}@example.com` })).id;
  });

  async function insertIntent(status: 'completed' | 'executing' | 'failed', createdAt: Date, result: Record<string, unknown> | null) {
    const [row] = await withSystemDbAccessContext(() => db.insert(actionIntents).values({
      orgId,
      requestedByUserId: userId,
      originPrincipalKind: 'user_session',
      source: 'chat',
      actionName: 'run_script',
      arguments: { script: 'x' },
      argumentDigest: 'a'.repeat(64),
      targetSummary: 't',
      impactSummary: 'i',
      idempotencyKey: `idem-${randomUUID()}`,
      correlationId: randomUUID(),
      riskTier: 3,
      status,
      result,
      createdAt,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    }).returning({ id: actionIntents.id }));
    return row!.id;
  }

  const rowOf = async (id: string) => {
    const [row] = await getTestDb()
      .select({ result: actionIntents.result, status: actionIntents.status })
      .from(actionIntents)
      .where(eq(actionIntents.id, id));
    return row!;
  };

  it('nulls the result of an expired terminal intent, keeps recent and live ones, and is idempotent', async () => {
    const old = await insertIntent('completed', daysAgo(40), { stdout: 'secret' });
    const oldFailed = await insertIntent('failed', daysAgo(40), { error: 'secret' });
    const recent = await insertIntent('completed', daysAgo(5), { stdout: 'keep' });
    const live = await insertIntent('executing', daysAgo(40), { partial: 'keep' });

    const first = await scrubOrgToolOutputs(orgId, 30, OPTS);

    expect(first.intents.deleted).toBe(2);
    expect(await rowOf(old)).toEqual({ result: null, status: 'completed' });
    expect((await rowOf(oldFailed)).result).toBeNull();
    expect((await rowOf(recent)).result).toEqual({ stdout: 'keep' });
    expect((await rowOf(live)).result).toEqual({ partial: 'keep' });

    const second = await scrubOrgToolOutputs(orgId, 30, OPTS);
    expect(second.intents.deleted).toBe(0);
  });
});
