import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { agentVersions } from '../../db/schema';
import { resolvePinnedUpgradeTarget } from '../../routes/agents/helpers';
import { getBinaryEdition } from '../../services/binaryEdition';

// #6872: with no component=helper row, heartbeat's bootstrap offer resolves
// null and Assist is never installed. This pins that a registered helper row
// is what resolvePinnedUpgradeTarget returns for the bootstrap branch.
describe('helper bootstrap offer resolves the registered helper row (#6872)', () => {
  const version = '0.0.1-helper-6872';

  beforeAll(async () => {
    await withSystemDbAccessContext(() =>
      db.insert(agentVersions).values({
        version,
        platform: 'windows',
        architecture: 'amd64',
        component: 'helper',
        edition: getBinaryEdition(),
        isLatest: true,
        downloadUrl: 'http://localhost:3001/api/v1/agents/download/helper/windows/amd64',
        checksum: '0'.repeat(64),
        fileSize: BigInt(1),
        releaseManifest: '{}',
        manifestSignature: 'sig',
        signingKeyId: 'test',
      }),
    );
  });

  afterAll(async () => {
    await withSystemDbAccessContext(() =>
      db.delete(agentVersions).where(eq(agentVersions.version, version)),
    );
  });

  it('returns the helper version for pin:null on the matching platform/arch', async () => {
    const target = await withSystemDbAccessContext(() =>
      resolvePinnedUpgradeTarget({
        component: 'helper',
        platform: 'windows',
        architecture: 'amd64',
        pin: null,
      }),
    );
    expect(target).toBe(version);
  });

  it('returns null for a platform with no helper row', async () => {
    // `architecture: 'arm64-none-6872'` rather than a real arch (e.g. linux/arm64):
    // a real (platform, architecture) pair could legitimately be populated by
    // another suite sharing this DB, which would make this case flaky rather
    // than a true "no row" assertion. This value can never exist as a genuine
    // helper row.
    const target = await withSystemDbAccessContext(() =>
      resolvePinnedUpgradeTarget({
        component: 'helper',
        platform: 'linux',
        architecture: 'arm64-none-6872',
        pin: null,
      }),
    );
    expect(target).toBeNull();
  });
});
