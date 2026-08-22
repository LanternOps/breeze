import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgents } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

const created: string[] = [];
const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

afterEach(async () => {
  if (created.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, () =>
    db.delete(aiAgents).where(inArray(aiAgents.id, created)),
  );
  created.length = 0;
});

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

function orgContext(
  orgId: string,
  currentPartnerId: string | null,
): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

async function expectSqlState(
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  expect(cause?.code ?? (raised as { code?: string })?.code).toBe(code);
}

async function creator(partnerId: string): Promise<string> {
  const user = await createUser({ partnerId });
  return user.id;
}

const BASE = { kind: 'triage' as const, name: 'Triage' };

describe('ai_agents RLS — dual-axis (2026-09-01 migration)', () => {
  it('partner scope can INSERT a partner-wide agent', async () => {
    const partner = await createPartner();
    const by = await creator(partner.id);
    const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(aiAgents)
        .values({ ...BASE, orgId: null, partnerId: partner.id, createdBy: by })
        .returning(),
    );
    expect(rows[0]?.partnerId).toBe(partner.id);
    created.push(rows[0]!.id);
  });

  it('rejects a cross-partner forge (42501)', async () => {
    const attacker = await createPartner();
    const victim = await createPartner();
    const by = await creator(attacker.id);
    await expectSqlState(
      () =>
        withDbAccessContext(partnerContext(attacker.id, []), () =>
          db
            .insert(aiAgents)
            .values({ ...BASE, orgId: null, partnerId: victim.id, createdBy: by })
            .returning(),
        ),
      '42501',
    );
  });

  it('rejects BOTH axes set (23514)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const by = await creator(partner.id);
    await expectSqlState(
      () =>
        withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
          db
            .insert(aiAgents)
            .values({ ...BASE, orgId: org.id, partnerId: partner.id, createdBy: by })
            .returning(),
        ),
      '23514',
    );
  });

  it('org token cannot see a partner-wide row; partner token can', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const by = await creator(partner.id);
    const [row] = await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      db
        .insert(aiAgents)
        .values({ ...BASE, orgId: null, partnerId: partner.id, createdBy: by })
        .returning(),
    );
    created.push(row!.id);
    const seenByOrg = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db.select().from(aiAgents),
    );
    expect(seenByOrg.find((candidate) => candidate.id === row!.id)).toBeUndefined();
    const seenByPartner = await withDbAccessContext(
      partnerContext(partner.id, [org.id]),
      () => db.select().from(aiAgents),
    );
    expect(seenByPartner.find((candidate) => candidate.id === row!.id)).toBeDefined();
  });

  it('org isolation: org B cannot read org A agent', async () => {
    const partner = await createPartner();
    const a = await createOrganization({ partnerId: partner.id });
    const b = await createOrganization({ partnerId: partner.id });
    const by = await creator(partner.id);
    const [row] = await withDbAccessContext(orgContext(a.id, partner.id), () =>
      db
        .insert(aiAgents)
        .values({ ...BASE, orgId: a.id, partnerId: null, createdBy: by })
        .returning(),
    );
    created.push(row!.id);
    const seen = await withDbAccessContext(orgContext(b.id, partner.id), () =>
      db.select().from(aiAgents),
    );
    expect(seen.find((candidate) => candidate.id === row!.id)).toBeUndefined();
  });

  it('soft delete frees the (owner, kind) slot', async () => {
    const partner = await createPartner();
    const by = await creator(partner.id);
    const [first] = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(aiAgents)
        .values({ ...BASE, orgId: null, partnerId: partner.id, createdBy: by })
        .returning(),
    );
    created.push(first!.id);
    await expectSqlState(
      () =>
        withDbAccessContext(partnerContext(partner.id, []), () =>
          db
            .insert(aiAgents)
            .values({ ...BASE, orgId: null, partnerId: partner.id, createdBy: by })
            .returning(),
        ),
      '23505',
    );
    await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .update(aiAgents)
        .set({ disabledAt: new Date() })
        .where(inArray(aiAgents.id, [first!.id])),
    );
    const [second] = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(aiAgents)
        .values({ ...BASE, orgId: null, partnerId: partner.id, createdBy: by })
        .returning(),
    );
    created.push(second!.id);
    expect(second!.id).not.toBe(first!.id);
  });
});
