/**
 * Replays the recovery-subject migration over real legacy rows. A schema-fresh
 * database has no legacy rows when globalSetup first applies the migration, so
 * the backfill would otherwise be untested.
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  c2cBackupConfigs,
  c2cBackupJobs,
  c2cConnections,
  devices,
  drExecutions,
  drPlans,
  recoveryBootMediaArtifacts,
  recoveryMediaArtifacts,
  recoveryTokens,
  restoreJobs,
} from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-09-25-c-recovery-authorization-subject.sql',
);

const runDb = it.runIf(!!process.env.DATABASE_URL);
const runMigration = () => getTestDb().execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')));

type Classification = {
  id: string;
  status: string;
  authorizationState: string;
  authorizationDenialCode: string | null;
};

describe('2026-08-24 recovery authorization-subject migration', () => {
  runDb('quarantines unknown nonterminal work, preserves terminal history, and is idempotent', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [device] = await db.insert(devices).values({
      orgId: org.id,
      siteId: site.id,
      agentId: `recovery-authz-${Date.now()}`,
      hostname: 'recovery-authz-host',
      osType: 'linux',
      osVersion: '1',
      architecture: 'amd64',
      agentVersion: '1',
    }).returning();
    const [config] = await db.insert(backupConfigs).values({
      orgId: org.id,
      name: 'recovery-authz-config',
      type: 'file',
      provider: 'local',
      providerConfig: {},
    }).returning();
    const [backupJob] = await db.insert(backupJobs).values({
      orgId: org.id,
      configId: config!.id,
      deviceId: device!.id,
      status: 'completed',
    }).returning();
    const [snapshot] = await db.insert(backupSnapshots).values({
      orgId: org.id,
      jobId: backupJob!.id,
      deviceId: device!.id,
      configId: config!.id,
      snapshotId: `recovery-authz-snapshot-${Date.now()}`,
    }).returning();

    const tokens = await db.insert(recoveryTokens).values([
      {
        orgId: org.id,
        deviceId: device!.id,
        snapshotId: snapshot!.id,
        tokenHash: 'a'.repeat(64),
        restoreType: 'full',
        status: 'active',
        expiresAt: new Date('2026-08-25T00:00:00.000Z'),
      },
      {
        orgId: org.id,
        deviceId: device!.id,
        snapshotId: snapshot!.id,
        tokenHash: 'b'.repeat(64),
        restoreType: 'full',
        status: 'revoked',
        expiresAt: new Date('2026-08-25T00:00:00.000Z'),
      },
    ]).returning();
    const media = await db.insert(recoveryMediaArtifacts).values([
      {
        orgId: org.id,
        tokenId: tokens[0]!.id,
        snapshotId: snapshot!.id,
        platform: 'linux',
        architecture: 'amd64',
        status: 'pending',
      },
      {
        orgId: org.id,
        tokenId: tokens[1]!.id,
        snapshotId: snapshot!.id,
        platform: 'linux',
        architecture: 'arm64',
        status: 'failed',
      },
    ]).returning();
    const bootMedia = await db.insert(recoveryBootMediaArtifacts).values([
      {
        orgId: org.id,
        tokenId: tokens[0]!.id,
        snapshotId: snapshot!.id,
        bundleArtifactId: media[0]!.id,
        platform: 'linux',
        architecture: 'amd64',
        status: 'pending',
      },
      {
        orgId: org.id,
        tokenId: tokens[1]!.id,
        snapshotId: snapshot!.id,
        bundleArtifactId: media[1]!.id,
        platform: 'linux',
        architecture: 'arm64',
        status: 'failed',
      },
    ]).returning();
    const restores = await db.insert(restoreJobs).values([
      {
        orgId: org.id,
        snapshotId: snapshot!.id,
        deviceId: device!.id,
        restoreType: 'full',
        status: 'pending',
      },
      {
        orgId: org.id,
        snapshotId: snapshot!.id,
        deviceId: device!.id,
        restoreType: 'full',
        status: 'completed',
      },
    ]).returning();
    const [plan] = await db.insert(drPlans).values({
      orgId: org.id,
      name: 'recovery-authz-plan',
    }).returning();
    const executions = await db.insert(drExecutions).values([
      { planId: plan!.id, orgId: org.id, executionType: 'test', status: 'pending' },
      { planId: plan!.id, orgId: org.id, executionType: 'test', status: 'completed' },
    ]).returning();
    const [connection] = await db.insert(c2cConnections).values({
      orgId: org.id,
      provider: 'microsoft_365',
      displayName: 'recovery-authz-connection',
    }).returning();
    const [c2cConfig] = await db.insert(c2cBackupConfigs).values({
      orgId: org.id,
      connectionId: connection!.id,
      name: 'recovery-authz-c2c-config',
      backupScope: 'all',
    }).returning();
    const c2cJobs = await db.insert(c2cBackupJobs).values([
      { orgId: org.id, configId: c2cConfig!.id, status: 'pending' },
      { orgId: org.id, configId: c2cConfig!.id, status: 'completed' },
    ]).returning();

    await runMigration();

    async function readClassifications(
      table: typeof recoveryTokens
        | typeof recoveryMediaArtifacts
        | typeof recoveryBootMediaArtifacts
        | typeof restoreJobs
        | typeof drExecutions
        | typeof c2cBackupJobs,
      ids: string[],
    ): Promise<Classification[]> {
      return db.select({
        id: table.id,
        status: table.status,
        authorizationState: table.authorizationState,
        authorizationDenialCode: table.authorizationDenialCode,
      }).from(table).where(inArray(table.id, ids)) as Promise<Classification[]>;
    }

    const cases = [
      [recoveryTokens, tokens.map((row) => row.id), ['active', 'revoked']],
      [recoveryMediaArtifacts, media.map((row) => row.id), ['pending', 'failed']],
      [recoveryBootMediaArtifacts, bootMedia.map((row) => row.id), ['pending', 'failed']],
      [restoreJobs, restores.map((row) => row.id), ['pending', 'completed']],
      [drExecutions, executions.map((row) => row.id), ['pending', 'completed']],
      [c2cBackupJobs, c2cJobs.map((row) => row.id), ['pending', 'completed']],
    ] as const;

    const firstPass: Classification[][] = [];
    for (const [table, ids, statuses] of cases) {
      const rows = await readClassifications(table, [...ids]);
      const byStatus = new Map(rows.map((row) => [row.status, row]));
      const nonterminal = byStatus.get(statuses[0])!;
      const terminal = byStatus.get(statuses[1])!;
      expect(nonterminal).toMatchObject({
        status: statuses[0],
        authorizationState: 'quarantined_authorization_unknown',
        authorizationDenialCode: 'authorization_subject_unknown',
      });
      expect(terminal).toMatchObject({
        status: statuses[1],
        authorizationState: 'not_required',
        authorizationDenialCode: null,
      });
      firstPass.push(rows.sort((left, right) => left.id.localeCompare(right.id)));
    }

    await expect(runMigration()).resolves.toBeDefined();
    for (const [index, [table, ids]] of cases.entries()) {
      const replayed = await readClassifications(table, [...ids]);
      expect(replayed.sort((left, right) => left.id.localeCompare(right.id)))
        .toEqual(firstPass[index]);
    }

    const [c2cNonterminal] = await db.select({ operationKind: c2cBackupJobs.operationKind })
      .from(c2cBackupJobs)
      .where(eq(c2cBackupJobs.id, c2cJobs[0]!.id));
    expect(c2cNonterminal?.operationKind).toBe('unknown');
  });
});
