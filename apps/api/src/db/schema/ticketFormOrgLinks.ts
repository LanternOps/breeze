import { index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { ticketForms } from './ticketForms';

/**
 * Org allowlist for partner-wide ticket_forms (spec §5, epic #2135 follow-on).
 * No link rows for a form = visible to every org under the owning partner;
 * rows present = allowlist (only the linked orgs see the form). Only
 * meaningful for partner-wide forms (ticket_forms.org_id IS NULL); org-owned
 * forms never have links.
 *
 * FK-child of the dual-axis `ticket_forms` parent. This table's own `org_id`
 * column is the ALLOWLISTED org (arbitrary data), NOT the tenancy axis — RLS
 * reaches tenancy by joining through `ticket_forms` (system OR org-access OR
 * partner-access on the PARENT row), mirroring how
 * 2026-07-01-maintenance-windows-partner-ownership.sql re-issued the
 * maintenance_occurrences FK-child policy. See
 * 2026-07-11-ticket-form-org-links.sql for the policy definition.
 */
export const ticketFormOrgLinks = pgTable(
  'ticket_form_org_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    formId: uuid('form_id').notNull().references(() => ticketForms.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull()
  },
  (t) => [
    uniqueIndex('ticket_form_org_links_form_org_uq').on(t.formId, t.orgId),
    index('ticket_form_org_links_form_id_idx').on(t.formId),
    index('ticket_form_org_links_org_id_idx').on(t.orgId)
  ]
);
