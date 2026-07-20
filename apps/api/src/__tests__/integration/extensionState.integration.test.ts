/**
 * Cross-connection integration test for the runtime-extension state layer
 * (Plan 02, Task 2).
 *
 * `installed_extensions` is a core-owned GLOBAL table with FORCE ROW LEVEL
 * SECURITY and a single system-only policy (migration
 * 2026-08-01-e-runtime-extensions.sql). This test proves, against real Postgres
 * as the unprivileged `breeze_app` role, that:
 *
 *   1. An `enabled` flag written by `ExtensionStateStore` (through the production
 *      `db` pool under system scope) is COMMITTED and visible on a SEPARATE
 *      pooled connection (`getAppDb()`) — i.e. it is real durable state, not a
 *      transaction-local value the writer alone can see.
 *   2. That separate read only succeeds under SYSTEM scope: the same connection
 *      with no system-scope GUC sees zero rows, which simultaneously proves the
 *      FORCE-RLS system-only policy is genuinely enforced (and that the harness
 *      really runs as `breeze_app`, not a BYPASSRLS superuser).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { installedExtensions } from '../../db/schema';
import {
  ExtensionStateStore,
  DrizzleExtensionStateBackend,
} from '../../extensions/stateStore';
import { getAppDb } from './setup';

// installed_extensions is a global table, NOT in the tenant-truncate cleanup
// set, so rows survive beforeEach — use a unique name per run and clean up in
// afterAll under system scope (the only scope the policy admits).
const extensionName = `state-store-it-${randomUUID().slice(0, 8)}`;

/** Read the enabled flag on a SEPARATE breeze_app connection under system scope. */
async function readEnabledUnderSystemScope(name: string): Promise<boolean | undefined> {
  const rows = await getAppDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('breeze.scope', 'system', true)`);
    return tx
      .select({ enabled: installedExtensions.enabled })
      .from(installedExtensions)
      .where(eq(installedExtensions.name, name));
  });
  return rows[0]?.enabled;
}

describe('ExtensionStateStore — committed cross-connection state (Plan 02, Task 2)', () => {
  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      const { db } = await import('../../db');
      await db.delete(installedExtensions).where(eq(installedExtensions.name, extensionName));
    });
  });

  it('an enabled flag written through the store is visible on a separate connection', async () => {
    const store = new ExtensionStateStore(new DrizzleExtensionStateBackend());

    await store.upsertObserved({
      name: extensionName,
      configuredVersion: '2.0.0',
      digest: 'sha256:abc',
      publisher: 'breeze',
    });

    // Default enabled=true is visible cross-connection...
    expect(await readEnabledUnderSystemScope(extensionName)).toBe(true);

    // ...and flipping it to false through the store persists (committed) so the
    // separate connection observes the new value, not a stale/tx-local one.
    await store.setEnabled(extensionName, false);
    expect(await readEnabledUnderSystemScope(extensionName)).toBe(false);

    // Sanity: the writer's own view agrees with the cross-connection read.
    expect(await store.get(extensionName)).toMatchObject({
      configuredVersion: '2.0.0',
      enabled: false,
    });
  });

  it('the same row is invisible to a non-system-scope read (FORCE-RLS system-only policy)', async () => {
    const store = new ExtensionStateStore(new DrizzleExtensionStateBackend());
    await store.upsertObserved({ name: extensionName, configuredVersion: '2.0.0' });

    // A breeze_app read with NO system-scope GUC set: the system-only policy's
    // USING clause evaluates false, so RLS filters every row (returns 0), or
    // Postgres denies outright. Either outcome proves tenant scopes can't reach
    // this global operational table.
    let rows: unknown[] = [];
    let err: unknown = null;
    try {
      rows = await getAppDb()
        .select({ enabled: installedExtensions.enabled })
        .from(installedExtensions)
        .where(eq(installedExtensions.name, extensionName));
    } catch (e) {
      err = e;
    }

    if (err) {
      const cause = err as { cause?: { message?: string }; message?: string };
      const message = cause?.cause?.message ?? cause?.message ?? '';
      expect(message).toMatch(/permission denied|row-level security/i);
    } else {
      expect(rows).toEqual([]);
    }
  });

  // `listAll` powers the platform-admin list endpoint (Plan 02, Task 6). Unit
  // tests exercise it against an in-memory backend, which cannot catch a broken
  // ORDER BY or a system-scope wrapper that RLS would filter to zero rows — so
  // assert the real SQL here.
  it('listAll returns every row under system scope, ordered by name', async () => {
    const store = new ExtensionStateStore(new DrizzleExtensionStateBackend());
    const second = `${extensionName}-b`;
    try {
      await store.upsertObserved({ name: extensionName, configuredVersion: '2.0.0' });
      await store.upsertObserved({ name: second, configuredVersion: '3.0.0' });

      const all = await store.listAll();
      const ours = all.filter((row) => row.name.startsWith(extensionName));

      expect(ours.map((row) => row.name)).toEqual([extensionName, second]);
      expect(ours[0]).toMatchObject({ configuredVersion: '2.0.0', lifecycleState: 'discovered' });
      // The full record shape the admin surface sanitizes from is present.
      expect(ours[1]?.updatedAt).toBeInstanceOf(Date);
    } finally {
      await withSystemDbAccessContext(async () => {
        const { db } = await import('../../db');
        await db.delete(installedExtensions).where(eq(installedExtensions.name, second));
      });
    }
  });

  /**
   * SCOPE ESCALATION FROM INSIDE A REQUEST CONTEXT.
   *
   * `withDbAccessContext` short-circuits (`return fn()`) when a context is
   * already open, so a bare `withSystemDbAccessContext` nested in a TENANT
   * context does not escalate — it inherits the tenant scope. Under the
   * FORCE-RLS system-only policy that silently yields ZERO ROWS on reads and
   * ZERO ROWS MATCHED on writes, with no error either way.
   *
   * That is exactly the shape of every real caller on the request path:
   *   • the agent-route gate (agentAuth wraps `next()` in an organization-scoped
   *     context, so gateway.ts's enabled check runs inside it) → permanent 503s;
   *   • the AI-tool gate (aiAgentSdkTools/scriptBuilderTools run executeTool
   *     inside an org/partner-scoped context) → "Unknown tool", forever;
   *   • platform-admin enable/disable (authMiddleware opens a context for the
   *     JWT's scope, which is orthogonal to isPlatformAdmin) → a 200 that
   *     mutated nothing.
   *
   * None of that is reachable by unit tests, which inject a fake store. It needs
   * real Postgres and a real ambient tenant context, so it lives here.
   */
  it('reads and writes correctly when called from INSIDE an ambient tenant DB context', async () => {
    const { withDbAccessContext } = await import('../../db');
    const store = new ExtensionStateStore(new DrizzleExtensionStateBackend());
    const orgId = randomUUID();

    await store.upsertObserved({ name: extensionName, configuredVersion: '2.0.0' });
    await store.setEnabled(extensionName, true);

    const tenantContext = {
      scope: 'organization' as const,
      orgId,
      accessibleOrgIds: [orgId],
    };

    // READ: must see the true durable value, not RLS-filtered emptiness.
    const seen = await withDbAccessContext(tenantContext, async () =>
      store.isEnabled(extensionName),
    );
    expect(seen).toBe(true);

    // WRITE: must actually mutate the row, not match zero rows and "succeed".
    await withDbAccessContext(tenantContext, async () => {
      await store.setEnabled(extensionName, false);
    });
    expect(await readEnabledUnderSystemScope(extensionName)).toBe(false);

    // ...and the escalated read observes the write from inside the same context.
    expect(
      await withDbAccessContext(tenantContext, async () => store.isEnabled(extensionName)),
    ).toBe(false);

    // The full record is reachable too (the admin list surface's read path).
    const listed = await withDbAccessContext(tenantContext, async () => store.listAll());
    expect(listed.some((row) => row.name === extensionName)).toBe(true);
  });
});
