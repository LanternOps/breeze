/**
 * W03 contraction replay against W02's nullable columns and unique index.
 * Run with vitest.integration.config.ts (real Postgres); never in the unit suite.
 * All DDL is rolled back, even when an assertion fails, so subsequent suites
 * always see the migrated schema. Replaying SQL directly tests idempotency;
 * running the migration runner twice would only exercise its ledger skip.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { devices, deviceFilesystemSnapshots, deviceFilesystemScanState } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

describe('filesystem scan_path contraction replay', () => {
  it.each(['linux', 'windows'] as const)('contracts and replays for %s', async (osType) => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [device] = await db.insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: `contraction-${randomUUID()}`,
      hostname: 'contraction-test', osType, osVersion: 'test',
      architecture: 'amd64', agentVersion: 'test',
    }).returning();
    const deviceId = device!.id;
    const root = osType === 'windows' ? 'C:\\' : '/';
    const otherPath = osType === 'windows' ? 'D:\\' : '/data';
    const migration = readFileSync(path.resolve(__dirname,
      '../../../migrations/2026-10-21-110200-filesystem-scan-path-not-null.sql'), 'utf8');
    const rollback = new Error('rollback contraction replay fixture');

    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`
          ALTER TABLE device_filesystem_scan_state DROP CONSTRAINT device_filesystem_scan_state_pkey;
          ALTER TABLE device_filesystem_scan_state ALTER COLUMN scan_path DROP NOT NULL;
          ALTER TABLE device_filesystem_snapshots ALTER COLUMN scan_path DROP NOT NULL;
          CREATE UNIQUE INDEX device_filesystem_scan_state_device_path_uidx
            ON device_filesystem_scan_state (device_id, scan_path);
        `));
        // Raw SQL deliberately models an old writer omitting the now-required field.
        await tx.execute(sql`
          INSERT INTO device_filesystem_snapshots (device_id, org_id, raw_payload)
          VALUES (${deviceId}, ${org.id}, ${JSON.stringify({ path: otherPath })}::jsonb),
                 (${deviceId}, ${org.id}, '{}'::jsonb);
        `);
        await tx.execute(sql`
          INSERT INTO device_filesystem_scan_state
            (device_id, org_id, checkpoint, aggregate, hot_directories)
          VALUES (${deviceId}, ${org.id}, '{"cursor":"unknown-volume"}',
                  '{"bytes":100}', '["unknown-volume"]');
        `);
        await tx.insert(deviceFilesystemScanState).values({
          deviceId, orgId: org.id, scanPath: otherPath,
          checkpoint: { cursor: 'keep' }, aggregate: { bytes: 42 }, hotDirectories: [otherPath],
        });

        await tx.execute(sql.raw(migration));
        const snapshots = await tx.select().from(deviceFilesystemSnapshots)
          .where(eq(deviceFilesystemSnapshots.deviceId, deviceId));
        expect(snapshots.map((row) => row.scanPath).sort()).toEqual([root, otherPath].sort());
        const states = await tx.select().from(deviceFilesystemScanState)
          .where(eq(deviceFilesystemScanState.deviceId, deviceId));
        expect(states).toHaveLength(2);
        expect(states.find((row) => row.scanPath === root)).toMatchObject({
          checkpoint: {}, aggregate: {}, hotDirectories: [],
        });
        expect(states.find((row) => row.scanPath === otherPath)).toMatchObject({
          checkpoint: { cursor: 'keep' }, aggregate: { bytes: 42 }, hotDirectories: [otherPath],
        });
        const key = await tx.execute(sql`
          SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid = 'device_filesystem_scan_state'::regclass AND contype = 'p'
        `);
        expect(key[0]?.definition).toBe('PRIMARY KEY (device_id, scan_path)');
        const index = await tx.execute(sql`
          SELECT to_regclass('device_filesystem_scan_state_device_path_uidx') AS interim
        `);
        expect(index[0]?.interim).toBeNull();

        // Savepoints keep expected constraint violations from aborting the replay transaction.
        const expectViolation = async (statement: ReturnType<typeof sql>, code: string) => {
          let failure: unknown;
          try {
            await tx.transaction(async (savepoint) => { await savepoint.execute(statement); });
          } catch (error) { failure = error; }
          const error = failure as { code?: string; cause?: { code?: string } } | undefined;
          expect(error?.cause?.code ?? error?.code).toBe(code);
        };
        await expectViolation(sql`INSERT INTO device_filesystem_snapshots (device_id, org_id)
          VALUES (${deviceId}, ${org.id})`, '23502');
        await expectViolation(sql`INSERT INTO device_filesystem_scan_state (device_id, org_id)
          VALUES (${deviceId}, ${org.id})`, '23502');
        await expectViolation(sql`INSERT INTO device_filesystem_scan_state (device_id, org_id, scan_path)
          VALUES (${deviceId}, ${org.id}, ${root})`, '23505');

        await tx.execute(sql.raw(migration));
        expect(await tx.select().from(deviceFilesystemScanState)
          .where(eq(deviceFilesystemScanState.deviceId, deviceId))).toEqual(states);
        expect(await tx.select().from(deviceFilesystemSnapshots)
          .where(eq(deviceFilesystemSnapshots.deviceId, deviceId))).toEqual(snapshots);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  });
});
