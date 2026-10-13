/**
 * Image-currency pass under real Postgres + forced RLS (code connects as
 * breeze_app), with a stubbed registry. Proves: per-org scoped writes of
 * upstream_* for real org rows, fleet-wide dedup (one lookup per repo:tag),
 * the system-only cache (written for verified-public results only, unreadable
 * and unwritable from an org context), and that VM rows are never touched.
 */
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { containerImageUpstreamCache, devices, deviceWorkloadRuntimes, deviceWorkloads } from '../../db/schema';
import { createOrganization, createPartner, createSite } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { runImageCurrencyPass } from './pass';
import type { LookupArgs, RegistryClient, RegistryLookupResult } from './registryClient';
import { MEDIA_TYPE_DOCKER_MANIFEST, MEDIA_TYPE_OCI_INDEX } from './registryClient';

const D = (c: string) => `sha256:${c.repeat(64)}`;

function stubClient(answers: Record<string, RegistryLookupResult>) {
  const calls: LookupArgs[] = [];
  const client: RegistryClient = {
    lookup: async (args) => {
      calls.push(args);
      return answers[`${args.registry}/${args.path}:${args.tag}`] ?? { kind: 'error', reason: 'unexpected' };
    },
    requestCount: () => calls.length,
  };
  return { client, calls };
}

async function orgWithDevice(name: string) {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: randomUUID(),
      hostname: name,
      osType: 'linux',
      osVersion: '1',
      architecture: 'x64',
      agentVersion: '1.0.0',
    })
    .returning();
  const now = new Date();
  for (const [runtime, complete] of [
    ['docker', true],
    ['podman', false],
    ['proxmox', true],
  ] as const) {
    await getTestDb().insert(deviceWorkloadRuntimes).values({
      deviceId: device!.id,
      orgId: org.id,
      runtime,
      detection: 'present',
      collection: 'ok',
      complete,
      observedCount: 0,
      reportedCount: 0,
      collectedAt: now,
      lastAttemptAt: now,
    });
  }
  return { org, device: device! };
}

async function addWorkload(
  orgId: string,
  deviceId: string,
  workloadId: string,
  over: Partial<typeof deviceWorkloads.$inferInsert> = {},
) {
  await getTestDb()
    .insert(deviceWorkloads)
    .values({
      deviceId,
      orgId,
      runtime: 'docker',
      kind: 'container',
      workloadId,
      name: workloadId,
      state: 'running',
      ...over,
    });
}

const rowsOf = async (deviceId: string) =>
  Object.fromEntries(
    (await getTestDb().select().from(deviceWorkloads).where(eq(deviceWorkloads.deviceId, deviceId))).map((r) => [r.workloadId, r]),
  );

const orgCtx = (orgId: string): DbAccessContext => ({ scope: 'organization', orgId, accessibleOrgIds: [orgId] });

describe('runImageCurrencyPass', () => {
  it('writes upstream_* per org, dedups lookups fleet-wide, caches only public results, never touches VMs', async () => {
    const a = await orgWithDevice('currency-a');
    const b = await orgWithDevice('currency-b');
    // Unique repositories per test run: the cache is global.
    const run = randomUUID().slice(0, 8);
    const nginx = `docker.io/library/nginx-${run}`;
    const app = `ghcr.io/acme/app-${run}`;
    const secret = `ghcr.io/acme/secret-${run}`;

    const img = (repo: string, tag: string, digest: string | null, ref?: string) => ({
      imageRef: ref ?? `${repo}:${tag}`,
      imageRepository: repo,
      imageTag: tag,
      imageDigest: digest,
    });
    await addWorkload(a.org.id, a.device.id, 'current', img(nginx, '1.27', D('b'))); // platform manifest of the index
    await addWorkload(a.org.id, a.device.id, 'behind', img(app, '2', D('c')));
    await addWorkload(a.org.id, a.device.id, 'pinned', img(app, '2', D('c'), `${app}@${D('c')}`));
    await addWorkload(a.org.id, a.device.id, 'local', img('docker.io/library/mybuild', 'latest', null));
    await addWorkload(a.org.id, a.device.id, 'unknown', { ...img(nginx, '1.27', null), runtime: 'podman' });
    await addWorkload(a.org.id, a.device.id, 'private', img(secret, '1', D('d')));
    await addWorkload(a.org.id, a.device.id, 'unsupported', img('registry.example.com/team/x', '1', D('e')));
    await addWorkload(a.org.id, a.device.id, 'vm', { runtime: 'proxmox', kind: 'vm' });
    await addWorkload(b.org.id, b.device.id, 'same-image', img(nginx, '1.27', D('a')));

    const { client, calls } = stubClient({
      [`docker.io/library/nginx-${run}:1.27`]: {
        kind: 'ok',
        digest: D('a'),
        mediaType: MEDIA_TYPE_OCI_INDEX,
        platformDigests: [D('b')],
      },
      [`ghcr.io/acme/app-${run}:2`]: { kind: 'ok', digest: D('f'), mediaType: MEDIA_TYPE_DOCKER_MANIFEST, platformDigests: null },
      [`ghcr.io/acme/secret-${run}:1`]: { kind: 'private' },
    });

    const scope = [a.org.id, b.org.id];
    const summary = await runImageCurrencyPass({ client, onlyOrgIds: scope });

    // One lookup per unique public repo:tag across both orgs; none for pinned/local/unsupported.
    const looked = calls.map((c) => `${c.registry}/${c.path}:${c.tag}`).sort();
    expect(looked).toEqual([`docker.io/library/nginx-${run}:1.27`, `ghcr.io/acme/app-${run}:2`, `ghcr.io/acme/secret-${run}:1`].sort());
    // The nginx lookup carried both orgs' local digests (fleet-wide dedup).
    expect(calls.find((c) => c.path === `library/nginx-${run}`)!.localDigests.slice().sort()).toEqual([D('a'), D('b')]);

    const ra = await rowsOf(a.device.id);
    expect(ra.current).toMatchObject({ upstreamStatus: 'current', upstreamDigest: D('a') });
    expect(ra.behind).toMatchObject({ upstreamStatus: 'behind', upstreamDigest: D('f') });
    expect(ra.pinned).toMatchObject({ upstreamStatus: 'pinned', upstreamDigest: null });
    expect(ra.local).toMatchObject({ upstreamStatus: 'local', upstreamDigest: null });
    expect(ra.unknown).toMatchObject({ upstreamStatus: 'pending', upstreamCheckedAt: null });
    expect(ra.private).toMatchObject({ upstreamStatus: 'private', upstreamDigest: null });
    expect(ra.unsupported).toMatchObject({ upstreamStatus: 'unsupported_registry' });
    expect(ra.vm).toMatchObject({ upstreamStatus: 'pending', upstreamCheckedAt: null });
    expect(ra.current!.upstreamCheckedAt).not.toBeNull();
    expect((await rowsOf(b.device.id))['same-image']).toMatchObject({ upstreamStatus: 'current', upstreamDigest: D('a') });
    expect(summary.lookups).toBe(3);

    // The cache holds the two verified-public results and NOT the private one.
    const cached = await getTestDb()
      .select({ repository: containerImageUpstreamCache.repository })
      .from(containerImageUpstreamCache)
      .where(sql`${containerImageUpstreamCache.repository} LIKE ${'%' + run}`);
    expect(cached.map((c) => c.repository).sort()).toEqual([`acme/app-${run}`, `library/nginx-${run}`]);

    // A second pass finds nothing due for these rows: no lookups.
    const second = stubClient({});
    await runImageCurrencyPass({ client: second.client, onlyOrgIds: scope });
    expect(second.calls.filter((c) => c.path.endsWith(run))).toEqual([]);

    // Make org B's row due again: answered from the cache, still no lookup.
    await getTestDb()
      .update(deviceWorkloads)
      .set({ upstreamCheckedAt: new Date(Date.now() - 7 * 3_600_000) })
      .where(eq(deviceWorkloads.deviceId, b.device.id));
    const third = stubClient({});
    await runImageCurrencyPass({ client: third.client, onlyOrgIds: scope });
    expect(third.calls.filter((c) => c.path.endsWith(run))).toEqual([]);
    expect((await rowsOf(b.device.id))['same-image']!.upstreamCheckedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('a row whose image changed between scan and write is not overwritten', async () => {
    const a = await orgWithDevice('currency-race');
    const run = randomUUID().slice(0, 8);
    const repo = `quay.io/acme/race-${run}`;
    await addWorkload(a.org.id, a.device.id, 'w', { imageRef: `${repo}:1`, imageRepository: repo, imageTag: '1', imageDigest: D('a') });
    const client: RegistryClient = {
      lookup: async () => {
        // Ingest lands a new digest while the registry call is in flight.
        await getTestDb().update(deviceWorkloads).set({ imageDigest: D('9') }).where(eq(deviceWorkloads.deviceId, a.device.id));
        return { kind: 'ok', digest: D('b'), mediaType: MEDIA_TYPE_DOCKER_MANIFEST, platformDigests: null };
      },
      requestCount: () => 1,
    };
    await runImageCurrencyPass({ client, onlyOrgIds: [a.org.id] });
    expect((await rowsOf(a.device.id)).w).toMatchObject({ imageDigest: D('9'), upstreamStatus: 'pending' });
  });

  it('the per-pass lookup cap leaves the remainder due for the next pass', async () => {
    const a = await orgWithDevice('currency-cap');
    const run = randomUUID().slice(0, 8);
    for (const n of [1, 2, 3]) {
      const repo = `quay.io/acme/cap${n}-${run}`;
      await addWorkload(a.org.id, a.device.id, `w${n}`, { imageRef: `${repo}:1`, imageRepository: repo, imageTag: '1', imageDigest: D('a') });
    }
    const { client, calls } = stubClient(
      Object.fromEntries(
        [1, 2, 3].map((n) => [`quay.io/acme/cap${n}-${run}:1`, { kind: 'ok', digest: D('a'), mediaType: null, platformDigests: null }]),
      ) as Record<string, RegistryLookupResult>,
    );
    const summary = await runImageCurrencyPass({ client, maxLookups: 2, onlyOrgIds: [a.org.id] });
    expect(calls.map((c) => c.path)).toEqual([`acme/cap1-${run}`, `acme/cap2-${run}`]);
    expect(summary).toMatchObject({ lookups: 2, deferredLookups: 1, groupsLeftDue: 1 });
    expect((await rowsOf(a.device.id)).w3).toMatchObject({ upstreamStatus: 'pending', upstreamCheckedAt: null });
  });

  it('a throttled registry does not burn the lookup budget of other registries', async () => {
    const a = await orgWithDevice('currency-throttle');
    const run = randomUUID().slice(0, 8);
    const hub = (n: number) => `docker.io/acme/hub${n}-${run}`;
    const gh = `ghcr.io/acme/app-${run}`;
    for (const [id, repo] of [['h1', hub(1)], ['h2', hub(2)], ['g', gh]] as const) {
      await addWorkload(a.org.id, a.device.id, id, { imageRef: `${repo}:1`, imageRepository: repo, imageTag: '1', imageDigest: D('a') });
    }
    const calls: string[] = [];
    const client: RegistryClient = {
      lookup: async (args) => {
        calls.push(`${args.registry}/${args.path}`);
        return args.registry === 'docker.io'
          ? { kind: 'skipped', reason: 'registry_throttled' }
          : { kind: 'ok', digest: D('a'), mediaType: MEDIA_TYPE_DOCKER_MANIFEST, platformDigests: null };
      },
      requestCount: () => calls.length,
    };
    await runImageCurrencyPass({ client, maxLookups: 1, lookupConcurrency: 1, onlyOrgIds: [a.org.id] });
    const rows = await rowsOf(a.device.id);
    expect(rows.g).toMatchObject({ upstreamStatus: 'current' });
    expect(rows.h1).toMatchObject({ upstreamStatus: 'pending' });
  });

  it('a lookup that throws is recorded as error for its rows only; the rest of the pass completes', async () => {
    const a = await orgWithDevice('currency-throw');
    const run = randomUUID().slice(0, 8);
    for (const [id, repo] of [['bad', `quay.io/acme/bad-${run}`], ['good', `quay.io/acme/good-${run}`]] as const) {
      await addWorkload(a.org.id, a.device.id, id, { imageRef: `${repo}:1`, imageRepository: repo, imageTag: '1', imageDigest: D('a') });
    }
    const client: RegistryClient = {
      lookup: async (args) => {
        if (args.path.startsWith('acme/bad')) throw new Error('boom');
        return { kind: 'ok', digest: D('a'), mediaType: MEDIA_TYPE_DOCKER_MANIFEST, platformDigests: null };
      },
      requestCount: () => 0,
    };
    await runImageCurrencyPass({ client, onlyOrgIds: [a.org.id] });
    const rows = await rowsOf(a.device.id);
    expect(rows.bad).toMatchObject({ upstreamStatus: 'error' });
    expect(rows.good).toMatchObject({ upstreamStatus: 'current' });
  });

  it('the group cap is shared fairly across orgs', async () => {
    const x = await orgWithDevice('currency-fair-x');
    const y = await orgWithDevice('currency-fair-y');
    const run = randomUUID().slice(0, 8);
    for (const n of [1, 2, 3]) {
      await addWorkload(x.org.id, x.device.id, `x${n}`, { imageRef: `mine${n}:1`, imageRepository: `docker.io/library/a${n}-${run}`, imageTag: '1', imageDigest: null });
    }
    await addWorkload(y.org.id, y.device.id, 'y1', { imageRef: 'z:1', imageRepository: `docker.io/library/z-${run}`, imageTag: '1', imageDigest: null });
    const { client } = stubClient({});
    await runImageCurrencyPass({ client, maxGroups: 2, onlyOrgIds: [x.org.id, y.org.id] });
    expect((await rowsOf(y.device.id)).y1).toMatchObject({ upstreamStatus: 'local' });
    const xs = Object.values(await rowsOf(x.device.id)).map((r) => r.upstreamStatus).sort();
    expect(xs).toEqual(['local', 'pending', 'pending']);
  });

  it('an error row is retried after 1 h; a definitive answer waits 6 h', async () => {
    const a = await orgWithDevice('currency-retry');
    const run = randomUUID().slice(0, 8);
    const ninetyMinAgo = new Date(Date.now() - 90 * 60_000);
    for (const [id, status] of [['err', 'error'], ['cur', 'current']] as const) {
      const repo = `quay.io/acme/${id}-${run}`;
      await addWorkload(a.org.id, a.device.id, id, {
        imageRef: `${repo}:1`, imageRepository: repo, imageTag: '1', imageDigest: D('a'),
        upstreamStatus: status, upstreamCheckedAt: ninetyMinAgo,
      });
    }
    const { client, calls } = stubClient({});
    await runImageCurrencyPass({ client, onlyOrgIds: [a.org.id] });
    expect(calls.map((c) => c.path)).toEqual([`acme/err-${run}`]);
  });

  it('the cache is system-only: an org context reads zero rows and cannot write', async () => {
    const a = await orgWithDevice('currency-rls');
    await getTestDb().insert(containerImageUpstreamCache).values({
      registry: 'docker.io',
      repository: `library/rls-${randomUUID().slice(0, 8)}`,
      tag: '1',
      digest: D('a'),
      checkedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const visible = await withDbAccessContext(orgCtx(a.org.id), () =>
      db.select().from(containerImageUpstreamCache),
    );
    expect(visible).toEqual([]);
    const forged = await withDbAccessContext(orgCtx(a.org.id), () =>
        db.insert(containerImageUpstreamCache).values({
          registry: 'docker.io',
          repository: 'library/forged',
          tag: '1',
          digest: D('f'),
          checkedAt: new Date(),
          expiresAt: new Date(Date.now() + 3_600_000),
        }),
    ).then(
      () => null,
      (err: { cause?: { message?: string } }) => String(err.cause?.message ?? err),
    );
    expect(forged).toMatch(/row-level security/);
  });
});
