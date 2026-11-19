import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { expect, it } from 'vitest';
import { withSystemDbAccessContext } from '../../db';
import { aiScriptPolicies } from '../../db/schema/aiScriptPolicies';
import { lockMcpUnattendedLane, lockMcpUnattendedProposalCeiling } from './mcpUnattendedCeiling';
import { createOrganization, createPartner } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';

/**
 * The MCP unattended proposal ceiling is re-read by run_script inside the
 * transaction that creates a device command, under a FOR SHARE lock on the
 * partner ceiling row. A ceiling save (an UPDATE of that row) must therefore
 * wait for that transaction, and a save that committed first must be seen.
 */

const runDb = it.runIf(!!process.env.DATABASE_URL);
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function waitForBackendLockWait(backendPid: number): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const rows = await getTestDb().execute<{ waiting: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_stat_activity
        WHERE pid = ${backendPid}
          AND state = 'active'
          AND cardinality(pg_catalog.pg_blocking_pids(pid)) > 0
      ) AS waiting
    `);
    if (rows[0]?.waiting) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`ceiling updater ${backendPid} never waited on the share lock`);
}

async function seed(ceiling: 'none' | 'medium') {
  const partner = await createPartner({ name: `MCP ceiling lock ${randomUUID()}` });
  const org = await createOrganization({ partnerId: partner.id });
  const [row] = await getTestDb().insert(aiScriptPolicies)
    .values({ partnerId: partner.id, orgId: null, mcpUnattendedProposalMaxRisk: ceiling })
    .returning();
  if (!row) throw new Error('ceiling row seed failed');
  return { orgId: org.id, rowId: row.id };
}

function lowerCeiling(client: Sql, rowId: string, entered: (pid: number) => void) {
  return client.begin(async (tx) => {
    await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
    const [backend] = await tx<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
    entered(backend!.pid);
    await tx`
      UPDATE public.ai_script_policies
      SET mcp_unattended_proposal_max_risk = 'none', updated_at = now()
      WHERE id = ${rowId}
    `;
  });
}

runDb('a ceiling save waits for the dispatch transaction that holds the share lock', async () => {
  const { orgId, rowId } = await seed('medium');
  const updater = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  const locked = deferred<string>();
  const release = deferred<void>();
  const entered = deferred<number>();
  let updateDone = false;
  try {
    const holder = withSystemDbAccessContext(async () => {
      locked.resolve(await lockMcpUnattendedProposalCeiling(orgId));
      await release.promise;
    });
    expect(await locked.promise).toBe('medium');

    const update = lowerCeiling(updater, rowId, entered.resolve).then(() => { updateDone = true; });
    await waitForBackendLockWait(await entered.promise);
    expect(updateDone).toBe(false);

    release.resolve();
    await holder;
    await update;
    const [after] = await getTestDb().select({ ceiling: aiScriptPolicies.mcpUnattendedProposalMaxRisk })
      .from(aiScriptPolicies).where(eq(aiScriptPolicies.id, rowId));
    expect(after?.ceiling).toBe('none');
  } finally {
    release.resolve();
    await updater.end({ timeout: 1 });
    await getTestDb().delete(aiScriptPolicies).where(eq(aiScriptPolicies.id, rowId));
  }
}, 20_000);

runDb('a ceiling lowered before the dispatch transaction reads it is seen under the lock', async () => {
  const { orgId, rowId } = await seed('medium');
  const updater = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await lowerCeiling(updater, rowId, () => {});
    const seen = await withSystemDbAccessContext(() => lockMcpUnattendedProposalCeiling(orgId));
    expect(seen).toBe('none');
  } finally {
    await updater.end({ timeout: 1 });
    await getTestDb().delete(aiScriptPolicies).where(eq(aiScriptPolicies.id, rowId));
  }
}, 20_000);

/**
 * The full unattended gate is re-run by run_script in the same transaction,
 * after the lane lock, reading the org and partner script-policy rows FOR
 * SHARE. A lane-policy save (an UPDATE of the org grant row, e.g. switching
 * the lane off) must therefore wait for that transaction, and a save that
 * committed first must be the one evaluated.
 */
async function seedLane() {
  const partner = await createPartner({ name: `MCP lane lock ${randomUUID()}` });
  const org = await createOrganization({ partnerId: partner.id });
  const [partnerRow] = await getTestDb().insert(aiScriptPolicies)
    .values({ partnerId: partner.id, orgId: null, unattendedAllowed: true, mcpUnattendedProposalMaxRisk: 'medium' })
    .returning();
  const [orgRow] = await getTestDb().insert(aiScriptPolicies)
    .values({ partnerId: null, orgId: org.id, unattendedEnabled: true })
    .returning();
  if (!partnerRow || !orgRow) throw new Error('lane policy seed failed');
  return { orgId: org.id, rowIds: [partnerRow.id, orgRow.id], orgRowId: orgRow.id };
}

function disableLane(client: Sql, orgRowId: string, entered: (pid: number) => void) {
  return client.begin(async (tx) => {
    await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
    const [backend] = await tx<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
    entered(backend!.pid);
    await tx`
      UPDATE public.ai_script_policies
      SET unattended_enabled = false, updated_at = now()
      WHERE id = ${orgRowId}
    `;
  });
}

runDb('a lane-policy save waits for the dispatch transaction that re-ran the gate', async () => {
  const { orgId, rowIds, orgRowId } = await seedLane();
  const updater = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  const evaluated = deferred<string | null>();
  const release = deferred<void>();
  const entered = deferred<number>();
  let updateDone = false;
  try {
    const holder = withSystemDbAccessContext(async () => {
      // No such proposal: the gate refuses past the policy read, which is
      // what holds the lock. 'lane_disabled' here would mean the seed failed.
      evaluated.resolve(await lockMcpUnattendedLane(randomUUID(), orgId, []));
      await release.promise;
    });
    expect(await evaluated.promise).toBe('not_reviewed');

    const update = disableLane(updater, orgRowId, entered.resolve).then(() => { updateDone = true; });
    await waitForBackendLockWait(await entered.promise);
    expect(updateDone).toBe(false);

    release.resolve();
    await holder;
    await update;
  } finally {
    release.resolve();
    await updater.end({ timeout: 1 });
    for (const id of rowIds) await getTestDb().delete(aiScriptPolicies).where(eq(aiScriptPolicies.id, id));
  }
}, 20_000);

runDb('a lane-policy save committed before the gate re-runs is the one evaluated', async () => {
  const { orgId, rowIds, orgRowId } = await seedLane();
  const updater = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await disableLane(updater, orgRowId, () => {});
    const seen = await withSystemDbAccessContext(() => lockMcpUnattendedLane(randomUUID(), orgId, []));
    expect(seen).toBe('lane_disabled');
  } finally {
    await updater.end({ timeout: 1 });
    for (const id of rowIds) await getTestDb().delete(aiScriptPolicies).where(eq(aiScriptPolicies.id, id));
  }
}, 20_000);
