import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgents } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner, createUser } from './db-utils';

const SYSTEM: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };
const partnerCtx = (partnerId: string): DbAccessContext => ({ scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [partnerId], userId: null, currentPartnerId: partnerId });
const PROVISIONER = 'system:remediation_research';
const uniqueEmail = () => `prov-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

async function expectSqlState(fn: () => Promise<unknown>, code: string) {
  let raised: unknown;
  try { await fn(); } catch (err) { raised = err; }
  expect(pgErrorCode(raised)).toBe(code);
}

const provisioned = (partnerId: string) => ({
  partnerId, orgId: null, kind: 'research' as const, name: 'Fix research (built-in)', enabled: true, mode: 'act' as const,
  toolAllowlist: [], createdBy: null, provisionedBy: PROVISIONER,
});

describe('ai_agents provenance (real Postgres)', () => {
  it('a tenant context cannot forge a system-provisioned row (42501)', async () => {
    const partner = await createPartner();
    await expectSqlState(() => withDbAccessContext(partnerCtx(partner.id), () => db.insert(aiAgents).values(provisioned(partner.id))), '42501');
  });

  it('a tenant context cannot rewrite provenance on an existing row (42501)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id, email: uniqueEmail() });
    const [row] = await withDbAccessContext(SYSTEM, () => db.insert(aiAgents).values({
      partnerId: partner.id, orgId: null, kind: 'triage', name: 'Triage', enabled: true, mode: 'shadow', createdBy: user.id,
    }).returning({ id: aiAgents.id }));
    await expectSqlState(() => withDbAccessContext(partnerCtx(partner.id), () => db.update(aiAgents)
      .set({ createdBy: null, provisionedBy: PROVISIONER }).where(eq(aiAgents.id, row!.id))), '42501');
  });

  it('system provisioning succeeds; a tenant edit that leaves provenance alone succeeds', async () => {
    const partner = await createPartner();
    const [row] = await withDbAccessContext(SYSTEM, () => db.insert(aiAgents).values(provisioned(partner.id)).returning({ id: aiAgents.id }));
    const updated = await withDbAccessContext(partnerCtx(partner.id), () => db.update(aiAgents)
      .set({ enabled: false, updatedAt: new Date() }).where(eq(aiAgents.id, row!.id)).returning({ enabled: aiAgents.enabled, provisionedBy: aiAgents.provisionedBy }));
    expect(updated).toEqual([{ enabled: false, provisionedBy: PROVISIONER }]);
  });

  it('XOR: both creators, or neither, is refused even in the system scope (23514)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id, email: uniqueEmail() });
    await expectSqlState(() => withDbAccessContext(SYSTEM, () => db.insert(aiAgents).values({ ...provisioned(partner.id), createdBy: user.id })), '23514');
    await expectSqlState(() => withDbAccessContext(SYSTEM, () => db.insert(aiAgents).values({ ...provisioned(partner.id), provisionedBy: null })), '23514');
  });
});
