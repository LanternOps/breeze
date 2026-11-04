import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { partnerServicePrincipals } from '../../db/schema';
import { createUser } from './db-utils';
import { insertAlertRef, seedAlertRefFixture } from './alertExternalRefsFixtures';

const pgCode = (error: unknown): string | undefined => {
  const e = error as { code?: string; cause?: unknown };
  return e.code ?? (e.cause ? pgCode(e.cause) : undefined);
};

describe('alert_external_refs tenancy and constraints', () => {
  it('breeze_app in org B cannot forge or read org A refs', async () => {
    const f = await seedAlertRefFixture();
    const context = { scope: 'organization' as const, orgId: f.orgB.id, accessibleOrgIds: [f.orgB.id] };
    const error = await withDbAccessContext(context, () => db.execute(insertAlertRef(f))).catch((e: unknown) => e);
    expect(pgCode(error)).toBe('42501');
    await getTestDb().execute(insertAlertRef(f));
    const rows = await withDbAccessContext(context, () => db.execute(sql`SELECT * FROM alert_external_refs`));
    expect(rows).toHaveLength(0);
  });

  it.each([
    ['principal belongs to another partner', '23503', 'partner'],
    ['ref org differs from alert org', '23503', 'org'],
    ['http URL', '23514', 'url'],
  ])('rejects %s', async (_name, code, variant) => {
    const f = await seedAlertRefFixture();
    const foreignActor = await createUser({ partnerId: f.otherPartner.id });
    const [foreignPrincipal] = await getTestDb().insert(partnerServicePrincipals).values({
      partnerId: f.otherPartner.id, name: 'Other partner', scopes: ['alerts:write'],
      createdBy: foreignActor.id, updatedBy: foreignActor.id,
    }).returning();
    const overrides = variant === 'partner' ? { principalId: foreignPrincipal!.id }
      : variant === 'org' ? { orgId: f.orgB.id } : { url: 'http://psa.example.com/ticket/1' };
    const error = await getTestDb().execute(insertAlertRef(f, overrides)).catch((e: unknown) => e);
    expect(pgCode(error)).toBe(code);
  });

  it('rejects duplicate alert/principal but allows one external ticket for multiple alerts', async () => {
    const f = await seedAlertRefFixture();
    await getTestDb().execute(insertAlertRef(f));
    const error = await getTestDb().execute(insertAlertRef(f)).catch((e: unknown) => e);
    expect(pgCode(error)).toBe('23505');
    const [second] = await getTestDb().execute(sql`INSERT INTO alerts (org_id, device_id, severity, title)
      VALUES (${f.orgA.id}::uuid, ${f.device.id}::uuid, 'high', 'Second alert') RETURNING id`);
    await getTestDb().execute(insertAlertRef({ ...f, alert: { ...f.alert, id: String(second!.id) } }));
    expect(await getTestDb().execute(sql`SELECT id FROM alert_external_refs WHERE external_id = 'PSA-123'`)).toHaveLength(2);
  });
});
