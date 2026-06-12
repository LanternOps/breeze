/**
 * Integration test for issue #1208 — user-created scripts cannot be deleted.
 *
 * Root cause: `scripts` is referenced by `script_executions` /
 * `script_execution_batches` via FK constraints with the default
 * `ON DELETE NO ACTION`. Once a script has been run, a hard
 * `DELETE FROM scripts` throws a foreign-key violation, so the API
 * returned 500 and the script could never be removed.
 *
 * Fix: soft delete. The DELETE handler stamps `deleted_at` instead of
 * hard-deleting, which never trips the FK and preserves execution history.
 *
 * These tests run against a real Postgres (the mock-based unit suite cannot
 * enforce FK behavior). They prove, with a script that has execution history:
 *
 *   1. A hard `DELETE FROM scripts` still throws the FK violation — this
 *      documents *why* the soft delete exists and fails loudly if anyone
 *      reverts to a hard delete.
 *   2. The soft delete (UPDATE deleted_at) succeeds on the same row.
 *   3. The execution-history row is preserved after the soft delete.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { scripts, scriptExecutions, devices } from '../../db/schema';
import { createPartner, createOrganization, createSite } from './db-utils';
import { getTestDb } from './setup';

async function seedScriptWithExecution() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const suffix = `${Date.now()}-${Math.floor(performance.now())}`;

  return withSystemDbAccessContext(async () => {
    const [script] = await db
      .insert(scripts)
      .values({
        orgId: org.id,
        name: `soft-delete-${suffix}`,
        osTypes: ['linux'],
        language: 'bash',
        content: 'echo hi',
        isSystem: false
      })
      .returning();

    const [device] = await db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId: `agent-${suffix}`,
        hostname: `host-${suffix}`,
        osType: 'linux',
        osVersion: '1.0',
        architecture: 'x64',
        agentVersion: '0.0.0'
      })
      .returning();

    // Completed (not active) execution — the active-execution guard would not
    // block deletion, but this row still holds the FK reference.
    await db.insert(scriptExecutions).values({
      scriptId: script!.id,
      deviceId: device!.id,
      orgId: org.id,
      status: 'completed'
    });

    return { scriptId: script!.id, orgId: org.id };
  });
}

describe('scripts soft delete — issue #1208', () => {
  it('hard DELETE still throws an FK violation when execution history exists', async () => {
    const { scriptId } = await seedScriptWithExecution();

    let caught: unknown;
    try {
      await withSystemDbAccessContext(async () => {
        await db.delete(scripts).where(eq(scripts.id, scriptId));
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const message = `${(caught as Error)?.message ?? ''} ${
      (caught as { cause?: { message?: string } })?.cause?.message ?? ''
    }`;
    expect(message).toMatch(/violates foreign key constraint/);
    expect(message).toMatch(/script_executions/);
  });

  it('soft delete (UPDATE deleted_at) succeeds and preserves execution history', async () => {
    const { scriptId } = await seedScriptWithExecution();

    const updated = await withSystemDbAccessContext(async () =>
      db
        .update(scripts)
        .set({ deletedAt: new Date() })
        .where(eq(scripts.id, scriptId))
        .returning({ id: scripts.id })
    );

    expect(updated).toHaveLength(1);

    // The row is marked deleted...
    const [row] = await getTestDb().select().from(scripts).where(eq(scripts.id, scriptId));
    expect(row?.deletedAt).not.toBeNull();

    // ...and its execution history is preserved (FK intact, not cascaded away).
    const history = await getTestDb()
      .select()
      .from(scriptExecutions)
      .where(eq(scriptExecutions.scriptId, scriptId));
    expect(history).toHaveLength(1);
  });
});
