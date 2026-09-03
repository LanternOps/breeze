/**
 * #3205 W03 acceptance bar, real Postgres as breeze_app. Fixtures and billing
 * controls use system scope; every line update/remove uses tenant scope under
 * forced RLS, including the explicit cross-tenant denial proof.
 *
 * The headline is LINEAGE: editing a line in place leaves an already-generated
 * draft invoice issuable, where delete-and-re-add wedges it with SOURCE_NOT_FOUND
 * (invoiceService.ts:1194-1199). The delete path is the CONTROL in the same test,
 * so the fix is provably the thing being measured.
 *
 * The asymmetry matrix is asserted on BOTH sides. Three of its five cases the
 * database ACCEPTS — that is the point. Nobody may later "fix" one of these by
 * assuming a constraint that does not exist; if a wave wants those constraints,
 * that is a migration, not an assumption.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, deviceGroups, contracts, contractLines, invoiceLines } from '../../db/schema';
import {
  addContractLineToContract, updateContractLine, removeContractLine, getContract,
  generateDueInvoice, type ContractActorT,
} from '../../services/contractService';
import { issueInvoice } from '../../services/invoiceService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  actor: ContractActorT; partnerId: string; orgId: string; otherOrgId: string;
  siteId: string; otherSiteId: string; groupId: string; otherGroupId: string; contractId: string;
}

async function seed(status: 'draft' | 'active' | 'paused' | 'cancelled' = 'draft'): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `EP ${sfx}`, slug: `ep-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'EA', slug: `ea-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'EB', slug: `eb-${sfx}` },
    ]).returning({ id: organizations.id });
    const [sA] = await db.insert(sites).values({ orgId: oA!.id, name: `A-${sfx}` }).returning({ id: sites.id });
    const [sB] = await db.insert(sites).values({ orgId: oB!.id, name: `B-${sfx}` }).returning({ id: sites.id });
    const [gA] = await db.insert(deviceGroups).values({ orgId: oA!.id, name: `GA ${sfx}`, type: 'static' }).returning({ id: deviceGroups.id });
    const [gB] = await db.insert(deviceGroups).values({ orgId: oB!.id, name: `GB ${sfx}`, type: 'static' }).returning({ id: deviceGroups.id });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: oA!.id, name: `Edit ${sfx}`, status, intervalMonths: 1,
      startDate: '2026-07-01', nextBillingAt: '2026-07-01', currencyCode: 'USD', billingTiming: 'advance',
    }).returning({ id: contracts.id });
    return {
      actor: { userId: null as unknown as string, partnerId: p!.id, accessibleOrgIds: [oA!.id] },
      partnerId: p!.id, orgId: oA!.id, otherOrgId: oB!.id, siteId: sA!.id, otherSiteId: sB!.id,
      groupId: gA!.id, otherGroupId: gB!.id, contractId: c!.id,
    };
  });
}

const requestCtx = (f: Fixture, orgId = f.orgId) => ({
  scope: 'partner' as const,
  partnerId: f.partnerId,
  orgId: null,
  userId: null,
  accessibleOrgIds: [orgId],
  accessiblePartnerIds: [f.partnerId],
  currentPartnerId: f.partnerId,
});

/** Insert a line straight through SQL so the fixture is not bounded by the
 *  writer's own validation — the point of the matrix is what the DB does. */
async function rawLine(f: Fixture, cols: Record<string, unknown>): Promise<string> {
  const rows = await withSystemDbAccessContext(() => db.insert(contractLines).values({
    contractId: f.contractId, orgId: f.orgId, lineType: 'per_device', description: 'L',
    unitPrice: '10.00', taxable: false, ...cols,
  } as never).returning({ id: contractLines.id }));
  return rows[0]!.id;
}

function pgErrorFields(error: unknown): { code?: string; constraint?: string } {
  const wrapped = error as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } } | undefined;
  const node = wrapped?.cause ?? wrapped;
  return { code: node?.code, constraint: node?.constraint_name };
}

/** Forge the same row the service refused, as breeze_app, and report the verdict. */
async function forge(lineId: string, setSql: ReturnType<typeof sql>): Promise<{ code?: string; constraint?: string } | 'accepted'> {
  try {
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE contract_lines SET ${setSql} WHERE id = ${lineId}::uuid`));
    return 'accepted';
  } catch (err) {
    return pgErrorFields(err);
  }
}

describe('contract line editing (real DB) #3205 W03', () => {
  // ---- asymmetry matrix: app verdict AND database verdict, every case -------
  runDb('roles onto a per_device line: app 400, DB 23514 on contract_lines_device_roles_chk', async () => {
    const f = await seed();
    const id = await rawLine(f, {});
    await expect(withDbAccessContext(requestCtx(f), () => updateContractLine(f.contractId, id, { deviceRoles: ['server'] } as never, f.actor)))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400 });
    expect(await forge(id, sql`device_roles = ARRAY['server']::text[]`))
      .toEqual({ code: '23514', constraint: 'contract_lines_device_roles_chk' });
  });

  runDb('duplicate roles on a per_device_role line: app 400; clearing roles in DB is 23514', async () => {
    const f = await seed();
    const id = await rawLine(f, { lineType: 'per_device_role', deviceRoles: ['server'] });
    // deviceRoles is not nullable in the patch schema, so the app-side proof is
    // the merged-row rule reached through a sibling edit that cannot fix it.
    await expect(withDbAccessContext(requestCtx(f), () => updateContractLine(f.contractId, id, { deviceRoles: ['server', 'server'] } as never, f.actor)))
      .rejects.toMatchObject({ status: 400 });
    expect(await forge(id, sql`device_roles = NULL`))
      .toEqual({ code: '23514', constraint: 'contract_lines_device_roles_chk' });
  });

  runDb('a site_id onto a per_device_group line: app 400, DB 23514 on contract_lines_device_group_chk', async () => {
    const f = await seed();
    const id = await rawLine(f, { lineType: 'per_device_group', deviceGroupId: f.groupId, deviceGroupName: 'GA' });
    await expect(withDbAccessContext(requestCtx(f), () => updateContractLine(f.contractId, id, { siteId: f.siteId } as never, f.actor)))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400 });
    expect(await forge(id, sql`site_id = ${f.siteId}::uuid`))
      .toEqual({ code: '23514', constraint: 'contract_lines_device_group_chk' });
  });

  runDb('device_group_name cleared on a per_device_group line: DB 23514 on contract_lines_device_group_chk', async () => {
    const f = await seed();
    const id = await rawLine(f, { lineType: 'per_device_group', deviceGroupId: f.groupId, deviceGroupName: 'GA' });
    expect(await forge(id, sql`device_group_name = NULL`))
      .toEqual({ code: '23514', constraint: 'contract_lines_device_group_chk' });
  });

  // `<@` is CONTAINMENT, not set equality — the helper is the only guard.
  runDb('duplicate roles: app 400, DB ACCEPTS', async () => {
    const f = await seed();
    const id = await rawLine(f, { lineType: 'per_device_role', deviceRoles: ['server'] });
    await expect(withDbAccessContext(requestCtx(f), () => updateContractLine(f.contractId, id, { deviceRoles: ['server', 'server'] } as never, f.actor)))
      .rejects.toMatchObject({ status: 400 });
    expect(await forge(id, sql`device_roles = ARRAY['server','server']::text[]`)).toBe('accepted');
  });

  // There is NO CHECK on manual_quantity at all — the helper is the only guard.
  runDb('manualQuantity on a flat line: app 400, DB ACCEPTS', async () => {
    const f = await seed();
    const id = await rawLine(f, { lineType: 'flat' });
    await expect(withDbAccessContext(requestCtx(f), () => updateContractLine(f.contractId, id, { manualQuantity: '5.00' } as never, f.actor)))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400 });
    expect(await forge(id, sql`manual_quantity = 5.00`)).toBe('accepted');
  });

  // W02's CHECK forbids a site on per_device_group ONLY — the helper is the
  // only guard for flat / manual / per_seat.
  runDb('site_id on a flat line: app 400, DB ACCEPTS', async () => {
    const f = await seed();
    const id = await rawLine(f, { lineType: 'flat' });
    await expect(withDbAccessContext(requestCtx(f), () => updateContractLine(f.contractId, id, { siteId: f.siteId } as never, f.actor)))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400 });
    expect(await forge(id, sql`site_id = ${f.siteId}::uuid`)).toBe('accepted');
  });

  // ---- the orphaned-group repair (decision 7) ------------------------------
  runDb('re-points an orphaned group line at a live group and re-stamps the name; a foreign group is 400', async () => {
    const f = await seed();
    const id = await rawLine(f, { lineType: 'per_device_group', deviceGroupId: null, deviceGroupName: 'Retired group' });
    const [replacement] = await withSystemDbAccessContext(() => db.insert(deviceGroups)
      .values({ orgId: f.orgId, name: 'Replacement', type: 'static' }).returning({ id: deviceGroups.id }));
    const { line } = await withDbAccessContext(requestCtx(f), () => updateContractLine(f.contractId, id, { deviceGroupId: replacement!.id } as never, f.actor));
    expect(line).toMatchObject({ deviceGroupId: replacement!.id, deviceGroupName: 'Replacement' });
    await expect(withDbAccessContext(requestCtx(f), () => updateContractLine(f.contractId, id, { deviceGroupId: f.otherGroupId } as never, f.actor)))
      .rejects.toMatchObject({ code: 'GROUP_NOT_IN_ORG', status: 400 });
  });

  runDb('a site in another org is 400 SITE_NOT_IN_ORG', async () => {
    const f = await seed();
    const id = await rawLine(f, {});
    await expect(withDbAccessContext(requestCtx(f), () => updateContractLine(f.contractId, id, { siteId: f.otherSiteId } as never, f.actor)))
      .rejects.toMatchObject({ code: 'SITE_NOT_IN_ORG', status: 400 });
  });

  // ---- bounds never reach Postgres ----------------------------------------
  runDb('over-bounds unitPrice and sortOrder are rejected by the schema, so the service is never called', async () => {
    const { updateContractLineSchema } = await import('@breeze/shared');
    expect(updateContractLineSchema.safeParse({ unitPrice: '99999999999.00' }).success).toBe(false);
    expect(updateContractLineSchema.safeParse({ sortOrder: 2147483648 }).success).toBe(false);
    // And the value that IS in range round-trips through the column.
    const f = await seed();
    const id = await rawLine(f, {});
    const { line } = await withDbAccessContext(requestCtx(f), () => updateContractLine(f.contractId, id, { unitPrice: '9999999999.99', sortOrder: 2147483647 } as never, f.actor));
    expect(line).toMatchObject({ unitPrice: '9999999999.99', sortOrder: 2147483647 });
  });

  // ---- deterministic ordering ---------------------------------------------
  runDb('getContract returns equal sortOrder lines in (createdAt, id) order rather than heap order', async () => {
    const f = await seed();
    // Insert newest first so heap/insertion order is deliberately the opposite
    // of the createdAt tie-breaker required after the equal sortOrder.
    const newest = await rawLine(f, { description: 'newest', sortOrder: 0, createdAt: new Date('2026-07-03T00:00:00Z') });
    const oldest = await rawLine(f, { description: 'oldest', sortOrder: 0, createdAt: new Date('2026-07-01T00:00:00Z') });
    const middle = await rawLine(f, { description: 'middle', sortOrder: 0, createdAt: new Date('2026-07-02T00:00:00Z') });
    const result = await withSystemDbAccessContext(() => getContract(f.contractId, f.actor));
    expect(result.lines.map((l) => l.id)).toEqual([oldest, middle, newest]);
  });

  runDb('generateDueInvoice bills lines in (sortOrder, createdAt, id) order', async () => {
    const f = await seed('active');
    // As above, heap order starts newest-first and therefore differs from the
    // total order the billing query must use.
    const newest = await rawLine(f, { lineType: 'flat', description: 'newest', unitPrice: '1.00', sortOrder: 0, createdAt: new Date('2026-07-03T00:00:00Z') });
    const oldest = await rawLine(f, { lineType: 'flat', description: 'oldest', unitPrice: '1.00', sortOrder: 0, createdAt: new Date('2026-07-01T00:00:00Z') });
    const middle = await rawLine(f, { lineType: 'flat', description: 'middle', unitPrice: '1.00', sortOrder: 0, createdAt: new Date('2026-07-02T00:00:00Z') });
    const gen = await withSystemDbAccessContext(() => db.transaction(() => generateDueInvoice(f.contractId, new Date('2026-07-01T06:00:00Z'))));
    const rows = await withSystemDbAccessContext(() => db.select({ description: invoiceLines.description, sourceId: invoiceLines.sourceId })
      .from(invoiceLines).where(eq(invoiceLines.invoiceId, gen.invoiceId!)));
    expect(rows.map((r) => r.sourceId)).toEqual([oldest, middle, newest]);
  });

  // ---- LINEAGE (the headline) ---------------------------------------------
  runDb('editing a source line leaves the drafted invoice byte-identical and still issuable; delete-and-re-add wedges it', async () => {
    const f = await seed('active');
    const lineId = await rawLine(f, { lineType: 'flat', description: 'Monthly fee', unitPrice: '100.00' });
    const gen = await withSystemDbAccessContext(() => db.transaction(() => generateDueInvoice(f.contractId, new Date('2026-07-01T06:00:00Z'))));
    expect(gen.generated).toBe(true);
    const [beforeLine] = await withSystemDbAccessContext(() => db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, gen.invoiceId!)));

    await withDbAccessContext(requestCtx(f), () => updateContractLine(f.contractId, lineId, { unitPrice: '250.00', description: 'Renamed' } as never, f.actor));
    const [afterLine] = await withSystemDbAccessContext(() => db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, gen.invoiceId!)));
    expect(afterLine).toEqual(beforeLine);
    await expect(withSystemDbAccessContext(() => issueInvoice(gen.invoiceId!, {
      userId: null, partnerId: f.partnerId, accessibleOrgIds: [f.orgId],
    } as never))).resolves.toBeDefined();

    // CONTROL: the pre-W03 repair — delete and re-add — wedges the draft.
    const g2 = await seed('active');
    const lineId2 = await rawLine(g2, { lineType: 'flat', description: 'Monthly fee', unitPrice: '100.00' });
    const gen2 = await withSystemDbAccessContext(() => db.transaction(() => generateDueInvoice(g2.contractId, new Date('2026-07-01T06:00:00Z'))));
    await withDbAccessContext(requestCtx(g2), () => removeContractLine(g2.contractId, lineId2, g2.actor));
    await withSystemDbAccessContext(() => addContractLineToContract(g2.contractId, {
      lineType: 'flat', description: 'Monthly fee', unitPrice: '250.00', taxable: false,
    } as never, g2.actor));
    await expect(withSystemDbAccessContext(() => issueInvoice(gen2.invoiceId!, {
      userId: null, partnerId: g2.partnerId, accessibleOrgIds: [g2.orgId],
    } as never))).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND', status: 409 });
  });

  // ---- edit vs generation (decision 5) ------------------------------------
  runDb('an edit fired during generation waits for the contract lock; the invoice keeps the PRE-edit price', async () => {
    const f = await seed('active');
    const lineId = await rawLine(f, { lineType: 'flat', description: 'Monthly fee', unitPrice: '100.00' });
    // Both take contracts.id FOR UPDATE as their first statement, so they
    // serialise. The hold makes the interleaving observable, not the outcome.
    let generationLocked!: () => void;
    const lockHeld = new Promise<void>((resolve) => { generationLocked = resolve; });
    let releaseGeneration!: () => void;
    const holdGeneration = new Promise<void>((resolve) => { releaseGeneration = resolve; });
    const generation = withSystemDbAccessContext(() => db.transaction(async () => {
      const r = await generateDueInvoice(f.contractId, new Date('2026-07-01T06:00:00Z'));
      generationLocked();
      await holdGeneration;
      return r;
    }));
    // Race against generation so an early throw fails fast instead of hanging on lockHeld.
    await Promise.race([lockHeld, generation]);
    let editIssued!: () => void;
    const issued = new Promise<void>((resolve) => { editIssued = resolve; });
    const edit = withDbAccessContext(requestCtx(f), () => {
      editIssued();
      return updateContractLine(f.contractId, lineId, { unitPrice: '250.00' } as never, f.actor);
    });
    await issued;
    releaseGeneration();
    const [gen] = await Promise.all([generation, edit]);
    const [invLine] = await withSystemDbAccessContext(() => db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, gen.invoiceId!)));
    expect(invLine!.unitPrice).toBe('100.00');
    const [row] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.id, lineId)));
    expect(row!.unitPrice).toBe('250.00');
  });

  runDb('an edit that commits first is billed by the next generation', async () => {
    const f = await seed('active');
    const lineId = await rawLine(f, { lineType: 'flat', description: 'Monthly fee', unitPrice: '100.00' });
    await withDbAccessContext(requestCtx(f), () => updateContractLine(f.contractId, lineId, { unitPrice: '250.00' } as never, f.actor));
    const gen = await withSystemDbAccessContext(() => db.transaction(() => generateDueInvoice(f.contractId, new Date('2026-07-01T06:00:00Z'))));
    const [invLine] = await withSystemDbAccessContext(() => db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, gen.invoiceId!)));
    expect(invLine!.unitPrice).toBe('250.00');
  });

  // ---- edit vs edit: last-writer-wins, documented not accidental -----------
  runDb('concurrent patches to DIFFERENT fields both survive; sequential patches to the SAME field leave the later value', async () => {
    const f = await seed();
    const lineId = await rawLine(f, { lineType: 'flat', description: 'Original', unitPrice: '10.00' });
    await Promise.all([
      withDbAccessContext(requestCtx(f), () => updateContractLine(f.contractId, lineId, { description: 'Renamed' } as never, f.actor)),
      withDbAccessContext(requestCtx(f), () => updateContractLine(f.contractId, lineId, { unitPrice: '11.00' } as never, f.actor)),
    ]);
    const [both] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.id, lineId)));
    expect(both).toMatchObject({ description: 'Renamed', unitPrice: '11.00' });

    await withDbAccessContext(requestCtx(f), () => updateContractLine(f.contractId, lineId, { unitPrice: '20.00' } as never, f.actor));
    await withDbAccessContext(requestCtx(f), () => updateContractLine(f.contractId, lineId, { unitPrice: '30.00' } as never, f.actor));
    const [last] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.id, lineId)));
    expect(last!.unitPrice).toBe('30.00');
  });

  // ---- status and tenancy gates -------------------------------------------
  runDb.each(['paused', 'cancelled'] as const)('editing a line on a %s contract is 409 INVALID_STATE', async (status) => {
    const f = await seed();
    const lineId = await rawLine(f, {});
    await withSystemDbAccessContext(() => db.update(contracts).set({ status }).where(eq(contracts.id, f.contractId)));
    await expect(withDbAccessContext(requestCtx(f), () => updateContractLine(f.contractId, lineId, { description: 'x' } as never, f.actor)))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  runDb("the OTHER org's forced-RLS context cannot read or update the line", async () => {
    const f = await seed();
    const lineId = await rawLine(f, { description: 'Original' });
    const foreign: ContractActorT = { ...f.actor, accessibleOrgIds: [f.otherOrgId] };
    const visible = await withDbAccessContext(requestCtx(f, f.otherOrgId), () => db.select()
      .from(contractLines).where(eq(contractLines.id, lineId)));
    expect(visible).toEqual([]);
    const directlyUpdated = await withDbAccessContext(requestCtx(f, f.otherOrgId), () => db.update(contractLines)
      .set({ description: 'Hijacked directly' }).where(eq(contractLines.id, lineId)).returning({ id: contractLines.id }));
    expect(directlyUpdated).toEqual([]);
    await expect(withDbAccessContext(requestCtx(f, f.otherOrgId), () => updateContractLine(
      f.contractId, lineId, { description: 'Hijacked' } as never, foreign,
    ))).rejects.toMatchObject({ code: 'CONTRACT_NOT_FOUND', status: 404 });
    const [row] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.id, lineId)));
    expect(row!.description).toBe('Original');
  });

  runDb('DELETE for a line that does not exist is 404 LINE_NOT_FOUND', async () => {
    const f = await seed();
    await expect(withDbAccessContext(requestCtx(f), () => removeContractLine(f.contractId, '99999999-9999-4999-8999-999999999999', f.actor)))
      .rejects.toMatchObject({ code: 'LINE_NOT_FOUND', status: 404 });
  });
});
