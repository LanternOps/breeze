import '../../__tests__/integration/setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { burnTemporaryPassword } from './resultSecrets';
import { redactExpiredUnrevealedSecrets } from '../../jobs/intentExpiryReaper';
import {
  createPartner,
  createOrganization,
  createUser,
} from '../../__tests__/integration/db-utils';

describe('resultSecrets burn + sweep (real PG)', () => {
  let orgId: string;
  let requestedByUserId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    orgId = org.id;
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    requestedByUserId = user.id;
  });

  async function seedCompleted(fields: {
    executedAt: Date;
    result: Record<string, unknown>;
  }): Promise<string> {
    return withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(actionIntents)
        .values({
          orgId,
          requestedByUserId,
          source: 'chat',
          actionName: 'm365_reset_password',
          arguments: {},
          argumentDigest: 'a'.repeat(64),
          targetSummary: 't',
          impactSummary: 'i',
          riskTier: 3,
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
          status: 'completed',
          expiresAt: new Date(Date.now() + 3_600_000),
          decidedAt: new Date(),
          executedAt: fields.executedAt,
          result: fields.result,
        })
        .returning({ id: actionIntents.id });
      return row!.id;
    });
  }

  async function loadResult(id: string): Promise<Record<string, unknown>> {
    return withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({ result: actionIntents.result })
        .from(actionIntents)
        .where(eq(actionIntents.id, id))
        .limit(1);
      return (row!.result ?? {}) as Record<string, unknown>;
    });
  }

  const SEALED = {
    success: true,
    action: 'm365.user.reset_password',
    userId: 'u-1',
    temporaryPasswordEnc: 'enc:v3:integration-fake',
    forceChangeNextSignIn: true,
  };

  it('concurrent burns: exactly one caller wins the CAS', async () => {
    const id = await seedCompleted({ executedAt: new Date(), result: SEALED });
    const outcomes = await withSystemDbAccessContext(() =>
      Promise.all([
        burnTemporaryPassword(id, { revealedByUserId: requestedByUserId }),
        burnTemporaryPassword(id, { revealedByUserId: requestedByUserId }),
      ]),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);

    const result = await loadResult(id);
    expect(result).not.toHaveProperty('temporaryPasswordEnc');
    expect(result).not.toHaveProperty('temporaryPassword');
    expect(result.temporaryPasswordRevealed).toMatchObject({
      revealedByUserId: requestedByUserId,
    });
    // Non-secret fields survive the burn.
    expect(result.userId).toBe('u-1');
  });

  it('sweep redacts old un-revealed secrets (both key forms), leaves recent and revealed rows alone', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const oldSealed = await seedCompleted({ executedAt: eightDaysAgo, result: SEALED });
    const oldLegacy = await seedCompleted({
      executedAt: eightDaysAgo,
      result: JSON.parse(
        JSON.stringify({ ...SEALED, temporaryPasswordEnc: undefined, temporaryPassword: 'Plain-1!' }),
      ),
    });
    const recent = await seedCompleted({ executedAt: new Date(), result: SEALED });
    const oldRevealed = await seedCompleted({
      executedAt: eightDaysAgo,
      result: {
        success: true,
        action: 'm365.user.reset_password',
        userId: 'u-1',
        temporaryPasswordRevealed: { revealedAt: eightDaysAgo.toISOString(), revealedByUserId: requestedByUserId },
      },
    });

    const count = await withSystemDbAccessContext(redactExpiredUnrevealedSecrets);
    expect(count).toBe(2);

    for (const id of [oldSealed, oldLegacy]) {
      const r = await loadResult(id);
      expect(r).not.toHaveProperty('temporaryPasswordEnc');
      expect(r).not.toHaveProperty('temporaryPassword');
      expect(r.temporaryPasswordExpired).toBe(true);
    }
    expect(await loadResult(recent)).toHaveProperty('temporaryPasswordEnc');
    const revealedResult = await loadResult(oldRevealed);
    expect(revealedResult.temporaryPasswordRevealed).toBeTruthy();
    expect(revealedResult).not.toHaveProperty('temporaryPasswordExpired');
  });
});
