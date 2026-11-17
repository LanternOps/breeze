/**
 * Wisp analysis sessions W05 — the alerts, patch_state, patch_attempts and
 * change_log `export_dataset` adapters on real Postgres, as the unprivileged
 * app role under forced RLS.
 *
 * What only a real database can show: `patch_job_results` has no `org_id`, so
 * its org scope is `patch_jobs.org_id` AND the run's device set; the site axis
 * comes only from the device set; the keyset cursors keep microsecond
 * precision across pages; the `user_account` gate is a SQL predicate.
 *
 * Fixtures are re-seeded per test (the integration setup truncates between
 * tests).
 */
import './setup';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { DATASET_ADAPTERS, EXPORT_DATASETS, type DatasetRequest, type ExportDataset } from '../../services/aiToolsExportDatasets';
import { USER_ACCOUNT_CHANGES_NOTE } from '../../services/aiToolsExportDatasets/changes';
import type { AiTool } from '../../services/aiTools';
import type { AuthContext } from '../../middleware/auth';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

// Only the artifact sink and run progress are replaced; the handler, the
// adapters and the database are real.
const artifactBodies: string[] = [];
vi.mock('../../services/artifacts/artifactService', () => ({
  createArtifact: async (input: { body: NodeJS.ReadableStream }) => {
    const chunks: Buffer[] = [];
    for await (const c of input.body) chunks.push(Buffer.from(c as Buffer));
    artifactBodies.push(Buffer.concat(chunks).toString('utf8'));
    return { id: 'art-1' };
  },
}));
vi.mock('../../services/aiAgents/runProgress', () => ({ emitRunProgress: vi.fn(async () => undefined) }));

const runDb = it.runIf(!!process.env.DATABASE_URL);
const DAY_MS = 86_400_000;

type Tenant = {
  orgA: string; orgB: string; siteS1: string; siteS2: string;
  a1: string; a2: string; b1: string;
  jobA: string; jobB: string;
};

const DATASETS = ['alerts', 'patch_state', 'patch_attempts', 'change_log'] as const satisfies readonly ExportDataset[];

function tsText(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString().replace('T', ' ').slice(0, 19);
}

const rangeAround = (daysAgo: number) => ({
  start: new Date(Date.now() - (daysAgo + 0.5) * DAY_MS).toISOString(),
  end: new Date(Date.now() - (daysAgo - 0.5) * DAY_MS).toISOString(),
});

async function seedPatch(title = 'KB1'): Promise<string> {
  const [row] = await getTestDb().execute(sql`
    INSERT INTO patches (source, external_id, title)
    VALUES ('microsoft', ${`KB-${randomUUID()}`}, ${title})
    RETURNING id::text AS id`) as unknown as Array<{ id: string }>;
  return row!.id;
}

async function seedDevicePatch(orgId: string, deviceId: string, patchId: string, status: string): Promise<void> {
  await getTestDb().execute(sql`
    INSERT INTO device_patches (device_id, org_id, patch_id, status)
    VALUES (${deviceId}, ${orgId}, ${patchId}, ${status}::device_patch_status)`);
}

async function seedAlert(
  orgId: string, deviceId: string, ts: string,
  o: { title?: string; message?: string; topologySite?: string } = {},
): Promise<string> {
  const title = o.title ?? 'High CPU';
  const message = o.message ?? 'cpu is high';
  const rows = (o.topologySite
    ? await getTestDb().execute(sql`
        INSERT INTO alerts (org_id, device_id, owner_kind, topology_site_id, topology_source_key, status, severity, title, message, triggered_at)
        VALUES (${orgId}, ${deviceId}, 'topology_site', ${o.topologySite},
                ${`topology:${createHash('sha256').update(randomUUID()).digest('hex')}`},
                'active', 'high', ${title}, ${message}, ${ts}::timestamp)
        RETURNING id::text AS id`)
    : await getTestDb().execute(sql`
        INSERT INTO alerts (org_id, device_id, owner_kind, status, severity, title, message, triggered_at)
        VALUES (${orgId}, ${deviceId}, 'device', 'active', 'high', ${title}, ${message}, ${ts}::timestamp)
        RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

async function seedChange(orgId: string, deviceId: string, ts: string, changeType: string, subject = 'Thing'): Promise<string> {
  const [row] = await getTestDb().execute(sql`
    INSERT INTO device_change_log (device_id, org_id, fingerprint, timestamp, change_type, change_action, subject)
    VALUES (${deviceId}, ${orgId}, ${createHash('sha256').update(randomUUID()).digest('hex')}, ${ts}::timestamp,
            ${changeType}::change_type, 'added', ${subject})
    RETURNING id::text AS id`) as unknown as Array<{ id: string }>;
  return row!.id;
}

async function seedJob(orgId: string, name: string): Promise<string> {
  const [row] = await getTestDb().execute(sql`
    INSERT INTO patch_jobs (org_id, name) VALUES (${orgId}, ${name}) RETURNING id::text AS id`) as unknown as Array<{ id: string }>;
  return row!.id;
}

async function seedResult(jobId: string, deviceId: string, patchId: string | null, ts: string = tsText(1)): Promise<string> {
  const [row] = await getTestDb().execute(sql`
    INSERT INTO patch_job_results (job_id, device_id, patch_id, status, output, created_at)
    VALUES (${jobId}, ${deviceId}, ${patchId}, 'completed', 'RAW-INSTALLER-OUTPUT', ${ts}::timestamp)
    RETURNING id::text AS id`) as unknown as Array<{ id: string }>;
  return row!.id;
}

/** Org A (S1/A1, S2/A2) and org B (B1), plus a baseline of rows for every dataset. */
async function seedTenant(): Promise<Tenant> {
  const t = await withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const s1 = await createSite({ orgId: orgA.id });
    const s2 = await createSite({ orgId: orgA.id });
    const sB = await createSite({ orgId: orgB.id });
    const a1 = await createDevice({ orgId: orgA.id, siteId: s1.id, hostname: 'a1' });
    const a2 = await createDevice({ orgId: orgA.id, siteId: s2.id, hostname: 'a2' });
    const b1 = await createDevice({ orgId: orgB.id, siteId: sB.id, hostname: 'b1' });
    return { orgA: orgA.id, orgB: orgB.id, siteS1: s1.id, siteS2: s2.id, a1: a1.id, a2: a2.id, b1: b1.id };
  });
  return withSystemDbAccessContext(async () => {
    for (const [org, dev] of [[t.orgA, t.a1], [t.orgA, t.a2], [t.orgB, t.b1]] as const) {
      await seedAlert(org, dev, tsText(1));
      await seedAlert(org, dev, tsText(2));
      const p1 = await seedPatch();
      const p2 = await seedPatch();
      const p3 = await seedPatch();
      await seedDevicePatch(org, dev, p1, 'pending');
      await seedDevicePatch(org, dev, p2, 'installed');
      await seedDevicePatch(org, dev, p3, 'missing');
      await seedChange(org, dev, tsText(1), 'software');
      await seedChange(org, dev, tsText(2), 'user_account', 'alice');
    }
    await seedAlert(t.orgA, t.a1, tsText(1), { topologySite: t.siteS1 });
    const jobA = await seedJob(t.orgA, 'job A');
    const jobB = await seedJob(t.orgB, 'job B');
    const pa = await seedPatch('Result patch');
    await seedResult(jobA, t.a1, pa);
    await seedResult(jobA, t.a2, pa);
    await seedResult(jobB, t.b1, pa);
    return { ...t, jobA, jobB };
  });
}

function ctxA(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], userId: null };
}
function ctxAB(orgA: string, orgB: string): DbAccessContext {
  return { scope: 'organization', orgId: orgA, accessibleOrgIds: [orgA, orgB], userId: null };
}

function runAuth(orgId: string, frame: string[], sites?: string[]): AuthContext {
  return {
    orgId,
    accessibleOrgIds: [orgId],
    canAccessOrg: (id: string) => id === orgId,
    principal: { kind: 'ai_agent', agentId: randomUUID(), runId: randomUUID() },
    allowedDeviceIds: frame,
    ...(sites ? { allowedSiteIds: sites, canAccessSite: (s: string | null | undefined) => !!s && sites.includes(s) } : {}),
  } as unknown as AuthContext;
}

function request(orgId: string, frame: string[], o: Partial<DatasetRequest> = {}): DatasetRequest {
  return {
    auth: runAuth(orgId, frame),
    orgId,
    filters: {},
    deviceIds: null,
    runTargets: frame,
    siteId: null,
    pageSize: 500,
    exportGrants: { datasets: [...EXPORT_DATASETS], sensitiveGates: [] },
    notes: [],
    ...o,
  };
}

type Row = Record<string, unknown>;

async function drain(dataset: ExportDataset, req: DatasetRequest, ctx: DbAccessContext = ctxA(req.orgId)) {
  return withDbAccessContext(ctx, async () => {
    const pager = await DATASET_ADAPTERS[dataset].createPager(req);
    const pages: Array<{ rows: Row[]; nextCursor: string | null }> = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard++) {
      const page = await pager(cursor);
      pages.push(page);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return { pages, rows: pages.flatMap((p) => p.rows) };
  });
}

const devicesOf = (rows: Row[]) => [...new Set(rows.map((r) => r.deviceId as string))].sort();

describe('export_dataset W05 datasets on real Postgres (breeze_app, forced RLS)', () => {
  runDb('the code under test runs as a non-BYPASSRLS role (guards against vacuous RLS)', async () => {
    const t = await seedTenant();
    const rows = await withDbAccessContext(ctxA(t.orgA), () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row?.who).toBe('breeze_app');
    expect(row?.rolbypassrls).toBe(false);
  });

  describe.each(DATASETS)('%s', (dataset) => {
    // Rows for A1 + A2: alerts 2 each, patch_state 2 each (missing excluded),
    // patch_attempts 1 each, change_log 1 each (user_account gated).
    const expectedA = { alerts: 4, patch_state: 4, patch_attempts: 2, change_log: 2 }[dataset];

    describe.each([['org-A-only context', false], ['[A, B] context', true]] as const)('under %s', (_label, both) => {
      runDb('org isolation: a frame naming another org\'s device never reads it', async () => {
        const t = await seedTenant();
        const ctx = both ? ctxAB(t.orgA, t.orgB) : ctxA(t.orgA);
        const { rows } = await drain(dataset, request(t.orgA, [t.a1, t.a2, t.b1]), ctx);
        expect(devicesOf(rows)).toEqual([t.a1, t.a2].sort());
        expect(rows).toHaveLength(expectedA);
        const json = JSON.stringify(rows);
        expect(json).not.toContain(t.b1);
        expect(json).not.toContain(t.orgB);
        if (dataset === 'patch_attempts') expect(json).not.toContain(t.jobB);
      });
    });

    runDb('site restriction applies through the device set', async () => {
      const t = await seedTenant();
      const frame = [t.a1, t.a2];
      const { rows } = await drain(dataset, request(t.orgA, frame, { auth: runAuth(t.orgA, frame, [t.siteS1]) }));
      expect(devicesOf(rows)).toEqual([t.a1]);
      expect(rows.length).toBeGreaterThan(0);
    });

    runDb('a frame with nothing in this org exports nothing', async () => {
      const t = await seedTenant();
      const { rows } = await drain(dataset, request(t.orgA, [t.b1]));
      expect(rows).toEqual([]);
    });
  });

  describe('patch_attempts org scope (job org AND device set)', () => {
    runDb('a job in another org naming an in-org device is absent, even when [A, B] is visible', async () => {
      const t = await seedTenant();
      const foreign = await withSystemDbAccessContext(async () => seedResult(t.jobB, t.a1, await seedPatch()));
      const { rows } = await drain('patch_attempts', request(t.orgA, [t.a1, t.a2]), ctxAB(t.orgA, t.orgB));
      expect(rows.map((r) => r.id)).not.toContain(foreign);
      expect(rows.every((r) => r.jobId === t.jobA)).toBe(true);
      expect(rows).toHaveLength(2);
    });

    runDb('an in-org job result whose device moved to another org is absent', async () => {
      const t = await seedTenant();
      await withSystemDbAccessContext(() => getTestDb().execute(sql`UPDATE devices SET org_id = ${t.orgB}, site_id = (SELECT id FROM sites WHERE org_id = ${t.orgB} LIMIT 1) WHERE id = ${t.a2}`));
      for (const ctx of [ctxA(t.orgA), ctxAB(t.orgA, t.orgB)]) {
        const { rows } = await drain('patch_attempts', request(t.orgA, [t.a1, t.a2]), ctx);
        expect(devicesOf(rows)).toEqual([t.a1]);
      }
    });

    runDb('a whole-device summary row (no patch) is exported with a null patch title, and output never is', async () => {
      const t = await seedTenant();
      const summary = await withSystemDbAccessContext(() => seedResult(t.jobA, t.a1, null));
      const { rows } = await drain('patch_attempts', request(t.orgA, [t.a1]));
      const row = rows.find((r) => r.id === summary);
      expect(row).toBeDefined();
      expect(row!.patchId).toBeNull();
      expect(row!.patchTitle).toBeNull();
      expect(JSON.stringify(rows)).not.toContain('RAW-INSTALLER-OUTPUT');
    });
  });

  runDb('alerts: a topology-site alert whose device_id is in the frame is not exported', async () => {
    const t = await seedTenant();
    const { rows } = await drain('alerts', request(t.orgA, [t.a1]));
    expect(rows).toHaveLength(2);
    const topo = await getTestDb().execute(sql`SELECT id::text AS id FROM alerts WHERE owner_kind = 'topology_site' AND device_id = ${t.a1}`) as unknown as Array<{ id: string }>;
    expect(topo).toHaveLength(1);
    expect(rows.map((r) => r.id)).not.toContain(topo[0]!.id);
  });

  runDb('patch_state: no missing row, and each remaining row is pending or installed', async () => {
    const t = await seedTenant();
    const { rows } = await drain('patch_state', request(t.orgA, [t.a1, t.a2]));
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.status).sort()).toEqual(['installed', 'installed', 'pending', 'pending']);
  });

  describe('change_log user_account_changes gate', () => {
    runDb('without the gate no user_account row leaves, and the note says so', async () => {
      const t = await seedTenant();
      const req = request(t.orgA, [t.a1, t.a2]);
      const { rows } = await drain('change_log', req);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.changeType === 'software')).toBe(true);
      expect(req.notes).toContain(USER_ACCOUNT_CHANGES_NOTE);
    });

    runDb('with the gate user_account rows appear and no gate note is added', async () => {
      const t = await seedTenant();
      const req = request(t.orgA, [t.a1, t.a2], {
        exportGrants: { datasets: [...EXPORT_DATASETS], sensitiveGates: ['user_account_changes'] },
      });
      const { rows } = await drain('change_log', req);
      expect(rows).toHaveLength(4);
      expect(rows.filter((r) => r.changeType === 'user_account')).toHaveLength(2);
      expect(req.notes).not.toContain(USER_ACCOUNT_CHANGES_NOTE);
    });

    runDb('through the export_dataset handler: notes carry the gate note and sensitiveRowsWithheld names the gate', async () => {
      const t = await seedTenant();
      const { registerExportTools } = await import('../../services/aiToolsExport');
      const map = new Map<string, AiTool>();
      registerExportTools(map);
      const tool = map.get('export_dataset')!;
      const frame = [t.a1, t.a2];
      artifactBodies.length = 0;
      const raw = await withDbAccessContext(ctxA(t.orgA), () => tool.handler(
        { dataset: 'change_log', format: 'jsonl' },
        runAuth(t.orgA, frame),
        {
          runTargets: frame,
          stagedBytesRemaining: 10_000_000,
          exportGrants: { datasets: [...EXPORT_DATASETS], sensitiveGates: [] },
        } as never,
      ));
      const parsed = JSON.parse(raw);
      expect(parsed.error).toBeUndefined();
      expect(parsed.notes).toContain(USER_ACCOUNT_CHANGES_NOTE);
      expect(parsed.sensitiveRowsWithheld).toEqual(['user_account_changes']);
      expect(parsed.artifact.rows).toBe(2);
      expect(artifactBodies[0]).not.toContain('user_account');
    });
  });

  describe('paging at pageSize 1 keeps microsecond order: no repeat, no skip, null last cursor', () => {
    const micros = ['123401', '123402', '123403'];

    runDb('alerts', async () => {
      const t = await seedTenant();
      const base = tsText(3);
      const ids: string[] = [];
      for (const m of micros) ids.push(await seedAlert(t.orgA, t.a1, `${base}.${m}`));
      const { pages, rows } = await drain('alerts', request(t.orgA, [t.a1], { pageSize: 1, filters: { timeRange: rangeAround(3) } }));
      expect(rows.map((r) => r.id)).toEqual([...ids].reverse());
      expect(pages[pages.length - 1]!.nextCursor).toBeNull();
    });

    runDb('change_log', async () => {
      const t = await seedTenant();
      const base = tsText(3);
      const ids: string[] = [];
      for (const m of micros) ids.push(await seedChange(t.orgA, t.a1, `${base}.${m}`, 'software'));
      const { pages, rows } = await drain('change_log', request(t.orgA, [t.a1], { pageSize: 1, filters: { timeRange: rangeAround(3) } }));
      expect(rows.map((r) => r.id)).toEqual([...ids].reverse());
      expect(pages[pages.length - 1]!.nextCursor).toBeNull();
    });

    runDb('patch_attempts', async () => {
      const t = await seedTenant();
      const base = tsText(3);
      const p = await seedPatch();
      const ids: string[] = [];
      for (const m of micros) ids.push(await seedResult(t.jobA, t.a1, p, `${base}.${m}`));
      const { pages, rows } = await drain('patch_attempts', request(t.orgA, [t.a1], { pageSize: 1, filters: { timeRange: rangeAround(3) } }));
      expect(rows.map((r) => r.id)).toEqual([...ids].reverse());
      expect(pages[pages.length - 1]!.nextCursor).toBeNull();
    });

    runDb('patch_state', async () => {
      const t = await seedTenant();
      for (let i = 0; i < 3; i++) await seedDevicePatch(t.orgA, t.a1, await seedPatch(), 'pending');
      const { pages, rows } = await drain('patch_state', request(t.orgA, [t.a1], { pageSize: 1 }));
      // Baseline: A1 already has a pending and an installed row.
      expect(rows).toHaveLength(5);
      expect(new Set(rows.map((r) => r.id)).size).toBe(5);
      expect(pages[pages.length - 1]!.nextCursor).toBeNull();
    });
  });

  runDb('redaction applies to stored alert data: secrets and signed-URL queries never leave', async () => {
    const t = await seedTenant();
    await seedAlert(t.orgA, t.a1, tsText(1), {
      title: 'Backup failed',
      message: 'login failed password=hunter2 for https://acct.blob.core.windows.net/c?sig=S',
    });
    const { rows } = await drain('alerts', request(t.orgA, [t.a1]));
    const json = JSON.stringify(rows);
    expect(rows.some((r) => r.title === 'Backup failed')).toBe(true);
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('sig=');
  });

  runDb('alerts: the default window is 30 days; an explicit timeRange reaches further back', async () => {
    const t = await seedTenant();
    const old = await seedAlert(t.orgA, t.a1, tsText(31));
    expect((await drain('alerts', request(t.orgA, [t.a1]))).rows.map((r) => r.id)).not.toContain(old);
    const start = new Date(Date.now() - 35 * DAY_MS).toISOString();
    const { rows } = await drain('alerts', request(t.orgA, [t.a1], { filters: { timeRange: { start } } }));
    expect(rows.map((r) => r.id)).toContain(old);
  });
});
