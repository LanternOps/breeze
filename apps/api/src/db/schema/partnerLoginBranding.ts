import { pgTable, uuid, varchar, text, timestamp } from 'drizzle-orm/pg-core';
import { partners } from './orgs';

// Login-page branding for the MSP's OWN technician login (#2183). Deliberately
// partner-only (no org axis): org/customer login branding already exists as
// portal_branding. One row per partner (PK = partner_id). RLS shape 3:
// breeze_has_partner_access(partner_id), FORCE — see the 2026-07-03 migration.
// NOT the same feature as the "Partner Branding" inheritable org-defaults tab.
export const partnerLoginBranding = pgTable('partner_login_branding', {
  partnerId: uuid('partner_id').primaryKey().references(() => partners.id, { onDelete: 'cascade' }),
  logoUrl: text('logo_url'),
  accentColor: varchar('accent_color', { length: 7 }),
  headline: varchar('headline', { length: 120 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
