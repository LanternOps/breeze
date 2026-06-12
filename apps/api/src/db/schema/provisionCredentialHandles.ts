import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./orgs";
import { devices } from "./devices";
import { users } from "./users";

/**
 * Short-TTL, single-use handle for the device-provision credential blob
 * (#917 L-3). POST /devices/provision no longer returns the agent's
 * long-lived secrets (auth_token, watchdog/helper tokens, mTLS private key)
 * inline. Instead it stores the config blob here keyed by an unguessable
 * token with a short TTL (default 5 min) and returns a one-time fetch URL.
 *
 * The blob is delivered exactly once via GET /devices/provision/fetch/:token,
 * which atomically marks the handle consumed (and hard-deletes the row so the
 * plaintext secrets do not linger at rest). A second fetch, or a fetch after
 * expiry, returns 404/410.
 *
 * RLS Shape 1 (direct org_id) — auto-discovered, no allowlist entry needed.
 */
export const provisionCredentialHandles = pgTable(
  "provision_credential_handles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: text("token").notNull().unique(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    /**
     * The full agent config blob — includes plaintext secrets. Transient:
     * single-use, short-TTL, deleted on consume.
     */
    credentials: jsonb("credentials").notNull(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Must be strictly after created_at; enforced by DB CHECK. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedFromIp: text("consumed_from_ip"),
  },
  (t) => ({
    expiresIdx: index("idx_provision_credential_handles_expires").on(
      t.expiresAt,
    ),
  }),
);

export type ProvisionCredentialHandle =
  typeof provisionCredentialHandles.$inferSelect;
