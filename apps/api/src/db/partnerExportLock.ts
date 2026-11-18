import { sql } from 'drizzle-orm';

type Executor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

/**
 * Take an organization's partner-export lock (exclusive) explicitly, before
 * the writes whose triggers would otherwise take it later in the statement.
 *
 * The partner-export triggers on `devices` and the device-child tables are
 * statement-level AFTER triggers, so they take this lock only after the same
 * statement's row triggers have run. On a `devices` INSERT, the row trigger
 * `topology_capture_legacy_change` locks the site's `topology_site_state` row
 * first. That is the reverse of a writer that already holds the org lock and
 * then updates the same row (`markTopologyIdentityDirty` after a
 * `device_network` write), and the two deadlock (#9521). Calling this first
 * gives the caller that writer's order: export lock, then the row.
 *
 * The SQL helper (`breeze_partner_export_lock_orgs_exclusive`) records the
 * lock in transaction-local settings, so a trigger that asks for it later in
 * the same transaction finds it held. It takes the owning partner's shared
 * export lock first (the partner → org hierarchy). It raises if this
 * transaction already holds an export lock on a higher org UUID, and any NEW
 * partner export lock requested after it raises too, so take it before the
 * transaction's other export locks, on the handle of the transaction (or
 * savepoint) that does the writes.
 */
export async function lockPartnerExportOrg(tx: Executor, orgId: string): Promise<void> {
  await tx.execute(sql`SELECT public.breeze_partner_export_lock_orgs_exclusive(ARRAY[${orgId}]::uuid[])`);
}
