import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { organizations, sites, enrollmentKeys } from "./orgs";
import { users } from "./users";

/**
 * Single-use, short-TTL token issued at installer-download time. The token
 * is delivered inside the macOS installer zip payload and exchanged for
 * enrollment values on first launch via POST `/api/v1/installer/bootstrap`.
 * Legacy raw enrollment-key query tokens are not accepted by public installer
 * downloads; callers must use the short-lived handle flow.
 *
 * Stored as plain text (not hashed) intentionally: tokens are ephemeral
 * (24h max), single-use, and hashing adds ceremony without a meaningful
 * security win for this lifetime. Compare by equality.
 */
export const installerBootstrapTokens = pgTable(
  "installer_bootstrap_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: text("token").notNull().unique(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    parentEnrollmentKeyId: uuid("parent_enrollment_key_id")
      .notNull()
      .references(() => enrollmentKeys.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").references(() => sites.id, {
      onDelete: "set null",
    }),
    /** Must be >= 1; enforced by DB CHECK installer_bootstrap_tokens_max_usage_positive */
    maxUsage: integer("max_usage").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Must be strictly after created_at; enforced by DB CHECK installer_bootstrap_tokens_expires_after_created */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedFromIp: text("consumed_from_ip"),
  },
  (t) => ({
    expiresIdx: index("idx_installer_bootstrap_tokens_expires").on(t.expiresAt),
  }),
);
