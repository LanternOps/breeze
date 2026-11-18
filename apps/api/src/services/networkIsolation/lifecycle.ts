import { RESOLVED_TERMINAL_STATES } from '@breeze/shared';
import { sql, type SQL } from 'drizzle-orm';

export type IsolationLifecycleScope = { deviceId: string } | { deviceIds: string[] } | { orgId: string };
export interface IsolationLifecycleTx {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}
export interface UnresolvedIsolation {
  isolationId: string;
  deviceId: string;
}

export class NetworkIsolationUnresolvedError extends Error {
  readonly code = 'isolation_unresolved';

  constructor(readonly action: string, readonly isolations: UnresolvedIsolation[]) {
    super('Release network isolation first');
    this.name = 'NetworkIsolationUnresolvedError';
  }
}

// Built from the `sql` tag only: this module is imported by many hot request
// paths, and partial drizzle-orm test mocks rarely expose every operator.
function idList(ids: readonly string[]): SQL {
  return sql.join(ids.map(id => sql`${id}`), sql`, `);
}

function scopePredicate(scope: IsolationLifecycleScope, idColumn: 'id' | 'device_id'): SQL {
  if ('orgId' in scope) return sql`org_id = ${scope.orgId}`;
  const ids = 'deviceId' in scope ? [scope.deviceId] : scope.deviceIds;
  return idColumn === 'id' ? sql`id IN (${idList(ids)})` : sql`device_id IN (${idList(ids)})`;
}

function emptyScope(scope: IsolationLifecycleScope): boolean {
  return 'deviceIds' in scope && scope.deviceIds.length === 0;
}

/** Read-only blocker lookup; respects the caller's ambient tenant context. */
export async function findUnresolvedIsolations(
  tx: IsolationLifecycleTx,
  scope: IsolationLifecycleScope,
): Promise<UnresolvedIsolation[]> {
  if (emptyScope(scope)) return [];
  const result = await tx.execute(sql`
    SELECT id AS "isolationId", device_id AS "deviceId"
    FROM device_network_isolations
    WHERE ${scopePredicate(scope, 'device_id')}
      AND state NOT IN (${idList(RESOLVED_TERMINAL_STATES)})
    ORDER BY device_id, id
  `);
  // postgres-js returns the row array; node-postgres returns { rows }.
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) throw new Error('Invalid network isolation query result');
  return rows as UnresolvedIsolation[];
}

/**
 * Must run inside the mutation's transaction. Lock devices before reading episodes,
 * matching startNetworkIsolation's device-first lock order. This closes the race
 * where an isolation could start between a lifecycle precheck and its mutation.
 * Callers that already hold the device lock may safely call this again.
 * A caller already holding the device lock, or with a database trigger enforcing
 * the same refusal, may suppress this lock to preserve its own lock order (the
 * org-move engine locks organizations first).
 */
export async function assertNoUnresolvedIsolation(
  tx: IsolationLifecycleTx,
  scope: IsolationLifecycleScope,
  action: string,
  options: { lockDevices?: boolean } = {},
): Promise<void> {
  if (emptyScope(scope)) return;
  if (options.lockDevices !== false) {
    await tx.execute(sql`SELECT id FROM devices WHERE ${scopePredicate(scope, 'id')} ORDER BY id FOR NO KEY UPDATE`);
  }
  const isolations = await findUnresolvedIsolations(tx, scope);
  if (isolations.length > 0) throw new NetworkIsolationUnresolvedError(action, isolations);
}
