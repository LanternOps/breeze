/**
 * #3205 W07 (#4656) Task 5 — reissue clones billing evidence through a
 * pre-generated old->new invoice_line id map.
 *
 * NOTE ON PROVENANCE: this file did not exist before this task. The plan
 * brief instructed "Modify" (append the `describe` block below to an
 * existing file), but no earlier task in this wave created it — the void /
 * reissue plumbing predates W07 and its own coverage lives in
 * `multiCurrencyWave6VoidReissue.integration.test.ts`, which never touches
 * billing evidence. This file — including every seed fixture below — was
 * authored fresh for this task, modeled on the seeding conventions in
 * `billingEvidence.integration.test.ts` (ACTOR shape, direct-insert org/device
 * seeding) and the void/reissue call conventions in
 * `multiCurrencyWave6VoidReissue.integration.test.ts` (voidInvoice/getInvoice
 * both need an active DB access context, so every call is wrapped in
 * withSystemDbAccessContext — the brief's snippets called voidInvoice bare,
 * which would throw when the post-transaction getInvoice() ran with no
 * context). The brief's test bodies are reproduced verbatim except for two
 * mechanical fixes: voidInvoice's real signature is 4 args — (id, reason,
 * opts, actor), not (id, {reason, ...opts}, actor) — and the context wrap.
 *
 * Runs under vitest.integration.config.ts against a real Postgres.
 * integration/setup.ts TRUNCATEs core tenant tables before every test.
 */
import './setup';

import { describe, expect, it, vi } from 'vitest';
import { and, eq, isNotNull } from 'drizzle-orm';

// Fire-and-forget BullMQ side effects are not the correctness under test (same
// rationale as multiCurrencyWave6VoidReissue.integration.test.ts).
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { db, withSystemDbAccessContext } from '../../db';
import {
  devices, invoiceLineDevices, invoiceLines, invoices, organizations, partners, sites,
} from '../../db/schema';
import { voidInvoice } from '../../services/invoiceService';
import type { InvoiceActor } from '../../services/invoiceTypes';

const RUN = !!process.env.DATABASE_URL;
const runDb = it.runIf(RUN);

/** Unrestricted actor — same shape billingEvidence.integration.test.ts uses
 *  for the draft-line writers that are not request-scoped. */
const ACTOR: InvoiceActor = { userId: null, partnerId: null, accessibleOrgIds: null };

interface OrgFixture { partnerId: string; orgId: string; siteId: string }

async function seedOrg(): Promise<OrgFixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `RI ${sfx}`, slug: `ri-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ currencyCode: 'USD', partnerId: p!.id, name: `RI Org ${sfx}`, slug: `ri-org-${sfx}` })
      .returning({ id: organizations.id });
    const [s] = await db.insert(sites).values({ orgId: o!.id, name: `RI Site ${sfx}` }).returning({ id: sites.id });
    return { partnerId: p!.id, orgId: o!.id, siteId: s!.id };
  });
}

async function seedDevices(orgId: string, siteId: string, hostnames: string[]) {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    return db.insert(devices).values(hostnames.map((h, i) => ({
      orgId, siteId, agentId: `agent-${sfx}-${i}`, hostname: h,
      status: 'online' as const, deviceRole: 'server' as const, osType: 'linux' as const, osVersion: '22.04',
      architecture: 'x86_64', agentVersion: '1.0.0',
    }))).returning({ id: devices.id, hostname: devices.hostname });
  });
}

/** An ISSUED (non-draft) invoice, one line, N evidence rows behind REAL device
 *  rows — the shape voidInvoice(reissue) needs, and the shape the "detached"
 *  test needs to start from (a real deviceId it then nulls out). */
async function seedInvoiceWithEvidence() {
  const org = await seedOrg();
  const hostnames = ['ev-a', 'ev-b', 'ev-c'];
  const devs = await seedDevices(org.orgId, org.siteId, hostnames);
  return withSystemDbAccessContext(async () => {
    const [inv] = await db.insert(invoices).values({
      partnerId: org.partnerId, orgId: org.orgId, siteId: org.siteId, status: 'sent',
      invoiceNumber: `INV-RI-${Math.random().toString(36).slice(2, 8)}`, currencyCode: 'USD', evidenceVersion: 1,
    }).returning({ id: invoices.id });
    const [line] = await db.insert(invoiceLines).values({
      invoiceId: inv!.id, orgId: org.orgId, sourceType: 'manual', name: 'Endpoints',
      description: 'Endpoints', quantity: '3', unitPrice: '10.00', taxable: false,
      customerVisible: true, lineTotal: '30.00', sortOrder: 0,
    }).returning({ id: invoiceLines.id });
    await db.insert(invoiceLineDevices).values(devs.map((d) => ({
      invoiceLineId: line!.id, invoiceId: inv!.id, orgId: org.orgId,
      deviceId: d.id, hostname: d.hostname, deviceRole: 'server', siteId: org.siteId,
      countedAs: 'included' as const,
    })));
    return { invoiceId: inv!.id, orgId: org.orgId, hostnames };
  });
}

/** Three parent lines with disjoint hostname sets ('a-*'/'b-*'/'c-*'), each
 *  line's description matching `Line <LETTER>` so a reordered clone produces
 *  visibly wrong attribution instead of a silent one. */
async function seedInvoiceWithThreeEvidencedLines() {
  const org = await seedOrg();
  return withSystemDbAccessContext(async () => {
    const [inv] = await db.insert(invoices).values({
      partnerId: org.partnerId, orgId: org.orgId, siteId: org.siteId, status: 'sent',
      invoiceNumber: `INV-RI-${Math.random().toString(36).slice(2, 8)}`, currencyCode: 'USD', evidenceVersion: 1,
    }).returning({ id: invoices.id });
    for (const [i, letter] of (['a', 'b', 'c'] as const).entries()) {
      const [line] = await db.insert(invoiceLines).values({
        invoiceId: inv!.id, orgId: org.orgId, sourceType: 'manual',
        name: `Line ${letter.toUpperCase()}`, description: `Line ${letter.toUpperCase()}`,
        quantity: '3', unitPrice: '10.00', taxable: false, customerVisible: true,
        lineTotal: '30.00', sortOrder: i,
      }).returning({ id: invoiceLines.id });
      await db.insert(invoiceLineDevices).values([0, 1, 2].map((n) => ({
        invoiceLineId: line!.id, invoiceId: inv!.id, orgId: org.orgId,
        deviceId: null, hostname: `${letter}-${n}`, deviceRole: 'server',
        siteId: org.siteId, countedAs: 'included' as const,
      })));
    }
    return { invoiceId: inv!.id, orgId: org.orgId };
  });
}

/** A bundle parent + one child; evidence lives ONLY on the child. */
async function seedInvoiceWithBundleChildEvidence() {
  const org = await seedOrg();
  return withSystemDbAccessContext(async () => {
    const [inv] = await db.insert(invoices).values({
      partnerId: org.partnerId, orgId: org.orgId, siteId: org.siteId, status: 'sent',
      invoiceNumber: `INV-RI-${Math.random().toString(36).slice(2, 8)}`, currencyCode: 'USD', evidenceVersion: 1,
    }).returning({ id: invoices.id });
    const [parent] = await db.insert(invoiceLines).values({
      invoiceId: inv!.id, orgId: org.orgId, sourceType: 'manual', name: 'Bundle',
      description: 'Bundle', quantity: '1', unitPrice: '0.00', taxable: false,
      customerVisible: true, lineTotal: '0.00', sortOrder: 0,
    }).returning({ id: invoiceLines.id });
    const [child] = await db.insert(invoiceLines).values({
      invoiceId: inv!.id, orgId: org.orgId, sourceType: 'manual', parentLineId: parent!.id,
      name: 'Bundle Component', description: 'Bundle Component', quantity: '2', unitPrice: '10.00',
      taxable: false, customerVisible: true, lineTotal: '20.00', sortOrder: 1,
    }).returning({ id: invoiceLines.id });
    // Exactly ONE evidence row: the assertion below checks the clone's evidence
    // rows map to a single-element array containing the remapped child's id.
    await db.insert(invoiceLineDevices).values({
      invoiceLineId: child!.id, invoiceId: inv!.id, orgId: org.orgId,
      deviceId: null, hostname: 'bc-0', deviceRole: 'server', siteId: org.siteId,
      countedAs: 'included' as const,
    });
    return { invoiceId: inv!.id, orgId: org.orgId };
  });
}

/** A child line whose parentLineId points at a REAL invoice_lines row (the
 *  self-FK requires that) that belongs to a DIFFERENT, unrelated invoice — so
 *  it is genuinely absent from THIS invoice's own srcLines/oldToNew map. */
async function seedInvoiceWithOrphanedChild() {
  const org = await seedOrg();
  return withSystemDbAccessContext(async () => {
    const [decoyInv] = await db.insert(invoices).values({
      partnerId: org.partnerId, orgId: org.orgId, siteId: org.siteId, status: 'sent',
      invoiceNumber: `INV-RI-DECOY-${Math.random().toString(36).slice(2, 8)}`, currencyCode: 'USD',
    }).returning({ id: invoices.id });
    const [decoyLine] = await db.insert(invoiceLines).values({
      invoiceId: decoyInv!.id, orgId: org.orgId, sourceType: 'manual', name: 'Decoy',
      description: 'Decoy', quantity: '1', unitPrice: '1.00', taxable: false,
      customerVisible: true, lineTotal: '1.00', sortOrder: 0,
    }).returning({ id: invoiceLines.id });

    const [inv] = await db.insert(invoices).values({
      partnerId: org.partnerId, orgId: org.orgId, siteId: org.siteId, status: 'sent',
      invoiceNumber: `INV-RI-${Math.random().toString(36).slice(2, 8)}`, currencyCode: 'USD',
    }).returning({ id: invoices.id });
    await db.insert(invoiceLines).values({
      invoiceId: inv!.id, orgId: org.orgId, sourceType: 'manual', parentLineId: decoyLine!.id,
      name: 'Orphaned Child', description: 'Orphaned Child', quantity: '1', unitPrice: '5.00',
      taxable: false, customerVisible: true, lineTotal: '5.00', sortOrder: 0,
    });
    return { invoiceId: inv!.id, orgId: org.orgId };
  });
}

async function evidenceRowsFor(invoiceId: string) {
  return withSystemDbAccessContext(() => db
    .select({
      id: invoiceLineDevices.id, invoiceLineId: invoiceLineDevices.invoiceLineId,
      invoiceId: invoiceLineDevices.invoiceId, orgId: invoiceLineDevices.orgId,
      deviceId: invoiceLineDevices.deviceId, hostname: invoiceLineDevices.hostname,
      deviceRole: invoiceLineDevices.deviceRole, siteId: invoiceLineDevices.siteId,
      countedAs: invoiceLineDevices.countedAs,
    })
    .from(invoiceLineDevices).where(eq(invoiceLineDevices.invoiceId, invoiceId))
    .orderBy(invoiceLineDevices.hostname, invoiceLineDevices.id));
}

describe.runIf(RUN)('reissue clones billing evidence (#3205 W07)', () => {
  runDb('clones every evidence field row-for-row while remapping invoice and line ids', async () => {
    const f = await seedInvoiceWithEvidence();
    const sourceRows = await evidenceRowsFor(f.invoiceId);
    const [sourceLine] = await withSystemDbAccessContext(() => db
      .select({ id: invoiceLines.id, description: invoiceLines.description })
      .from(invoiceLines).where(eq(invoiceLines.invoiceId, f.invoiceId)));

    const draft = await withSystemDbAccessContext(() => voidInvoice(f.invoiceId, 'test', { reissue: true }, ACTOR));
    const clonedRows = await evidenceRowsFor(draft.invoice.id);
    const [clonedLine] = await withSystemDbAccessContext(() => db
      .select({ id: invoiceLines.id, description: invoiceLines.description })
      .from(invoiceLines).where(eq(invoiceLines.invoiceId, draft.invoice.id)));

    expect(clonedLine!.description).toBe(sourceLine!.description);
    expect(clonedLine!.id).not.toBe(sourceLine!.id);
    expect(clonedRows).toHaveLength(sourceRows.length);
    expect(clonedRows.map(({ id: _id, invoiceId: _invoiceId, invoiceLineId: _lineId, ...fields }) => fields))
      .toEqual(sourceRows.map(({ id: _id, invoiceId: _invoiceId, invoiceLineId: _lineId, ...fields }) => fields));
    expect(clonedRows.every((row) => row.invoiceId === draft.invoice.id && row.invoiceLineId === clonedLine!.id)).toBe(true);
  });

  runDb('every evidence row lands under the line that matches its hostnames — three parents, distinguishable sets', async () => {
    // Ordering-independence, asserted directly: the old clone built oldToNew
    // POSITIONALLY from RETURNING, which SQL does not promise to return in input
    // order. Three parents with disjoint hostname sets makes a reordered
    // RETURNING produce visibly wrong attribution instead of a silent one.
    const f = await seedInvoiceWithThreeEvidencedLines();   // 'a-*', 'b-*', 'c-*' per line
    const draft = await withSystemDbAccessContext(() => voidInvoice(f.invoiceId, 'test', { reissue: true }, ACTOR));
    const rows = await withSystemDbAccessContext(() => db
      .select({ lineId: invoiceLineDevices.invoiceLineId, hostname: invoiceLineDevices.hostname,
                invoiceId: invoiceLineDevices.invoiceId, countedAs: invoiceLineDevices.countedAs })
      .from(invoiceLineDevices).where(eq(invoiceLineDevices.invoiceId, draft.invoice.id)));
    const newLines = await withSystemDbAccessContext(() => db
      .select({ id: invoiceLines.id, description: invoiceLines.description })
      .from(invoiceLines).where(eq(invoiceLines.invoiceId, draft.invoice.id)));
    const descOf = new Map(newLines.map((l) => [l.id, l.description]));
    for (const r of rows) {
      expect(descOf.get(r.lineId)).toBe(`Line ${r.hostname[0]!.toUpperCase()}`);
      expect(r.invoiceId).toBe(draft.invoice.id);
    }
    expect(rows).toHaveLength(9);
  });

  runDb('the voided invoice keeps its own evidence rows unchanged', async () => {
    const f = await seedInvoiceWithThreeEvidencedLines();
    const before = await evidenceRowsFor(f.invoiceId);
    await withSystemDbAccessContext(() => voidInvoice(f.invoiceId, 'test', { reissue: true }, ACTOR));
    expect(await evidenceRowsFor(f.invoiceId)).toEqual(before);
  });

  runDb('a bundle CHILD line carrying evidence clones too, under the remapped child', async () => {
    const f = await seedInvoiceWithBundleChildEvidence();
    const draft = await withSystemDbAccessContext(() => voidInvoice(f.invoiceId, 'test', { reissue: true }, ACTOR));
    const child = await withSystemDbAccessContext(() => db.select({ id: invoiceLines.id })
      .from(invoiceLines).where(and(eq(invoiceLines.invoiceId, draft.invoice.id), isNotNull(invoiceLines.parentLineId))));
    const rows = await evidenceRowsFor(draft.invoice.id);
    expect(rows.map((r) => r.invoiceLineId)).toEqual([child[0]!.id]);
  });

  runDb('a DETACHED source row clones as detached, hostname intact — never resurrected', async () => {
    const f = await seedInvoiceWithEvidence();
    await withSystemDbAccessContext(() => db.update(invoiceLineDevices)
      .set({ deviceId: null }).where(eq(invoiceLineDevices.invoiceId, f.invoiceId)));
    const draft = await withSystemDbAccessContext(() => voidInvoice(f.invoiceId, 'test', { reissue: true }, ACTOR));
    const rows = await evidenceRowsFor(draft.invoice.id);
    expect(rows.every((r) => r.deviceId === null)).toBe(true);
    expect(rows.map((r) => r.hostname).sort()).toEqual(f.hostnames.slice().sort());
  });

  runDb('evidence_version is copied so the clone does not read as a pre-W07 invoice', async () => {
    const f = await seedInvoiceWithEvidence();      // evidence_version = 1
    const draft = await withSystemDbAccessContext(() => voidInvoice(f.invoiceId, 'test', { reissue: true }, ACTOR));
    expect(draft.invoice.evidenceVersion).toBe(1);
  });

  runDb('void WITHOUT reissue clones nothing', async () => {
    const f = await seedInvoiceWithEvidence();
    await withSystemDbAccessContext(() => voidInvoice(f.invoiceId, 'test', { reissue: false }, ACTOR));
    const all = await withSystemDbAccessContext(() => db.select().from(invoiceLineDevices));
    expect(all.map((r) => r.invoiceId)).toEqual(new Array(all.length).fill(f.invoiceId));
  });

  runDb('a child line whose parent is absent from the map THROWS rather than cloning as top-level', async () => {
    // Forge the condition the old `?? null` swallowed: a child whose parent row
    // is not among srcLines. The clone must fail loudly.
    const f = await seedInvoiceWithOrphanedChild();
    await expect(withSystemDbAccessContext(() => voidInvoice(f.invoiceId, 'test', { reissue: true }, ACTOR)))
      .rejects.toThrow(/Reissue clone: no mapping for line/);
  });
});
