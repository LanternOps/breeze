/**
 * fetchElevationAuditExportPage against real Postgres (#4910): RLS bounds the
 * export to the caller's org whatever org is asked for, the site allowlist
 * narrows it, the recorded-time (created_at, id) keyset walks every event
 * exactly once at microsecond precision (including exact ties), a late event
 * with a backdated occurred_at is still exported, rows inside the settle
 * delay wait for a later resume, the [from, to) window is half-open, and raw
 * `details` never leaks.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices, elevationAudit, elevationRequests, sites } from '../../db/schema';
import { decodeExportCursor, fetchElevationAuditExportPage } from '../../services/pamAuditExport';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

const createdOrgIds: string[] = [];
afterEach(async () => {
  const ids = [...createdOrgIds];
  createdOrgIds.length = 0;
  if (ids.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db.delete(elevationAudit).where(inArray(elevationAudit.orgId, ids));
    await db.delete(elevationRequests).where(inArray(elevationRequests.orgId, ids));
    await db.delete(devices).where(inArray(devices.orgId, ids));
    await db.delete(sites).where(inArray(sites.orgId, ids));
  });
});

/** An org with one site, one device and one elevation request. */
async function seedRequest(orgId: string, partnerId: string) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [row] = (await db.execute(sql`
      WITH inserted_site AS (
        INSERT INTO sites (org_id, name) VALUES (${orgId}, ${`site-${randomUUID()}`}) RETURNING id
      ), inserted_device AS (
        INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
        SELECT ${orgId}, id, ${`agent-${randomUUID()}`}, ${`host-${randomUUID()}`}, 'windows', '11', 'amd64', '2.0.0'
        FROM inserted_site
        RETURNING id, site_id
      )
      INSERT INTO elevation_requests (
        org_id, site_id, partner_id, device_id, flow_type, subject_username, reason,
        target_executable_path, status
      )
      SELECT ${orgId}, site_id, ${partnerId}, id, 'uac_intercept', 'alice', 'export test',
             'C:\\Tools\\setup.exe', 'pending'
      FROM inserted_device
      RETURNING id, site_id, device_id
    `)) as unknown as Array<{ id: string; site_id: string; device_id: string }>;
    return row!;
  });
}

/** `recordedAt` becomes created_at; occurred_at defaults to the same instant. */
async function seedEvent(
  orgId: string,
  requestId: string,
  recordedAt: string,
  details: Record<string, unknown> = {},
  occurredAt: string = recordedAt,
) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [row] = await db
      .insert(elevationAudit)
      .values({
        orgId,
        elevationRequestId: requestId,
        eventType: 'approved',
        actor: 'technician',
        details,
        occurredAt: sql`${occurredAt}::timestamptz` as unknown as Date,
        createdAt: sql`${recordedAt}::timestamptz` as unknown as Date,
      })
      .returning({ id: elevationAudit.id });
    return row!.id;
  });
}

async function fixture() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  createdOrgIds.push(orgA.id, orgB.id);
  const reqA1 = await seedRequest(orgA.id, partner.id);
  const reqA2 = await seedRequest(orgA.id, partner.id);
  const reqB = await seedRequest(orgB.id, partner.id);
  return { partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, reqA1, reqA2, reqB };
}

const WINDOW = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z') };

type After = { recordedAt: string; id: string } | null;

function fetchPage(
  orgId: string,
  opts: { limit: number; after?: After; allowedSiteIds?: readonly string[]; askOrgId?: string },
) {
  return withDbAccessContext(orgContext(orgId), () =>
    fetchElevationAuditExportPage({
      orgCondition: undefined,
      allowedSiteIds: opts.allowedSiteIds,
      filters: { ...WINDOW, orgId: opts.askOrgId ?? orgId },
      after: opts.after ?? null,
      limit: opts.limit,
    }),
  );
}

/** Pages until hasMore is false; returns the ids seen and the final resume cursor. */
async function exportAll(
  orgId: string,
  opts: { limit: number; after?: After; allowedSiteIds?: readonly string[]; askOrgId?: string },
) {
  const ids: string[] = [];
  let after: After = opts.after ?? null;
  for (let i = 0; i < 50; i++) {
    const page = await fetchPage(orgId, { ...opts, after });
    ids.push(...page.records.map((r) => String(r.id)));
    after = page.nextCursor ? decodeExportCursor(page.nextCursor) : after;
    if (!page.hasMore) break;
  }
  return { ids, after };
}

describe('fetchElevationAuditExportPage (real Postgres, #4910)', () => {
  it('walks every event exactly once in (occurred_at, id) order, across exact ties and microsecond gaps', async () => {
    const f = await fixture();
    const tie = '2026-09-10 12:00:00.000001+00';
    const expected = [
      await seedEvent(f.orgA, f.reqA1.id, tie),
      await seedEvent(f.orgA, f.reqA1.id, tie),
      await seedEvent(f.orgA, f.reqA2.id, tie),
      await seedEvent(f.orgA, f.reqA2.id, '2026-09-10 12:00:00.000002+00'),
      await seedEvent(f.orgA, f.reqA1.id, '2026-09-10 12:00:00.000003+00'),
    ];
    await seedEvent(f.orgB, f.reqB.id, tie);

    const { ids: seen } = await exportAll(f.orgA, { limit: 2 });
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(expected));
    // Ties at the same instant are ordered by id; later instants follow.
    const tieIds = expected.slice(0, 3).sort();
    expect(seen.slice(0, 3)).toEqual(tieIds);
    expect(seen.slice(3)).toEqual(expected.slice(3));
  });

  it('RLS keeps another org out even when that org is the one asked for', async () => {
    const f = await fixture();
    await seedEvent(f.orgA, f.reqA1.id, '2026-09-11 00:00:00+00');
    await seedEvent(f.orgB, f.reqB.id, '2026-09-11 00:00:00+00');
    expect((await exportAll(f.orgA, { limit: 10 })).ids).toHaveLength(1);
    expect((await exportAll(f.orgA, { limit: 10, askOrgId: f.orgB })).ids).toEqual([]);
  });

  it('a late event whose occurred_at the walk already passed is still exported (keyed on recorded time)', async () => {
    const f = await fixture();
    const first = await seedEvent(f.orgA, f.reqA1.id, '2026-09-15 12:00:10+00');
    const page1 = await exportAll(f.orgA, { limit: 10 });
    expect(page1.ids).toEqual([first]);

    // An agent reports an observation from before the cursor's instant, and
    // Breeze records it later.
    const late = await seedEvent(f.orgA, f.reqA1.id, '2026-09-15 12:05:00+00', {}, '2026-09-15 12:00:05+00');
    const resumed = await exportAll(f.orgA, { limit: 10, after: page1.after });
    expect(resumed.ids).toEqual([late]);
  });

  it('a writer transaction still open holds the walk before its start, so its row is not skipped when it commits', async () => {
    const f = await fixture();
    // A second connection as the SAME role as the API (breeze_app), holding an
    // elevation_audit insert open, the way a slow request transaction would.
    const writer = postgres(process.env.DATABASE_URL_APP ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test', { max: 1 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let inserted!: () => void;
    const didInsert = new Promise<void>((resolve) => { inserted = resolve; });
    let slowId = '';
    const tx = writer.begin(async (sqlTx) => {
      await sqlTx`SELECT set_config('breeze.scope', 'system', true)`;
      const [row] = await sqlTx`
        INSERT INTO elevation_audit (org_id, elevation_request_id, event_type, actor, details, occurred_at)
        VALUES (${f.orgA}, ${f.reqA1.id}, 'approved', 'technician', '{}'::jsonb, now())
        RETURNING id`;
      slowId = String(row!.id);
      inserted();
      await held;
    });
    try {
      await didInsert;
      // A later, already-committed event: recorded after the open transaction began.
      const fast = await withDbAccessContext(SYSTEM_CTX, async () => {
        const [row] = await db
          .insert(elevationAudit)
          .values({ orgId: f.orgA, elevationRequestId: f.reqA1.id, eventType: 'approved', actor: 'technician', details: {}, occurredAt: new Date() })
          .returning({ id: elevationAudit.id });
        return row!.id;
      });
      const window = { from: new Date('2026-09-01T00:00:00Z'), to: new Date(Date.now() + 60_000) };
      const page = (after: { recordedAt: string; id: string } | null) =>
        withDbAccessContext(orgContext(f.orgA), () =>
          fetchElevationAuditExportPage({
            orgCondition: undefined, allowedSiteIds: undefined, filters: { ...window, orgId: f.orgA },
            after, limit: 10, settleSeconds: 0,
          }),
        );

      // Without the watermark this page would return `fast` and move the
      // cursor past the open transaction's start, skipping `slow` for good.
      const blocked = await page(null);
      expect(blocked.records.map((r) => r.id)).not.toContain(fast);

      release();
      await tx;
      const resumed = await page(blocked.nextCursor ? decodeExportCursor(blocked.nextCursor) : null);
      expect(resumed.records.map((r) => r.id)).toEqual([slowId, fast]);
    } finally {
      release();
      await tx.catch(() => undefined);
      await writer.end();
    }
  });

  it('an open write transaction on an unrelated table does not stall the export', async () => {
    const f = await fixture();
    const other = postgres(process.env.DATABASE_URL_APP ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test', { max: 1 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let wrote!: () => void;
    const didWrite = new Promise<void>((resolve) => { wrote = resolve; });
    const tx = other.begin(async (sqlTx) => {
      await sqlTx`SELECT set_config('breeze.scope', 'system', true)`;
      // Takes a transaction id by writing somewhere other than elevation_audit.
      await sqlTx`UPDATE organizations SET updated_at = now() WHERE id = ${f.orgB}`;
      wrote();
      await held;
    });
    try {
      await didWrite;
      const recent = await withDbAccessContext(SYSTEM_CTX, async () => {
        const [row] = await db
          .insert(elevationAudit)
          .values({ orgId: f.orgA, elevationRequestId: f.reqA1.id, eventType: 'approved', actor: 'technician', details: {}, occurredAt: new Date() })
          .returning({ id: elevationAudit.id });
        return row!.id;
      });
      const page = await withDbAccessContext(orgContext(f.orgA), () =>
        fetchElevationAuditExportPage({
          orgCondition: undefined, allowedSiteIds: undefined,
          filters: { from: new Date('2026-09-01T00:00:00Z'), to: new Date(Date.now() + 60_000), orgId: f.orgA },
          after: null, limit: 10, settleSeconds: 0,
        }),
      );
      expect(page.records.map((r) => r.id)).toContain(recent);
    } finally {
      release();
      await tx.catch(() => undefined);
      await other.end();
    }
  });

  it('rows inside the settle delay wait; resuming from the cursor picks them up once settled', async () => {
    const f = await fixture();
    const settled = await seedEvent(f.orgA, f.reqA1.id, '2026-09-16 00:00:00+00');
    const fresh = await withDbAccessContext(SYSTEM_CTX, async () => {
      const [row] = await db
        .insert(elevationAudit)
        .values({ orgId: f.orgA, elevationRequestId: f.reqA1.id, eventType: 'approved', actor: 'technician', details: {}, occurredAt: new Date() })
        .returning({ id: elevationAudit.id });
      return row!.id;
    });
    const window = { from: new Date('2026-09-01T00:00:00Z'), to: new Date(Date.now() + 60_000) };
    const page = await withDbAccessContext(orgContext(f.orgA), () =>
      fetchElevationAuditExportPage({ orgCondition: undefined, allowedSiteIds: undefined, filters: { ...window, orgId: f.orgA }, after: null, limit: 10 }),
    );
    expect(page.records.map((r) => r.id)).toEqual([settled]);
    expect(page.hasMore).toBe(false);
    // A row in the window is still withheld: the window is NOT complete.
    expect(page.windowComplete).toBe(false);
    expect(page.nextCursor).not.toBe('');

    // Time passes: the fresh row is now older than the settle delay.
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.update(elevationAudit).set({ createdAt: sql`now() - interval '10 minutes'` as unknown as Date }).where(eq(elevationAudit.id, fresh)),
    );
    const resumed = await withDbAccessContext(orgContext(f.orgA), () =>
      fetchElevationAuditExportPage({
        orgCondition: undefined, allowedSiteIds: undefined, filters: { ...window, orgId: f.orgA },
        after: decodeExportCursor(page.nextCursor), limit: 10,
      }),
    );
    expect(resumed.records.map((r) => r.id)).toEqual([fresh]);

    // An empty page keeps the resume position instead of dropping it.
    const empty = await withDbAccessContext(orgContext(f.orgA), () =>
      fetchElevationAuditExportPage({
        orgCondition: undefined, allowedSiteIds: undefined, filters: { ...window, orgId: f.orgA },
        after: decodeExportCursor(resumed.nextCursor), limit: 10,
      }),
    );
    expect(empty.records).toEqual([]);
    expect(empty.nextCursor).toBe(resumed.nextCursor);
  });

  it('the site allowlist narrows the export, and an empty allowlist returns nothing', async () => {
    const f = await fixture();
    const inSite1 = await seedEvent(f.orgA, f.reqA1.id, '2026-09-12 00:00:00+00');
    await seedEvent(f.orgA, f.reqA2.id, '2026-09-12 00:00:01+00');

    expect((await exportAll(f.orgA, { limit: 10, allowedSiteIds: [f.reqA1.site_id] })).ids).toEqual([inSite1]);
    expect((await exportAll(f.orgA, { limit: 10, allowedSiteIds: [] })).ids).toEqual([]);
  });

  it('the recorded-time window is half-open [from, to)', async () => {
    const f = await fixture();
    const atFrom = await seedEvent(f.orgA, f.reqA1.id, '2026-09-01 00:00:00+00');
    await seedEvent(f.orgA, f.reqA1.id, '2026-10-01 00:00:00+00');
    expect((await exportAll(f.orgA, { limit: 10 })).ids).toEqual([atFrom]);
  });

  it('a window wholly behind the watermark reports complete on its last page; one reaching past it does not', async () => {
    const f = await fixture();
    await seedEvent(f.orgA, f.reqA1.id, '2026-09-02 00:00:00+00');
    const run = (to: Date) =>
      withDbAccessContext(orgContext(f.orgA), () =>
        fetchElevationAuditExportPage({
          orgCondition: undefined, allowedSiteIds: undefined,
          filters: { from: new Date('2026-09-01T00:00:00Z'), to, orgId: f.orgA }, after: null, limit: 10,
        }),
      );
    const closed = await run(new Date('2026-09-03T00:00:00Z'));
    expect(closed.hasMore).toBe(false);
    expect(closed.windowComplete).toBe(true);
    expect(closed.settledThrough).toMatch(/^\d{4}-\d{2}-\d{2} /);

    const open = await run(new Date(Date.now() + 60_000));
    expect(open.hasMore).toBe(false);
    expect(open.windowComplete).toBe(false);
  });

  it('exports only allowlisted detail keys and the request context', async () => {
    const f = await fixture();
    await seedEvent(f.orgA, f.reqA1.id, '2026-09-13 00:00:00+00', {
      reason: 'approved for install',
      duration_minutes: 30,
      password: 'must-not-leak',
      nested: { reason: 'x' },
    });
    const page = await withDbAccessContext(orgContext(f.orgA), () =>
      fetchElevationAuditExportPage({
        orgCondition: eq(elevationAudit.orgId, f.orgA),
        allowedSiteIds: undefined,
        filters: { ...WINDOW, orgId: f.orgA },
        after: null,
        limit: 10,
      }),
    );
    expect(page.records).toHaveLength(1);
    const rec = page.records[0]!;
    expect(rec.details).toEqual({ reason: 'approved for install', duration_minutes: 30 });
    expect(JSON.stringify(rec)).not.toContain('must-not-leak');
    expect(rec).toMatchObject({
      org_id: f.orgA,
      elevation_request_id: f.reqA1.id,
      event_type: 'approved',
      actor: 'technician',
      request_site_id: f.reqA1.site_id,
      request_device_id: f.reqA1.device_id,
      request_flow_type: 'uac_intercept',
      request_subject_username: 'alice',
      request_status: 'pending',
    });
    expect(page.hasMore).toBe(false);
  });

  it('filters by request and event type', async () => {
    const f = await fixture();
    const target = await seedEvent(f.orgA, f.reqA1.id, '2026-09-14 00:00:00+00');
    await seedEvent(f.orgA, f.reqA2.id, '2026-09-14 00:00:01+00');
    const page = await withDbAccessContext(orgContext(f.orgA), () =>
      fetchElevationAuditExportPage({
        orgCondition: eq(elevationAudit.orgId, f.orgA),
        allowedSiteIds: undefined,
        filters: { ...WINDOW, orgId: f.orgA, elevationRequestId: f.reqA1.id, eventType: 'approved' },
        after: null,
        limit: 10,
      }),
    );
    expect(page.records.map((r) => r.id)).toEqual([target]);

    const none = await withDbAccessContext(orgContext(f.orgA), () =>
      fetchElevationAuditExportPage({
        orgCondition: eq(elevationAudit.orgId, f.orgA),
        allowedSiteIds: undefined,
        filters: { ...WINDOW, orgId: f.orgA, eventType: 'denied' },
        after: null,
        limit: 10,
      }),
    );
    expect(none.records).toEqual([]);
  });
});

