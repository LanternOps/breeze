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
  },
);
