import { config } from 'dotenv';
// Load .env from monorepo root (when running from apps/api) or cwd (when running from root)
config({ path: '../../.env' });
config(); // Also try cwd

import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Prefer DATABASE_URL_APP (the unprivileged breeze_app role) so RLS policies
// are actually enforced. Fall back to DATABASE_URL for backward compatibility
// with existing deployments; autoMigrate will warn loudly if that connection
// has BYPASSRLS/SUPERUSER.
const connectionString =
  process.env.DATABASE_URL_APP
  || process.env.DATABASE_URL
  || 'postgresql://breeze:breeze@localhost:5432/breeze';

const client = postgres(connectionString, {
  idle_timeout: 20,
  max_lifetime: 60 * 30,
  connect_timeout: 10,
});
const baseDb = drizzle(client, { schema });
const dbContextStorage = new AsyncLocalStorage<typeof baseDb>();

function getCurrentDb(): typeof baseDb {
  return dbContextStorage.getStore() ?? baseDb;
}

export type DbAccessScope = 'system' | 'partner' | 'organization';

export interface DbAccessContext {
  scope: DbAccessScope;
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  /**
   * UUIDs of partners the caller can access. Undefined is treated as
   * "unset" — same behavior as the previous two-axis model: system scope
   * sees all partners, every other scope sees none. Populate this from
   * the JWT partnerId for partner-scope callers to enable RLS on
   * `partners` / `partner_users` to pass.
   */
  accessiblePartnerIds?: string[] | null;
  /**
   * The authenticated user's id, for the self-read branch of the
   * `users` RLS policy (so a user can always SELECT their own row even
   * when their caller scope doesn't otherwise grant access). Set from
   * `auth.user.id` in the middleware. Omit (or set to null) for non-
   * human callers (API keys, agents, system jobs).
   */
  userId?: string | null;
}

export const SYSTEM_DB_ACCESS_CONTEXT: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function serializeAccessibleIds(scope: DbAccessScope, accessibleIds: string[] | null | undefined): string {
  // System scope always serializes to "*" regardless of whether the list
  // was provided. This keeps existing callers that only populated
  // accessibleOrgIds working as-is (system scope → system-wide access on
  // all axes) and matches the `breeze_accessible_*_ids()` helper shape.
  if (scope === 'system') {
    return '*';
  }

  if (accessibleIds === null || accessibleIds === undefined) {
    // Unset for a non-system scope means "no access" — the fail-closed
    // branch in the SQL helpers treats empty string as ARRAY[]::uuid[].
    return '';
  }

  if (accessibleIds.length === 0) {
    return '';
  }

  return accessibleIds.join(',');
}

export async function withDbAccessContext<T>(
  context: DbAccessContext,
  fn: () => Promise<T>
): Promise<T> {
  if (dbContextStorage.getStore()) {
    return fn();
  }

  return baseDb.transaction(async (tx) => {
    const serializedOrgIds = serializeAccessibleIds(context.scope, context.accessibleOrgIds);
    const serializedPartnerIds = serializeAccessibleIds(context.scope, context.accessiblePartnerIds);
    const serializedUserId = context.userId ?? '';

    await tx.execute(sql`select set_config('breeze.scope', ${context.scope}, true)`);
    await tx.execute(sql`select set_config('breeze.org_id', ${context.orgId ?? ''}, true)`);
    await tx.execute(sql`select set_config('breeze.accessible_org_ids', ${serializedOrgIds}, true)`);
    await tx.execute(sql`select set_config('breeze.accessible_partner_ids', ${serializedPartnerIds}, true)`);
    await tx.execute(sql`select set_config('breeze.user_id', ${serializedUserId}, true)`);

    return dbContextStorage.run(tx as unknown as typeof baseDb, fn);
  });
}

export async function withSystemDbAccessContext<T>(fn: () => Promise<T>): Promise<T> {
  return withDbAccessContext(SYSTEM_DB_ACCESS_CONTEXT, fn);
}

export type RunOutsideDbContextFn = <T>(fn: () => T) => T;

/**
 * Runs a function outside any active AsyncLocalStorage DB context,
 * ensuring `db` resolves to `baseDb` (the connection pool) rather
 * than a request-scoped transaction. Use this for long-lived background
 * tasks that outlive the originating HTTP request.
 */
export const runOutsideDbContext: RunOutsideDbContextFn = <T>(fn: () => T): T => {
  return dbContextStorage.exit(fn);
};

const proxiedDb = new Proxy(baseDb, {
  get(_target, prop) {
    const activeDb = getCurrentDb() as unknown as Record<PropertyKey, unknown>;
    const value = activeDb[prop];
    if (typeof value === 'function') {
      return (value as (...args: unknown[]) => unknown).bind(activeDb);
    }
    return value;
  }
}) as typeof baseDb;

export const db = Object.assign(proxiedDb, {
  runOutsideDbContext,
});

export type Database = typeof db;

export async function closeDb(): Promise<void> {
  await client.end();
}
