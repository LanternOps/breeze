import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  invoiceLines,
  invoices,
  ticketParts,
  tickets,
  timeEntries,
} from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-10-15-160150-repair-orphan-billed-sources.sql',
);

async function applyMigration(): Promise<string[]> {
  const notices: string[] = [];
  const client = postgres(process.env.DATABASE_URL_APP!, {
    max: 1,
    onnotice: (notice) => notices.push(String(notice.message ?? '')),
  });
  try {
    await client.unsafe(readFileSync(MIGRATION_FILE, 'utf8'));
  } finally {
    await client.end();
  }
  return notices;
}

describe.runIf(!!process.env.DATABASE_URL && !!process.env.DATABASE_URL_APP)(
  'orphan billed-source lineage migration',
  () => {
    it('repairs only unlined or void-lined sources as breeze_app and is idempotent', async () => {
      const db = getTestDb();
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const user = await createUser({ partnerId: partner.id, orgId: org.id });
      const suffix = Math.random().toString(36).slice(2, 10);
      const [ticket] = await db.insert(tickets).values({
        partnerId: partner.id,
        orgId: org.id,
        ticketNumber: `BILLED-LINEAGE-${suffix}`,
        subject: 'Billed source lineage fixture',
        source: 'manual',
      }).returning({ id: tickets.id });

      const entryRows = await db.insert(timeEntries).values([
        {
          partnerId: partner.id,
          orgId: org.id,
          ticketId: ticket!.id,
          userId: user.id,
          startedAt: new Date('2026-09-01T09:00:00Z'),
          endedAt: new Date('2026-09-01T10:00:00Z'),
          currencyCode: 'USD',
          billingStatus: 'billed',
        },
        {
          partnerId: partner.id,
          orgId: org.id,
          ticketId: ticket!.id,
          userId: user.id,
          startedAt: new Date('2026-09-01T10:00:00Z'),
          endedAt: new Date('2026-09-01T11:00:00Z'),
          currencyCode: 'USD',
          billingStatus: 'billed',
        },
      ]).returning({ id: timeEntries.id });
      const [orphanEntry, issuedEntry] = entryRows;

      const partRows = await db.insert(ticketParts).values([
        {
          ticketId: ticket!.id,
          orgId: org.id,
          description: 'Void-lined part',
          quantity: '1.00',
          unitPrice: '25.00',
          currencyCode: 'USD',
          billingStatus: 'billed',
        },
        {
          ticketId: ticket!.id,
          orgId: org.id,
          description: 'Issued part',
          quantity: '1.00',
          unitPrice: '30.00',
          currencyCode: 'USD',
          billingStatus: 'billed',
        },
      ]).returning({ id: ticketParts.id });
      const [voidPart, issuedPart] = partRows;

      const invoiceRows = await db.insert(invoices).values([
        {
          partnerId: partner.id,
          orgId: org.id,
          currencyCode: 'USD',
          status: 'sent',
          invoiceNumber: `LINEAGE-SENT-${suffix}`,
        },
        {
          partnerId: partner.id,
          orgId: org.id,
          currencyCode: 'USD',
          status: 'void',
          invoiceNumber: `LINEAGE-VOID-${suffix}`,
        },
      ]).returning({ id: invoices.id });
      const [sentInvoice, voidInvoice] = invoiceRows;

      await db.insert(invoiceLines).values([
        {
          invoiceId: sentInvoice!.id,
          orgId: org.id,
          sourceType: 'time_entry',
          sourceId: issuedEntry!.id,
          description: 'Issued labor',
          quantity: '1.00',
          unitPrice: '100.00',
          lineTotal: '100.00',
        },
        {
          invoiceId: sentInvoice!.id,
          orgId: org.id,
          sourceType: 'part',
          sourceId: issuedPart!.id,
          description: 'Issued part',
          quantity: '1.00',
          unitPrice: '30.00',
          lineTotal: '30.00',
        },
        {
          invoiceId: voidInvoice!.id,
          orgId: org.id,
          sourceType: 'part',
          sourceId: voidPart!.id,
          description: 'Voided part',
          quantity: '1.00',
          unitPrice: '25.00',
          lineTotal: '25.00',
        },
      ]);

      const first = await applyMigration();
      expect(first.some((n) => n.includes('reset 1 time_entries row(s)'))).toBe(true);
      expect(first.some((n) => n.includes('reset 1 ticket_parts row(s)'))).toBe(true);
      // Forensic trail: the reset is irreversible, so the WARNING must name the
      // rows it touched — a bare count cannot be reconciled after the fact.
      expect(first.some((n) => n.includes('time_entries') && n.includes(orphanEntry!.id))).toBe(true);
      expect(first.some((n) => n.includes('ticket_parts') && n.includes(voidPart!.id))).toBe(true);
      expect(first.some((n) => n.includes('time_entries') && n.includes(issuedEntry!.id))).toBe(false);

      const entries = await db.select({ id: timeEntries.id, status: timeEntries.billingStatus }).from(timeEntries);
      const parts = await db.select({ id: ticketParts.id, status: ticketParts.billingStatus }).from(ticketParts);
      const entryStatuses = new Map(entries.map((row) => [row.id, row.status]));
      const partStatuses = new Map(parts.map((row) => [row.id, row.status]));
      expect(entryStatuses.get(orphanEntry!.id)).toBe('not_billed');
      expect(entryStatuses.get(issuedEntry!.id)).toBe('billed');
      expect(partStatuses.get(voidPart!.id)).toBe('not_billed');
      expect(partStatuses.get(issuedPart!.id)).toBe('billed');

      const second = await applyMigration();
      expect(second.some((n) => n.includes('reset 0 time_entries row(s)'))).toBe(true);
      expect(second.some((n) => n.includes('reset 0 ticket_parts row(s)'))).toBe(true);
    });

    /**
     * Regression for the org-conjunct blocker. `moveTicketOrg` re-stamps
     * time_entries/ticket_parts by ticket_id with no billing_status filter,
     * while invoice_lines/invoices are deliberately excluded from that rewrite
     * (issued billing history keeps the org that was billed). So a genuinely
     * invoiced source can legitimately sit under a DIFFERENT org than its
     * invoice line. A lineage predicate that joined on org_id would call that
     * orphaned and hand the work back to invoiceAssembly to bill twice.
     */
    it('preserves a billed source whose issued invoice line sits under a different org (moved ticket)', async () => {
      const db = getTestDb();
      const partner = await createPartner();
      const billedOrg = await createOrganization({ partnerId: partner.id });
      const movedOrg = await createOrganization({ partnerId: partner.id });
      const user = await createUser({ partnerId: partner.id, orgId: movedOrg.id });
      const suffix = Math.random().toString(36).slice(2, 10);
      const [ticket] = await db.insert(tickets).values({
        partnerId: partner.id,
        orgId: movedOrg.id,
        ticketNumber: `BILLED-MOVED-${suffix}`,
        subject: 'Ticket moved after being invoiced',
        source: 'manual',
      }).returning({ id: tickets.id });

      // Post-move state: sources carry the DESTINATION org, the invoice and its
      // lines still carry the org that was actually billed.
      const [movedEntry] = await db.insert(timeEntries).values({
        partnerId: partner.id,
        orgId: movedOrg.id,
        ticketId: ticket!.id,
        userId: user.id,
        startedAt: new Date('2026-09-02T09:00:00Z'),
        endedAt: new Date('2026-09-02T10:00:00Z'),
        currencyCode: 'USD',
        billingStatus: 'billed',
      }).returning({ id: timeEntries.id });

      const [movedPart] = await db.insert(ticketParts).values({
        ticketId: ticket!.id,
        orgId: movedOrg.id,
        description: 'Invoiced part on a moved ticket',
        quantity: '1.00',
        unitPrice: '40.00',
        currencyCode: 'USD',
        billingStatus: 'billed',
      }).returning({ id: ticketParts.id });

      const [sentInvoice] = await db.insert(invoices).values({
        partnerId: partner.id,
        orgId: billedOrg.id,
        currencyCode: 'USD',
        status: 'sent',
        invoiceNumber: `LINEAGE-MOVED-${suffix}`,
      }).returning({ id: invoices.id });

      await db.insert(invoiceLines).values([
        {
          invoiceId: sentInvoice!.id,
          orgId: billedOrg.id,
          sourceType: 'time_entry',
          sourceId: movedEntry!.id,
          description: 'Issued labor, ticket since moved',
          quantity: '1.00',
          unitPrice: '100.00',
          lineTotal: '100.00',
        },
        {
          invoiceId: sentInvoice!.id,
          orgId: billedOrg.id,
          sourceType: 'part',
          sourceId: movedPart!.id,
          description: 'Issued part, ticket since moved',
          quantity: '1.00',
          unitPrice: '40.00',
          lineTotal: '40.00',
        },
      ]);

      const notices = await applyMigration();
      expect(notices.some((n) => n.includes('reset 0 time_entries row(s)'))).toBe(true);
      expect(notices.some((n) => n.includes('reset 0 ticket_parts row(s)'))).toBe(true);

      const [entry] = await db.select({ status: timeEntries.billingStatus }).from(timeEntries);
      const [part] = await db.select({ status: ticketParts.billingStatus }).from(ticketParts);
      expect(entry?.status).toBe('billed');
      expect(part?.status).toBe('billed');
    });

    /**
     * `draft` is not a preserved status: issueInvoice is the only writer of
     * `billed` and sets status='sent' in the same transaction, so billed + draft
     * is only reachable by forgery — and leaving it billed would wedge the draft
     * forever on SOURCE_ALREADY_BILLED.
     */
    it('resets a billed source whose only invoice line sits on a draft invoice', async () => {
      const db = getTestDb();
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const user = await createUser({ partnerId: partner.id, orgId: org.id });
      const suffix = Math.random().toString(36).slice(2, 10);
      const [ticket] = await db.insert(tickets).values({
        partnerId: partner.id,
        orgId: org.id,
        ticketNumber: `BILLED-DRAFT-${suffix}`,
        subject: 'Forged billed source on a draft invoice',
        source: 'manual',
      }).returning({ id: tickets.id });

      const [draftEntry] = await db.insert(timeEntries).values({
        partnerId: partner.id,
        orgId: org.id,
        ticketId: ticket!.id,
        userId: user.id,
        startedAt: new Date('2026-09-03T09:00:00Z'),
        endedAt: new Date('2026-09-03T10:00:00Z'),
        currencyCode: 'USD',
        billingStatus: 'billed',
      }).returning({ id: timeEntries.id });

      const [draftPart] = await db.insert(ticketParts).values({
        ticketId: ticket!.id,
        orgId: org.id,
        description: 'Part on a draft invoice',
        quantity: '1.00',
        unitPrice: '15.00',
        currencyCode: 'USD',
        billingStatus: 'billed',
      }).returning({ id: ticketParts.id });

      const [draftInvoice] = await db.insert(invoices).values({
        partnerId: partner.id,
        orgId: org.id,
        currencyCode: 'USD',
        status: 'draft',
        invoiceNumber: `LINEAGE-DRAFT-${suffix}`,
      }).returning({ id: invoices.id });

      await db.insert(invoiceLines).values([
        {
          invoiceId: draftInvoice!.id,
          orgId: org.id,
          sourceType: 'time_entry',
          sourceId: draftEntry!.id,
          description: 'Draft labor',
          quantity: '1.00',
          unitPrice: '100.00',
          lineTotal: '100.00',
        },
        {
          invoiceId: draftInvoice!.id,
          orgId: org.id,
          sourceType: 'part',
          sourceId: draftPart!.id,
          description: 'Draft part',
          quantity: '1.00',
          unitPrice: '15.00',
          lineTotal: '15.00',
        },
      ]);

      const notices = await applyMigration();
      expect(notices.some((n) => n.includes('reset 1 time_entries row(s)'))).toBe(true);
      expect(notices.some((n) => n.includes('reset 1 ticket_parts row(s)'))).toBe(true);
      expect(notices.some((n) => n.includes('time_entries') && n.includes(draftEntry!.id))).toBe(true);

      const [entry] = await db.select({ status: timeEntries.billingStatus }).from(timeEntries);
      const [part] = await db.select({ status: ticketParts.billingStatus }).from(ticketParts);
      expect(entry?.status).toBe('not_billed');
      expect(part?.status).toBe('not_billed');
    });
  },
);
