import { pgTable, uuid, char, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { invoices } from './invoices';
// Reuse the bytea customType defined alongside users.ts (postgres.js maps bytea
// <-> Buffer). Defining it once keeps the driver mapping consistent across tables.
import { bytea } from './users';

// Generated invoice PDF artifacts. One row per invoice (unique on invoice_id),
// generate-once: issued invoices are immutable so the PDF never needs re-rendering.
// org_id is denormalized for RLS shape 1 (direct org_id) + backed by a composite
// FK (invoice_id, org_id) -> invoices(id, org_id) so the artifact's org can never
// drift from its parent invoice (mirrors the Phase-1 invoice_lines hardening).
export const invoiceDocuments = pgTable('invoice_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  pdf: bytea('pdf').notNull(),
  sha256: char('sha256', { length: 64 }).notNull(),
  generatedAt: timestamp('generated_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('invoice_documents_invoice_uq').on(t.invoiceId),
]);
