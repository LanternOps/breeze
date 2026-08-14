import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./orgs";
import { devices } from "./devices";
import { users } from "./users";

/**
 * Single-use, short-TTL authorization token for a LOCAL agent uninstall.
 *
 * `GET /api/v1/agents/uninstall.sh` used to be unauthenticated and removed the
 * agent from whatever machine it ran on, so any local admin could strip a
 * managed client machine. A local uninstall now requires a token minted by the
 * RMM (`POST /devices/:id/uninstall-token`, DEVICES_DELETE + MFA) which the
 * agent exchanges at `POST /agents/:id/uninstall-authorize` before it tears
 * anything down. Remote (RMM-pushed) teardown via the `self_uninstall` command
 * is unchanged and does not use this table.
 *
 * Tenancy: RLS Shape 1 (direct `org_id`), auto-discovered by the rls-coverage
 * integration test. The `device_id` column denormalizes nothing away — it
 * binds the token to exactly one device so a token minted for device A can
 * never authorize device B.
 *
 * `token` holds the PEPPERED SHA-256 of the plaintext
 * (`services/enrollmentKeySecurity.ts` `hashEnrollmentKey`) — the same at-rest
 * treatment as `enrollment_keys.key`. The plaintext exists only in the mint
 * response.
 */
export const agentUninstallTokens = pgTable(
  "agent_uninstall_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    /** Peppered SHA-256 of the plaintext token — never the plaintext itself. */
    token: text("token").notNull().unique(),
    /**
     * Must be strictly after created_at; enforced by DB CHECK
     * agent_uninstall_tokens_expires_after_created.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * Set by the single atomic burn UPDATE in the authorize route
     * (`... WHERE consumed_at IS NULL RETURNING`), which is what makes the
     * token single-use under concurrency.
     */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedFromIp: text("consumed_from_ip"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    deviceIdx: index("idx_agent_uninstall_tokens_device").on(t.deviceId),
    orgIdx: index("idx_agent_uninstall_tokens_org").on(t.orgId),
    expiresIdx: index("idx_agent_uninstall_tokens_expires").on(t.expiresAt),
  }),
);
