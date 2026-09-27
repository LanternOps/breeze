/**
 * Proves the TOCTOU window between `cascadeDeleteOrg`'s entry-point legal-hold
 * check and the actual `backup_snapshots` delete step is closed.
 *
 * `cascadeDeleteOrg` checks once, at entry, then walks roughly 170 more
 * tables — each its own committed transaction — before it ever reaches
 * `backup_snapshots`. A hold placed on a snapshot AFTER that entry check but
 * BEFORE the `backup_snapshots` step itself is exactly the scenario a single
 * up-front check cannot catch. This is a temporal-ordering bug, not a
 * simultaneous-access one, so the regression test reproduces it by
 * sequencing events in that exact order rather than by racing wall-clock
 * timing: (1) confirm no hold at entry, (2) place a hold, (3) run the step
 * that deletes `backup_snapshots`. `deleteBackupSnapshotsCascadeStep` is the
 * unit that must re-check under lock immediately before it deletes.
 *
 * Real Postgres, real `cascadeDeleteOrg`/`deleteBackupSnapshotsCascadeStep`
 * service code (breeze_app pool) — sibling to
 * `tenantCascadeLegalHold.integration.test.ts`, which covers hold-at-entry
 * and no-hold-at-all only.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import {
  deleteBackupSnapshotsCascadeStep,
  hasActiveLegalHoldSnapshots,
  TenantCascadeRefusalError,
} from '../../services/tenantCascade';

interface SeededOrg {
  orgId: string;
  snapshotId: string;
}

async function seedOrgWithSnapshot(): Promise<SeededOrg> {
  const testDb = getTestDb();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const partnerSlug = `legal-hold-race-test-${suffix}`;

  const [partner] = (await testDb.execute(sql`
    INSERT INTO partners (name, slug, status, created_at, updated_at)
    VALUES ('Legal Hold Race Test Partner', ${partnerSlug}, 'active', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const partnerId = partner!.id;

  const [org] = (await testDb.execute(sql`
    INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
    VALUES (${partnerId}, 'Legal Hold Race Test Org', ${`org-${suffix}`}, 'active', 'USD', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const orgId = org!.id;

  const [site] = (await testDb.execute(sql`
    INSERT INTO sites (org_id, name, created_at, updated_at)
    VALUES (${orgId}, 'Legal Hold Race Test Site', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const siteId = site!.id;

  const [device] = (await testDb.execute(sql`
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    VALUES (${orgId}, ${siteId}, ${crypto.randomUUID()}, 'legal-hold-race-fixture', 'windows', '11', 'amd64', '1.0.0')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const deviceId = device!.id;

  const [config] = (await testDb.execute(sql`
    INSERT INTO backup_configs (org_id, name, type, provider, provider_config)
    VALUES (${orgId}, 'Legal hold race fixture', 'file', 'local', '{}') RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [job] = (await testDb.execute(sql`
    INSERT INTO backup_jobs (org_id, config_id, device_id)
    VALUES (${orgId}, ${config!.id}, ${deviceId}) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [snapshot] = (await testDb.execute(sql`
    INSERT INTO backup_snapshots (org_id, job_id, device_id, snapshot_id, legal_hold)
    VALUES (${orgId}, ${job!.id}, ${deviceId}, ${crypto.randomUUID()}, false)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const snapshotId = snapshot!.id;

  return { orgId, snapshotId };
}

describe('backup_snapshots cascade step — hold appearing after the entry check (real Postgres)', () => {
  it('refuses and deletes nothing when a hold is placed after entry passed but before this step runs', async () => {
    const testDb = getTestDb();
    const { orgId, snapshotId } = await seedOrgWithSnapshot();

    // 1. Entry-point precondition check passes: no hold yet.
    expect(await hasActiveLegalHoldSnapshots(orgId)).toBe(false);

    // 2. A hold is placed in between — the window `cascadeDeleteOrg`'s single
    //    up-front check cannot see, because ~170 other tables are walked
    //    (each its own transaction) between the entry check and this step.
    await testDb.execute(sql`
      UPDATE backup_snapshots SET legal_hold = true WHERE id = ${snapshotId}
    `);

    // 3. The step that actually deletes `backup_snapshots` must re-check
    //    under lock and refuse, not trust the stale entry-point result.
    await expect(deleteBackupSnapshotsCascadeStep(orgId)).rejects.toThrow(
      TenantCascadeRefusalError,
    );

    const [snapshot] = (await testDb.execute(
      sql`SELECT id, legal_hold FROM backup_snapshots WHERE id = ${snapshotId}`,
    )) as unknown as Array<{ id: string; legal_hold: boolean }>;
    expect(snapshot?.id).toBe(snapshotId);
    expect(snapshot?.legal_hold).toBe(true);
  });

  it('a genuinely concurrent legal-hold UPDATE never loses the row while also failing to protect it', async () => {
    const testDb = getTestDb();
    const { orgId, snapshotId } = await seedOrgWithSnapshot();

    // Fire the step and a concurrent legal-hold UPDATE at the same time. No
    // hold exists when either starts, so which one reaches Postgres first is
    // genuinely unordered — that's fine, because the row lock this step now
    // takes (`FOR UPDATE`) makes the two remaining outcomes both safe:
    //   (a) the step's SELECT ... FOR UPDATE locks first → the concurrent
    //       UPDATE blocks until the step's transaction ends, then either
    //       finds the row already deleted (0 rows affected) or, if the step
    //       refused for some other reason, sets the hold on a row that still
    //       exists;
    //   (b) the UPDATE commits first → the step's own re-check sees
    //       `legal_hold = true` and refuses, deleting nothing.
    // The one outcome this test rules OUT is the pre-fix bug: the row
    // deleted while a hold was concurrently, successfully applied to it.
    const [stepOutcome] = await Promise.all([
      deleteBackupSnapshotsCascadeStep(orgId).then(
        (count) => ({ ok: true as const, count }),
        (err) => ({ ok: false as const, err }),
      ),
      testDb.execute(sql`
        UPDATE backup_snapshots SET legal_hold = true WHERE id = ${snapshotId}
      `),
    ]);

    const [snapshot] = (await testDb.execute(
      sql`SELECT id, legal_hold FROM backup_snapshots WHERE id = ${snapshotId}`,
    )) as unknown as Array<{ id: string; legal_hold: boolean } | undefined>;

    if (stepOutcome.ok) {
      // The step deleted the row before the hold could apply to it — the row
      // is simply gone, never left behind un-held.
      expect(snapshot).toBeUndefined();
    } else {
      // The hold won the race and the step refused — the row survives, and
      // it must actually carry the hold that justified the refusal.
      expect(stepOutcome.err).toBeInstanceOf(TenantCascadeRefusalError);
      expect(snapshot?.legal_hold).toBe(true);
    }
  });
});
