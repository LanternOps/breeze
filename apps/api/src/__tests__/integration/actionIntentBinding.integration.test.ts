import './setup';
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const connectionId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';

describe('action_intents binding columns', () => {
  runDb('accepts a bound intent and refuses to let either column be mutated', async () => {
    const fx = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const user = await createUser({
        partnerId: partner.id, orgId: org.id,
        email: `binding-${Date.now()}@example.com`,
      });
      return { org, user };
    });

    const [row] = await withSystemDbAccessContext(() => db.insert(actionIntents).values({
      orgId: fx.org.id,
      requestedByUserId: fx.user.id,
      originPrincipalKind: 'user_session',
      source: 'chat',
      actionName: 'm365_send_mail',
      arguments: { to: ['a@example.com'], subject: 's', bodyText: 'b' },
      argumentDigest: 'a'.repeat(64),
      targetSummary: 'm365_send_mail(to=a@example.com)',
      impactSummary: 'Send an email',
      idempotencyKey: `binding-${Date.now()}`,
      correlationId: randomUUID(),
      riskTier: 3,
      connectionId,
      tenantId,
      expiresAt: new Date(Date.now() + 3_600_000),
    }).returning({ id: actionIntents.id }));

    // The immutability trigger already covers both columns
    // (2026-07-18-action-intents.sql:109-110) — assert it, do not assume it.
    await expect(withSystemDbAccessContext(() => db.update(actionIntents)
      .set({ connectionId: '33333333-3333-4333-8333-333333333333' })
      .where(eq(actionIntents.id, row!.id))))
      .rejects.toThrow();

    await expect(withSystemDbAccessContext(() => db.update(actionIntents)
      .set({ tenantId: '44444444-4444-4444-8444-444444444444' })
      .where(eq(actionIntents.id, row!.id))))
      .rejects.toThrow();

    const [after] = await withSystemDbAccessContext(() => db.select({
      connectionId: actionIntents.connectionId,
      tenantId: actionIntents.tenantId,
    }).from(actionIntents).where(eq(actionIntents.id, row!.id)));
    expect(after).toEqual({ connectionId, tenantId });
  });
});
