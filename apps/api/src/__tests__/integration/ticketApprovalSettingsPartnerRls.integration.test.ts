/**
 * ticket_approval_settings RLS — dual-axis (org XOR partner) enforcement and
 * the resolver's inheritance against real Postgres (#4617 W01, CLAUDE.md
 * "Partner-Wide First" step 6).
 *
 * Shipped policies (2026-12-17-150100-ticket-approval-settings.sql):
 *   ticket_approval_settings_tenant                  FOR ALL  system OR org-access OR partner-access
 *   ticket_approval_settings_partner_default_select  FOR SELECT  org_id IS NULL
 *                                                    AND partner_id = breeze_current_partner_id()
 *
 * rls-coverage proves the policies exist; this suite drives the real driver as
 * breeze_app under FORCE RLS to prove they enforce.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray, or } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { ticketApprovalSettings } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';
import {
  resolveTicketApprovalSettings,
  updateOrgTicketApprovalSettings,
  updatePartnerTicketApprovalSettings,
} from '../../services/ticketApproval/settings';
import { runPolicy } from '../../services/orgMerge';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};

const createdRowIds: string[] = [];

afterEach(async () => {
  const ids = [...new Set(createdRowIds)];
  createdRowIds.length = 0;
  if (ids.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, () =>
    db.delete(ticketApprovalSettings).where(inArray(ticketApprovalSettings.id, ids)));
});

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId],
    userId: null, currentPartnerId: partnerId,
  };
}

function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return {
    scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [],
    userId: null, currentPartnerId,
  };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

async function seedRow(values: { orgId?: string | null; partnerId?: string | null; enforcement?: 'soft' | 'hard'; enabled?: boolean }) {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(ticketApprovalSettings).values({
      orgId: values.orgId ?? null, partnerId: values.partnerId ?? null,
      enforcement: values.enforcement ?? null, enabled: values.enabled ?? null,
    }).returning({ id: ticketApprovalSettings.id }));
  createdRowIds.push(row!.id);
  return row!.id;
}

/** Track the rows the service upserts wrote for this partner and its orgs. */
async function trackAll(partnerId: string, orgIds: string[]) {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db.select({ id: ticketApprovalSettings.id }).from(ticketApprovalSettings).where(or(
      eq(ticketApprovalSettings.partnerId, partnerId),
      inArray(ticketApprovalSettings.orgId, orgIds),
    )));
  createdRowIds.push(...rows.map((r) => r.id));
}

async function setup() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA1 = await createOrganization({ partnerId: partnerA.id });
  const orgA2 = await createOrganization({ partnerId: partnerA.id });
  return { partnerA, partnerB, orgA1, orgA2 };
}

describe('ticket_approval_settings RLS (#4617)', () => {
  it('(a) partner A cannot insert a partner-default row for partner B (42501)', async () => {
    const { partnerA, partnerB } = await setup();
    await expectSqlState(
      () => withDbAccessContext(partnerContext(partnerA.id, []), () =>
        db.insert(ticketApprovalSettings).values({ partnerId: partnerB.id, enabled: true }).returning()),
      '42501',
    );
  });

  it('partner A can insert its own partner-default row', async () => {
    const { partnerA } = await setup();
    const rows = await withDbAccessContext(partnerContext(partnerA.id, []), () =>
      db.insert(ticketApprovalSettings).values({ partnerId: partnerA.id, enabled: true }).returning());
    createdRowIds.push(rows[0]!.id);
    expect(rows[0]!.partnerId).toBe(partnerA.id);
  });

  it('(b) a row with both owners set violates the XOR CHECK (23514)', async () => {
    const { partnerA, orgA1 } = await setup();
    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () =>
        db.insert(ticketApprovalSettings).values({ partnerId: partnerA.id, orgId: orgA1.id }).returning()),
      '23514',
    );
    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () => db.insert(ticketApprovalSettings).values({}).returning()),
      '23514',
    );
  });

  it('rejects out-of-range ttl and unknown enforcement (23514)', async () => {
    const { partnerA } = await setup();
    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () =>
        db.insert(ticketApprovalSettings).values({ partnerId: partnerA.id, requestTtlHours: 721 }).returning()),
      '23514',
    );
    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () =>
        db.insert(ticketApprovalSettings).values({ partnerId: partnerA.id, enforcement: 'strict' as never }).returning()),
      '23514',
    );
  });

  it('(c) an org context reads its partner default via the SELECT-only branch but cannot UPDATE it', async () => {
    const { partnerA, orgA1 } = await setup();
    const id = await seedRow({ partnerId: partnerA.id, enforcement: 'hard' });

    const seen = await withDbAccessContext(orgContext(orgA1.id, partnerA.id), () =>
      db.select().from(ticketApprovalSettings).where(eq(ticketApprovalSettings.id, id)));
    expect(seen).toHaveLength(1);

    const updated = await withDbAccessContext(orgContext(orgA1.id, partnerA.id), () =>
      db.update(ticketApprovalSettings).set({ enforcement: 'soft' })
        .where(eq(ticketApprovalSettings.id, id)).returning());
    expect(updated).toHaveLength(0);

    const deleted = await withDbAccessContext(orgContext(orgA1.id, partnerA.id), () =>
      db.delete(ticketApprovalSettings).where(eq(ticketApprovalSettings.id, id)).returning());
    expect(deleted).toHaveLength(0);

    // A different partner's org sees nothing through the branch.
    const { partnerB } = await setup();
    const orgB1 = await createOrganization({ partnerId: partnerB.id });
    const foreign = await withDbAccessContext(orgContext(orgB1.id, partnerB.id), () =>
      db.select().from(ticketApprovalSettings).where(eq(ticketApprovalSettings.id, id)));
    expect(foreign).toHaveLength(0);
  });

  it("(d) org A1's context cannot read org A2's override", async () => {
    const { orgA1, orgA2, partnerA } = await setup();
    const id = await seedRow({ orgId: orgA2.id, enabled: false });
    const seen = await withDbAccessContext(orgContext(orgA1.id, partnerA.id), () =>
      db.select().from(ticketApprovalSettings).where(eq(ticketApprovalSettings.id, id)));
    expect(seen).toHaveLength(0);
  });

  it('enforces one partner-default row and one override per org (23505)', async () => {
    const { partnerA, orgA1 } = await setup();
    await seedRow({ partnerId: partnerA.id });
    await expectSqlState(() => seedRow({ partnerId: partnerA.id }), '23505');
    await seedRow({ orgId: orgA1.id });
    await expectSqlState(() => seedRow({ orgId: orgA1.id }), '23505');
  });
});

describe('resolveTicketApprovalSettings against real rows (#4617 §4.1)', () => {
  it('org override wins per field, null clears back to the partner value', async () => {
    const { partnerA, orgA1 } = await setup();
    const ctx = partnerContext(partnerA.id, [orgA1.id]);

    await withDbAccessContext(ctx, async () => {
      await updatePartnerTicketApprovalSettings(db, partnerA.id, { enabled: true, enforcement: 'hard', requestTtlHours: 24 });
      await updateOrgTicketApprovalSettings(db, orgA1.id, { enforcement: 'soft' });
    });
    let r = await withDbAccessContext(ctx, () => resolveTicketApprovalSettings(db, { partnerId: partnerA.id, orgId: orgA1.id }));
    expect(r.enabled).toEqual({ value: true, source: 'partner' });
    expect(r.enforcement).toEqual({ value: 'soft', source: 'org' });
    expect(r.requestTtlHours).toEqual({ value: 24, source: 'partner' });
    expect(r.budgetTrigger).toEqual({ value: true, source: 'default' });

    // PATCH { enforcement: null } clears the override; GET reports the partner value.
    await withDbAccessContext(ctx, () => updateOrgTicketApprovalSettings(db, orgA1.id, { enforcement: null }));
    r = await withDbAccessContext(ctx, () => resolveTicketApprovalSettings(db, { partnerId: partnerA.id, orgId: orgA1.id }));
    expect(r.enforcement).toEqual({ value: 'hard', source: 'partner' });

    // A second partner PATCH merges into the same row (upsert), not a new one.
    await withDbAccessContext(ctx, () => updatePartnerTicketApprovalSettings(db, partnerA.id, { afterHoursTrigger: false }));
    r = await withDbAccessContext(ctx, () => resolveTicketApprovalSettings(db, { partnerId: partnerA.id }));
    expect(r.afterHoursTrigger).toEqual({ value: false, source: 'partner' });
    expect(r.enforcement).toEqual({ value: 'hard', source: 'partner' });

    await trackAll(partnerA.id, [orgA1.id]);
  });

  it('an org-scoped session resolves its partner default (the SELECT branch is load-bearing)', async () => {
    const { partnerA, orgA1 } = await setup();
    await seedRow({ partnerId: partnerA.id, enabled: true });
    const r = await withDbAccessContext(orgContext(orgA1.id, partnerA.id), () =>
      resolveTicketApprovalSettings(db, { partnerId: partnerA.id, orgId: orgA1.id }));
    expect(r.enabled).toEqual({ value: true, source: 'partner' });
  });

  it("404s when the org is not the partner's", async () => {
    const { partnerB, orgA1 } = await setup();
    await expect(withDbAccessContext(SYSTEM_CTX, () =>
      resolveTicketApprovalSettings(db, { partnerId: partnerB.id, orgId: orgA1.id }))).rejects.toMatchObject({ status: 404 });
  });
});

describe('org merge of ticket_approval_settings (#4617, keep-survivor)', () => {
  it("drops the loser's override, keeps the survivor's, never touches the partner default", async () => {
    const { partnerA, orgA1: loser, orgA2: survivor } = await setup();
    const loserOnly = await createOrganization({ partnerId: partnerA.id });
    const survivorNoOverride = await createOrganization({ partnerId: partnerA.id });
    const partnerRow = await seedRow({ partnerId: partnerA.id, enforcement: 'hard' });
    const loserRow = await seedRow({ orgId: loser.id, enabled: true });
    const survivorRow = await seedRow({ orgId: survivor.id, enabled: false });
    const loserOnlyRow = await seedRow({ orgId: loserOnly.id, enforcement: 'soft' });
    const policy = getOrgMergePolicies().get('ticket_approval_settings')!;
    expect(policy).toEqual({ kind: 'keep-survivor' });

    const surviving = async () => (await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: ticketApprovalSettings.id }).from(ticketApprovalSettings)
        .where(inArray(ticketApprovalSettings.id, [partnerRow, loserRow, survivorRow, loserOnlyRow]))))
      .map((r) => r.id).sort();

    await withDbAccessContext(SYSTEM_CTX, async () => {
      for (const phase of ['resolve', 'move'] as const) {
        await runPolicy('ticket_approval_settings', policy, loser.id, survivor.id, phase);
        // A survivor with NO override does not adopt the loser's either.
        await runPolicy('ticket_approval_settings', policy, loserOnly.id, survivorNoOverride.id, phase);
      }
    });

    expect(await surviving()).toEqual([partnerRow, survivorRow].sort());
  });
});
