/**
 * fetchElevationAuditExportPage against real Postgres (#4910): RLS bounds the
 * export to the caller's org even with no app-layer condition, the site
 * allowlist narrows it, the (occurred_at, id) keyset cursor walks every event
 * exactly once at microsecond precision (including exact timestamp ties), the
 * [from, to) window is half-open, and raw `details` never leaks.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices, elevationAudit, elevationRequests, sites } from '../../db/schema';
import { fetchElevationAuditExportPage } from '../../services/pamAuditExport';
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

async function seedEvent(
  orgId: string,
  requestId: string,
  occurredAt: string,
  details: Record<string, unknown> = {},
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

async function exportAll(orgId: string, opts: { limit: number; allowedSiteIds?: readonly string[]; orgCondition?: boolean }) {
  const ids: string[] = [];
  let after: { occurredAt: string; id: string } | null = null;
  for (let i = 0; i < 50; i++) {
    const page = await withDbAccessContext(orgContext(orgId), () =>
      fetchElevationAuditExportPage({
        orgCondition: opts.orgCondition === false ? undefined : eq(elevationAudit.orgId, orgId),
        allowedSiteIds: opts.allowedSiteIds,
        filters: WINDOW,
        after,
        limit: opts.limit,
      }),
    );
    ids.push(...page.records.map((r) => String(r.id)));
    if (!page.nextCursor) break;
    const raw = Buffer.from(page.nextCursor, 'base64url').toString('utf8');
    const sep = raw.lastIndexOf('|');
    after = { occurredAt: raw.slice(0, sep), id: raw.slice(sep + 1) };
  }
  return ids;
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

    const seen = await exportAll(f.orgA, { limit: 2 });
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(expected));
    // Ties at the same instant are ordered by id; later instants follow.
    const tieIds = expected.slice(0, 3).sort();
    expect(seen.slice(0, 3)).toEqual(tieIds);
    expect(seen.slice(3)).toEqual(expected.slice(3));
  });

  it('RLS alone keeps another org out even with no app-layer org condition', async () => {
    const f = await fixture();
    await seedEvent(f.orgA, f.reqA1.id, '2026-09-11 00:00:00+00');
    await seedEvent(f.orgB, f.reqB.id, '2026-09-11 00:00:00+00');
    const seen = await exportAll(f.orgA, { limit: 10, orgCondition: false });
    expect(seen).toHaveLength(1);
  });

  it('the site allowlist narrows the export, and an empty allowlist returns nothing', async () => {
    const f = await fixture();
    const inSite1 = await seedEvent(f.orgA, f.reqA1.id, '2026-09-12 00:00:00+00');
    await seedEvent(f.orgA, f.reqA2.id, '2026-09-12 00:00:01+00');

    expect(await exportAll(f.orgA, { limit: 10, allowedSiteIds: [f.reqA1.site_id] })).toEqual([inSite1]);
    expect(await exportAll(f.orgA, { limit: 10, allowedSiteIds: [] })).toEqual([]);
  });

  it('the window is half-open [from, to)', async () => {
    const f = await fixture();
    const atFrom = await seedEvent(f.orgA, f.reqA1.id, '2026-09-01 00:00:00+00');
    await seedEvent(f.orgA, f.reqA1.id, '2026-10-01 00:00:00+00');
    expect(await exportAll(f.orgA, { limit: 10 })).toEqual([atFrom]);
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
        filters: WINDOW,
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
    expect(page.nextCursor).toBe('');
  });

  it('filters by request and event type', async () => {
    const f = await fixture();
    const target = await seedEvent(f.orgA, f.reqA1.id, '2026-09-14 00:00:00+00');
    await seedEvent(f.orgA, f.reqA2.id, '2026-09-14 00:00:01+00');
    const page = await withDbAccessContext(orgContext(f.orgA), () =>
      fetchElevationAuditExportPage({
        orgCondition: eq(elevationAudit.orgId, f.orgA),
        allowedSiteIds: undefined,
        filters: { ...WINDOW, elevationRequestId: f.reqA1.id, eventType: 'approved' },
        after: null,
        limit: 10,
      }),
    );
    expect(page.records.map((r) => r.id)).toEqual([target]);

    const none = await withDbAccessContext(orgContext(f.orgA), () =>
      fetchElevationAuditExportPage({
        orgCondition: eq(elevationAudit.orgId, f.orgA),
        allowedSiteIds: undefined,
        filters: { ...WINDOW, eventType: 'denied' },
        after: null,
        limit: 10,
      }),
    );
    expect(none.records).toEqual([]);
  });
});

