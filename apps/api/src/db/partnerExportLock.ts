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
 * gives the caller the order every org-exclusive writer uses.
 *
 * The SQL helper records the lock in transaction-local settings, so a trigger
 * that asks for it later in the same transaction finds it held. It takes the
 * owning partner's shared export lock first (the partner → org hierarchy), and
 * it raises if this transaction already locked a higher org UUID. Call it
 * before any other org export lock in the transaction, on the handle of the
 * transaction (or savepoint) that does the writes.
 */
export async function lockPartnerExportOrg(tx: Executor, orgId: string): Promise<void> {
  await tx.execute(sql`SELECT public.breeze_partner_export_lock_orgs_exclusive(ARRAY[${orgId}]::uuid[])`);
}
