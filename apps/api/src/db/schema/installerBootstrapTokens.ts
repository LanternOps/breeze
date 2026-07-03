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
 * Short-TTL token issued at installer-download time, redeemable up to
 * max_usage times (once per device that installs the same downloaded
 * installer — see consumed_count). The token is delivered inside the platform
 * installer (macOS zip payload, or embedded in the Windows MSI download
 * filename) and exchanged for enrollment values on first launch via POST
 * `/api/v1/installer/bootstrap`. Legacy raw enrollment-key query tokens are
 * not accepted by public installer downloads; callers must use the
 * short-lived handle flow.
 *
 * Stored as plain text (not hashed) intentionally: tokens are ephemeral
 * (24h max) and hashing adds ceremony without a meaningful security win for
 * this lifetime. Compare by equality. Note a leaked token is worth up to
 * max_usage enrollments, so keep the TTL short and the max_usage bounded.
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
    /**
     * Redemptions so far. The token is spendable while consumed_count <
     * max_usage; each redemption mints one fresh single-use child enrollment
     * key. Gating on this (not the consumed_at boolean) is what lets one
     * downloaded installer with a device-limit of N enroll N devices (#2161).
     */
    consumedCount: integer("consumed_count").notNull().default(0),
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
    installerPlatform: text("installer_platform"),
  },
  (t) => ({
    expiresIdx: index("idx_installer_bootstrap_tokens_expires").on(t.expiresAt),
  }),
);
