/**
 * #11812 — POST /agent-versions/promote for a row signed with the
 * per-deployment key (signing_key_id = deploy-…), called by a platform admin
 * whose session is partner-scoped, against real PostgreSQL through the real
 * router.
 *
 * The deploy-key branch verifies the signature against `manifest_signing_keys`,
 * which forced RLS lets only system scope read. The request runs inside the
 * caller's partner-scoped context, and a nested withSystemDbAccessContext just
 * joins it, so before the fix the key read returned no rows and every target
 * failed closed with 409 invalid_release_manifest_signature.
 *
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/agentVersionsPromoteDeployKey.integration.test.ts
 */
import './setup';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentVersions, manifestSigningKeys, users } from '../../db/schema';
import { agentVersionRoutes } from '../../routes/agentVersions';
import { getBinaryEdition } from '../../services/binaryEdition';
import { createAccessToken } from '../../services/jwt';
import {
  ensureActiveSigningKey,
  invalidateManifestTrustCaches,
  signManifest,
} from '../../services/manifestSigning';
import { createIntegrationTestClient } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// `manifest_signing_keys` is not truncated between tests, and later suites in
// the same run expect a deployment without a key (see deviceReattachFixtures),
// so remove exactly the key this suite created.
let preexistingKeyIds: string[] = [];
let deployKeyId = '';
// `agent_versions` is not truncated between tests either; drop this suite's rows.
const insertedPlatforms: string[] = [];

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  preexistingKeyIds = (await getTestDb().select({ keyId: manifestSigningKeys.keyId }).from(manifestSigningKeys))
    .map((r) => r.keyId);
  deployKeyId = (await ensureActiveSigningKey()).keyId;
});

afterAll(async () => {
  if (!process.env.DATABASE_URL) return;
  if (insertedPlatforms.length > 0) {
    await getTestDb().delete(agentVersions).where(inArray(agentVersions.platform, insertedPlatforms));
  }
  await getTestDb().delete(manifestSigningKeys).where(
    preexistingKeyIds.length > 0 ? notInArray(manifestSigningKeys.keyId, preexistingKeyIds) : sql`true`,
  );
  invalidateManifestTrustCaches();
});

/** A partner-scoped, MFA-assured platform admin session and a client for it. */
async function partnerScopedPlatformAdmin() {
  const app = new Hono();
  app.route('/agent-versions', agentVersionRoutes);
  const client = await createIntegrationTestClient(app, { scope: 'partner' });
  await getTestDb().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, client.env.user.id));
  const token = await createAccessToken({
    sub: client.env.user.id,
    email: client.env.user.email,
    roleId: client.env.role.id,
    orgId: null,
    partnerId: client.env.partner.id,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });
  return async (body: unknown) => {
    const res = await app.request('/agent-versions/promote', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
}

/**
 * Insert one unpromoted agent row exactly as binary sync registers it in
 * local mode (applyDeploymentSigning): a normalized manifest signed with the
 * deployment key. A unique platform keeps the row's isLatest slot private to
 * this test.
 */
async function insertDeploySignedRow(opts: { signature?: string } = {}) {
  const version = `0.0.${randomBytes(3).readUIntBE(0, 3)}`;
  const platform = `promote-${randomBytes(4).toString('hex')}`;
  insertedPlatforms.push(platform);
  const downloadUrl = `https://example.invalid/agent/${version}/${platform}`;
  const checksum = randomBytes(32).toString('hex');
  const size = 1234;
  const releaseManifest = JSON.stringify({
    version, component: 'agent', platform, arch: 'amd64', url: downloadUrl, checksum, size,
  });
  await getTestDb().insert(agentVersions).values({
    version,
    platform,
    architecture: 'amd64',
    component: 'agent',
    downloadUrl,
    checksum,
    fileSize: BigInt(size),
    releaseManifest,
    manifestSignature: opts.signature ?? await signManifest(releaseManifest),
    signingKeyId: deployKeyId,
    edition: getBinaryEdition(),
    isLatest: false,
  });
  return { version, platform };
}

async function isLatest(version: string, platform: string): Promise<boolean | undefined> {
  const [row] = await getTestDb()
    .select({ isLatest: agentVersions.isLatest })
    .from(agentVersions)
    .where(and(eq(agentVersions.version, version), eq(agentVersions.platform, platform)));
  return row?.isLatest;
}

describe('POST /agent-versions/promote — deploy-signed rows, partner-scoped platform admin (#11812)', () => {
  runDb('promotes a row signed with the deployment key', async () => {
    const promote = await partnerScopedPlatformAdmin();
    const { version, platform } = await insertDeploySignedRow();

    const res = await promote({ version, component: 'agent' });

    expect(res).toMatchObject({
      status: 200,
      body: { promoted: [{ component: 'agent', platform, architecture: 'amd64', version }] },
    });
    // The promote write runs in the caller's own context; prove it landed.
    expect(await isLatest(version, platform)).toBe(true);
  });

  runDb('still refuses a deploy-key row whose signature does not verify', async () => {
    const promote = await partnerScopedPlatformAdmin();
    // A well-formed Ed25519-sized signature over different bytes.
    const forged = await signManifest(JSON.stringify({ forged: randomUUID() }));
    const { version, platform } = await insertDeploySignedRow({ signature: forged });

    const res = await promote({ version, component: 'agent' });

    expect(res).toMatchObject({
      status: 409,
      body: {
        reason: 'invalid_release_manifest_signature',
        invalidTargets: [{ component: 'agent', platform, architecture: 'amd64', reason: 'invalid_release_manifest_signature' }],
      },
    });
    expect(await isLatest(version, platform)).toBe(false);
  });
});
