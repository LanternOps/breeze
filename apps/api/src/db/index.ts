import { config } from 'dotenv';
// Load .env from monorepo root (when running from apps/api) or cwd (when running from root)
config({ path: '../../.env' });
config(); // Also try cwd

import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL || 'postgresql://breeze:breeze@localhost:5432/breeze';

const client = postgres(connectionString);
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
}

export const SYSTEM_DB_ACCESS_CONTEXT: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
};

function serializeAccessibleOrgIds(scope: DbAccessScope, accessibleOrgIds: string[] | null): string {
  if (scope === 'system' || accessibleOrgIds === null) {
    return '*';
  }

  if (accessibleOrgIds.length === 0) {
    return '';
  }

  return accessibleOrgIds.join(',');
}

export async function withDbAccessContext<T>(
  context: DbAccessContext,
  fn: () => Promise<T>
): Promise<T> {
  if (dbContextStorage.getStore()) {
    return fn();
  }

  return baseDb.transaction(async (tx) => {
    const serializedOrgIds = serializeAccessibleOrgIds(context.scope, context.accessibleOrgIds);

    await tx.execute(sql`select set_config('breeze.scope', ${context.scope}, true)`);
    await tx.execute(sql`select set_config('breeze.org_id', ${context.orgId ?? ''}, true)`);
    await tx.execute(sql`select set_config('breeze.accessible_org_ids', ${serializedOrgIds}, true)`);

    return dbContextStorage.run(tx as typeof baseDb, fn);
  });
}

export async function withSystemDbAccessContext<T>(fn: () => Promise<T>): Promise<T> {
  return withDbAccessContext(SYSTEM_DB_ACCESS_CONTEXT, fn);
}

export const db = new Proxy(baseDb, {
  get(_target, prop) {
    const activeDb = getCurrentDb() as Record<PropertyKey, unknown>;
    const value = activeDb[prop];
    if (typeof value === 'function') {
      return (value as (...args: unknown[]) => unknown).bind(activeDb);
    }
    return value;
  }
}) as typeof baseDb;

export type Database = typeof db;

export async function closeDb(): Promise<void> {
  await client.end();
}
