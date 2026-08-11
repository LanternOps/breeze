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
/**
 * The one `usage_kind` value whose `max_usage` is a DEVICE-SLOT BUDGET (#3034).
 *
 * Exported as a constant, and imported by every reader that filters on it
 * (`fetchInstallerTokenUsage`, `enrollmentKeyPurgeGuards`), so the string
 * appears once. The read side is a whitelist of this single value rather than a
 * blacklist of the others: a `usage_kind` added later must be opted IN to the
 * capacity figure deliberately, never inherit it by not being on a deny list.
 */
export const CAPACITY_USAGE_KIND = "capacity";

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
    /**
     * What this token's `max_usage` MEANS (#3034). Constrained to
     * `('capacity','per_download','legacy_unknown')` by DB CHECK
     * `installer_bootstrap_tokens_usage_kind_valid`.
     *
     *   - `capacity`      — minted by an AUTHENTICATED path, where `max_usage`
     *                       is the device count the operator chose. Only these
     *                       rows are summed into the Enrollment Keys page's
     *                       installer figure.
     *   - `per_download`  — minted by a PUBLIC download (`serveInstaller`), one
     *                       hardcoded `max_usage: 1` token per click. Summing
     *                       these counts downloads, not device slots, so they
     *                       are excluded from that figure.
     *   - `legacy_unknown`— pre-#3034 single-slot rows whose mint path the data
     *                       cannot prove, plus the column DEFAULT. Excluded from
     *                       the figure: unknown must degrade to showing nothing,
     *                       never to showing a number that might be a click
     *                       count. Self-draining (24h default token TTL +
     *                       nightly cleanup).
     *
     * This lives on the TOKEN, not the parent key, because the two mint paths
     * are not separable by any property of the key: the authenticated installer
     * routes accept a short-link CHILD id, and `/s/:code` mints a fresh
     * short_code-LESS download key. `parent.short_code` — the previous proxy —
     * was wrong in both directions.
     *
     * `usageKind` is a REQUIRED input to `issueBootstrapTokenForKey` precisely
     * so a new mint path cannot inherit a meaning by omission.
     */
    usageKind: text("usage_kind").notNull().default("legacy_unknown"),
  },
  (t) => ({
    expiresIdx: index("idx_installer_bootstrap_tokens_expires").on(t.expiresAt),
    /**
     * Read path: the Enrollment Keys list aggregates installer capacity by
     * parent key (#2992). Without this the grouped SELECT seq-scans the table
     * on every page load, evaluating the RLS org qual per row before the IN
     * filter narrows anything. Also serves the parent's ON DELETE CASCADE and
     * the cleanup job's NOT EXISTS.
     */
    parentIdx: index("idx_installer_bootstrap_tokens_parent").on(
      t.parentEnrollmentKeyId,
    ),
  }),
);
