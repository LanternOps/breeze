import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../db';
import { createOrganization, createPartner, createUser } from '../__tests__/integration/db-utils';
import { getTestDb } from '../__tests__/integration/setup';
import { ensureActiveSigningKey, signManifest } from './manifestSigning';
import { mintStepUpGrant, rollbackResourceDigest } from './mfaStepUpGrant';
import { createAgentRollbackDirective } from './agentRollback';
import { verifyRollbackDirectiveSignature } from './rollbackDirectiveSigning';

const CURRENT_VERSION = '98.2.0';
const TARGET_VERSION = '98.1.0';

type Fixture = { orgId: string; userId: string; deviceId: string };

function orgContext(orgId: string, userId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId };
}

async function createFixture(capability = 1): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });
  const [row] = await getTestDb().execute(sql`
    WITH inserted_site AS (
      INSERT INTO sites (org_id, name) VALUES (${org.id}, ${`Rollback atomicity ${randomUUID()}`}) RETURNING id
    )
    INSERT INTO devices (
      org_id, site_id, agent_id, hostname, os_type, os_version, architecture,
      agent_version, agent_edition, rollback_protocol_version
      , rollback_component_versions
    ) SELECT
      ${org.id}, id, ${`agent-${randomUUID()}`}, ${`host-${randomUUID()}`},
      'windows', '11', 'amd64', ${CURRENT_VERSION}, 'self-host', ${capability},
      ${JSON.stringify({ agent: CURRENT_VERSION })}::jsonb
    FROM inserted_site RETURNING id
  `) as unknown as Array<{ id: string }>;
  return { orgId: org.id, userId: user!.id, deviceId: row!.id };
}

async function registerRelease(version: string): Promise<void> {
  const downloadUrl = `https://updates.example/${version}/breeze-agent-windows-amd64.exe`;
  const checksum = version === CURRENT_VERSION ? 'c'.repeat(64) : 'd'.repeat(64);
  const manifest = JSON.stringify({
    version,
    platform: 'windows',
    arch: 'amd64',
    component: 'agent',
    url: downloadUrl,
    checksum,
    size: 1024,
  });
  const active = await ensureActiveSigningKey();
  const signature = await signManifest(manifest);
  await getTestDb().execute(sql`
    INSERT INTO agent_versions (
      version, platform, architecture, download_url, checksum, release_manifest,
      manifest_signature, signing_key_id, file_size, component, edition
    ) VALUES (
      ${version}, 'windows', 'amd64', ${downloadUrl}, ${checksum}, ${manifest},
      ${signature}, ${active.keyId}, 1024, 'agent', 'self-host'
    ) ON CONFLICT (version, platform, architecture, component, edition) DO UPDATE SET
      download_url = EXCLUDED.download_url,
      checksum = EXCLUDED.checksum,
      release_manifest = EXCLUDED.release_manifest,
      manifest_signature = EXCLUDED.manifest_signature,
      signing_key_id = EXCLUDED.signing_key_id,
      file_size = EXCLUDED.file_size
  `);
}

async function mintRollbackGrant(fixture: Fixture, reason: string, sid = randomUUID()): Promise<{
  id: string;
  authEpoch: number;
  mfaEpoch: number;
  sid: string;
}> {
  const authEpoch = 7;
  const mfaEpoch = 9;
  const id = await mintStepUpGrant({
    userId: fixture.userId,
    operation: 'agent_rollback',
    authEpoch,
    mfaEpoch,
    sid,
    resourceDigest: rollbackResourceDigest({
      deviceId: fixture.deviceId,
      currentVersion: CURRENT_VERSION,
      targetVersion: TARGET_VERSION,
      reason,
    }),
  });
  if (!id) throw new Error('Redis step-up grant unavailable');
  return { id, authEpoch, mfaEpoch, sid };
}

describe('agent rollback atomic creation', () => {
  beforeAll(async () => {
    await registerRelease(CURRENT_VERSION);
    await registerRelease(TARGET_VERSION);
  });

  it('atomically writes one signed directive, requested event, and queued command', async () => {
    const fixture = await createFixture();
    const reason = 'Recover from verified regression';
    const grant = await mintRollbackGrant(fixture, reason);
    const directive = await withDbAccessContext(orgContext(fixture.orgId, fixture.userId), () =>
      createAgentRollbackDirective({
        deviceId: fixture.deviceId,
        targetVersion: TARGET_VERSION,
        reason,
        authorizedBy: fixture.userId,
        stepUpGrantId: grant.id,
        authEpoch: grant.authEpoch,
        mfaEpoch: grant.mfaEpoch,
        sid: grant.sid,
        now: new Date('2026-08-25T12:00:00Z'),
      }));

    const active = await ensureActiveSigningKey();
    expect(verifyRollbackDirectiveSignature(directive, active.publicKeyB64)).toBe(true);
    const [counts] = await getTestDb().execute(sql`
      SELECT
        (SELECT count(*)::int FROM agent_rollback_directives WHERE device_id = ${fixture.deviceId}) AS directives,
        (SELECT count(*)::int FROM agent_rollback_events WHERE device_id = ${fixture.deviceId} AND phase = 'requested') AS events,
        (SELECT count(*)::int FROM device_commands WHERE device_id = ${fixture.deviceId} AND type = 'agent_rollback_v1') AS commands
    `) as unknown as Array<{ directives: number; events: number; commands: number }>;
    expect(counts).toEqual({ directives: 1, events: 1, commands: 1 });
  });

  it('rejects a wrong resource binding with zero lifecycle writes', async () => {
    const fixture = await createFixture();
    const grant = await mintRollbackGrant(fixture, 'different reason');
    await expect(withDbAccessContext(orgContext(fixture.orgId, fixture.userId), () =>
      createAgentRollbackDirective({
        deviceId: fixture.deviceId,
        targetVersion: TARGET_VERSION,
        reason: 'actual reason',
        authorizedBy: fixture.userId,
        stepUpGrantId: grant.id,
        authEpoch: grant.authEpoch,
        mfaEpoch: grant.mfaEpoch,
        sid: grant.sid,
      }))).rejects.toThrow(/step-up grant/);
    const [counts] = await getTestDb().execute(sql`
      SELECT
        (SELECT count(*)::int FROM agent_rollback_directives WHERE device_id = ${fixture.deviceId}) AS directives,
        (SELECT count(*)::int FROM agent_rollback_events WHERE device_id = ${fixture.deviceId}) AS events,
        (SELECT count(*)::int FROM device_commands WHERE device_id = ${fixture.deviceId} AND type = 'agent_rollback_v1') AS commands
    `) as unknown as Array<{ directives: number; events: number; commands: number }>;
    expect(counts).toEqual({ directives: 0, events: 0, commands: 0 });
  });

  it('serializes concurrent duplicate creation without orphan rows', async () => {
    const fixture = await createFixture();
    const reason = 'Concurrent rollback';
    const [firstGrant, secondGrant] = await Promise.all([
      mintRollbackGrant(fixture, reason),
      mintRollbackGrant(fixture, reason),
    ]);
    const attempt = (grant: Awaited<ReturnType<typeof mintRollbackGrant>>) =>
      withDbAccessContext(orgContext(fixture.orgId, fixture.userId), () => createAgentRollbackDirective({
        deviceId: fixture.deviceId,
        targetVersion: TARGET_VERSION,
        reason,
        authorizedBy: fixture.userId,
        stepUpGrantId: grant.id,
        authEpoch: grant.authEpoch,
        mfaEpoch: grant.mfaEpoch,
        sid: grant.sid,
      }));
    const results = await Promise.allSettled([attempt(firstGrant), attempt(secondGrant)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const [counts] = await getTestDb().execute(sql`
      SELECT
        (SELECT count(*)::int FROM agent_rollback_directives WHERE device_id = ${fixture.deviceId}) AS directives,
        (SELECT count(*)::int FROM agent_rollback_events WHERE device_id = ${fixture.deviceId}) AS events,
        (SELECT count(*)::int FROM device_commands WHERE device_id = ${fixture.deviceId} AND type = 'agent_rollback_v1') AS commands
    `) as unknown as Array<{ directives: number; events: number; commands: number }>;
    expect(counts).toEqual({ directives: 1, events: 1, commands: 1 });
  });

  it('rejects absent protocol capability before consuming authorization', async () => {
    const fixture = await createFixture(0);
    const reason = 'Unsupported endpoint';
    const grant = await mintRollbackGrant(fixture, reason);
    await expect(withDbAccessContext(orgContext(fixture.orgId, fixture.userId), () =>
      createAgentRollbackDirective({
        deviceId: fixture.deviceId,
        targetVersion: TARGET_VERSION,
        reason,
        authorizedBy: fixture.userId,
        stepUpGrantId: grant.id,
        authEpoch: grant.authEpoch,
        mfaEpoch: grant.mfaEpoch,
        sid: grant.sid,
    }))).rejects.toThrow(/protocol v1/);
  });

  it('fails closed when a protocol-v1 device has no complete component inventory', async () => {
    const fixture = await createFixture();
    await getTestDb().execute(sql`
      UPDATE devices SET rollback_component_versions = NULL WHERE id = ${fixture.deviceId}
    `);
    const reason = 'Inventory unavailable';
    const grant = await mintRollbackGrant(fixture, reason);
    await expect(withDbAccessContext(orgContext(fixture.orgId, fixture.userId), () =>
      createAgentRollbackDirective({
        deviceId: fixture.deviceId,
        targetVersion: TARGET_VERSION,
        reason,
        authorizedBy: fixture.userId,
        stepUpGrantId: grant.id,
        authEpoch: grant.authEpoch,
        mfaEpoch: grant.mfaEpoch,
        sid: grant.sid,
      }))).rejects.toThrow(/component inventory/);
  });
});
