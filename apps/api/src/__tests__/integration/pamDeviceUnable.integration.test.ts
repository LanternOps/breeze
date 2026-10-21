/**
 * #9517: the agent's "cannot act on this elevation" report, against a real
 * Postgres as the unprivileged breeze_app role (RLS enforced).
 *
 * Covers what the route unit test mocks away: the report closes a pending
 * request so neither approve path can take it, the first report wins, the
 * request must belong to the reporting device, another org's request is
 * invisible, a non-pending request keeps its status, the phone approvals for
 * the closed request expire in system scope, and the DB CHECK bounds the
 * stored code and detail.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { approvalRequests } from '../../db/schema/approvals';
import { elevationAudit, elevationRequests } from '../../db/schema/elevations';
import { devices, organizations, partners, sites, users } from '../../db/schema';
import { getTestDb } from './setup';
import { currentOwnershipEpochSql } from '../../services/deviceOwnershipEpoch';
import { expireSupersededMobileApprovals } from '../../services/pamMobileApprovals';
import {
  PAM_DEVICE_UNABLE_DETAIL_MAX,
  recordElevationDeviceUnable,
} from '../../services/pamDeviceUnable';

/** The org-scoped context routes/agents/pamElevationUnable.ts opens. */
function agentContext(orgId: string, partnerId: string) {
  return {
    scope: 'organization' as const,
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: partnerId,
  };
}

let partnerId: string;
let orgId: string;
let siteId: string;
let deviceId: string;
let otherDeviceId: string;
let otherPartnerId: string;
let otherOrgId: string;
let approverIds: string[];

async function seedDevice(org: string, site: string, tag: string): Promise<string> {
  const [d] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org,
      siteId: site,
      agentId: `agent-9517-${tag}-${Date.now()}-${Math.random()}`,
      hostname: `rds-9517-${tag}`,
      osType: 'windows',
      osVersion: '10.0',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
    })
    .returning({ id: devices.id });
  return d!.id;
}

async function seedElevation(opts: {
  org?: string;
  site?: string;
  partner?: string;
  device?: string;
  status?: 'pending' | 'auto_approved' | 'denied';
} = {}): Promise<string> {
  const status = opts.status ?? 'pending';
  const [row] = await getTestDb()
    .insert(elevationRequests)
    .values({
      orgId: opts.org ?? orgId,
      siteId: opts.site ?? siteId,
      partnerId: opts.partner ?? partnerId,
      deviceId: opts.device ?? deviceId,
      deviceEpoch: currentOwnershipEpochSql(opts.device ?? deviceId),
      flowType: 'uac_intercept',
      subjectUsername: 'RDS\\enduser',
      reason: 'UAC consent UI observed for C:\\Temp\\setup.exe',
      targetExecutablePath: 'C:\\Temp\\setup.exe',
      status,
      ...(status === 'auto_approved' ? { approvedAt: new Date(), expiresAt: new Date(Date.now() + 15 * 60_000) } : {}),
      ...(status === 'denied' ? { denialReason: 'Blocked by PAM rule "no installers"' } : {}),
    })
    .returning({ id: elevationRequests.id });
  return row!.id;
}

async function seedPhoneApprovals(elevationId: string): Promise<void> {
  await getTestDb()
    .insert(approvalRequests)
    .values(approverIds.map((userId) => ({
      userId,
      elevationRequestId: elevationId,
      requestingClientLabel: 'Breeze Agent',
      requestingMachineLabel: 'rds-9517',
      actionLabel: 'Elevate setup.exe',
      actionToolName: 'uac_intercept',
      actionArguments: {},
      riskTier: 'medium' as const,
      riskSummary: 'RDS\\enduser requested admin to run setup.exe (unsigned).',
      status: 'pending' as const,
      isRecursive: false,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    })));
}

async function readRequest(id: string) {
  const [row] = await getTestDb().select().from(elevationRequests).where(eq(elevationRequests.id, id));
  return row!;
}

async function readAudit(id: string) {
  return getTestDb()
    .select({ eventType: elevationAudit.eventType, actor: elevationAudit.actor, details: elevationAudit.details })
    .from(elevationAudit)
    .where(eq(elevationAudit.elevationRequestId, id))
    .orderBy(asc(elevationAudit.createdAt), asc(elevationAudit.id));
}

function report(elevationRequestId: string, reason: 'helper_unavailable' | 'session_unavailable' | 'helper_start_failed' = 'helper_start_failed', detail?: string, ctx = agentContext(orgId, partnerId), device = deviceId) {
  return withDbAccessContext(ctx, () =>
    recordElevationDeviceUnable({ deviceId: device, elevationRequestId, reason, detail }),
  );
}

beforeEach(async () => {
  const tdb = getTestDb();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [p] = await tdb.insert(partners)
    .values({ name: '9517 MSP', slug: `msp-9517-${stamp}`, type: 'msp', plan: 'pro', status: 'active' })
    .returning({ id: partners.id });
  partnerId = p!.id;
  const [o] = await tdb.insert(organizations)
    .values({ currencyCode: 'USD', partnerId, name: '9517 Org', slug: `org-9517-${stamp}`, type: 'customer', status: 'active' })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [s] = await tdb.insert(sites).values({ orgId, name: '9517 Site', timezone: 'UTC' }).returning({ id: sites.id });
  siteId = s!.id;
  deviceId = await seedDevice(orgId, siteId, 'a');
  otherDeviceId = await seedDevice(orgId, siteId, 'b');

  const [p2] = await tdb.insert(partners)
    .values({ name: '9517 Other MSP', slug: `msp2-9517-${stamp}`, type: 'msp', plan: 'pro', status: 'active' })
    .returning({ id: partners.id });
  otherPartnerId = p2!.id;
  const [o2] = await tdb.insert(organizations)
    .values({ currencyCode: 'USD', partnerId: otherPartnerId, name: '9517 Other Org', slug: `org2-9517-${stamp}`, type: 'customer', status: 'active' })
    .returning({ id: organizations.id });
  otherOrgId = o2!.id;

  const approvers = await tdb.insert(users)
    .values([
      { partnerId, email: `a-9517-${stamp}@example.test`, name: 'Approver A', status: 'active' },
      { partnerId, email: `b-9517-${stamp}@example.test`, name: 'Approver B', status: 'active' },
    ])
    .returning({ id: users.id });
  approverIds = approvers.map((u) => u.id);
});

describe('recordElevationDeviceUnable (#9517)', () => {
  it('closes a pending request as expired, records why, and audits both events', async () => {
    const id = await seedElevation();

    const result = await report(id, 'session_unavailable', 'session 7 cannot host a SYSTEM helper (not active or connected)');

    expect(result).toMatchObject({ kind: 'recorded', id, orgId, deviceId, flowType: 'uac_intercept', priorStatus: 'pending', status: 'expired', closed: true });
    const row = await readRequest(id);
    expect(row.status).toBe('expired');
    expect(row.expiredAt).not.toBeNull();
    expect(row.deviceUnableAt).not.toBeNull();
    expect(row.deviceUnableReason).toBe('session_unavailable');
    expect(row.deviceUnableDetail).toBe('session 7 cannot host a SYSTEM helper (not active or connected)');
    expect(await readAudit(id)).toEqual([
      { eventType: 'device_unable', actor: 'system', details: { reason: 'session_unavailable', prior_status: 'pending', closed: true } },
      { eventType: 'expired', actor: 'system', details: { cause: 'device_unable', prior_status: 'pending' } },
    ]);
  });

  it('a closed request can no longer be approved by the web respond CAS', async () => {
    const id = await seedElevation();
    await report(id);

    // routes/pam.ts respond and decideApprovalRequest both decide only a
    // row that is still 'pending'.
    const approved = await withDbAccessContext(agentContext(orgId, partnerId), () =>
      db.update(elevationRequests)
        .set({ status: 'approved', approvedAt: new Date() })
        .where(and(eq(elevationRequests.id, id), eq(elevationRequests.status, 'pending')))
        .returning({ id: elevationRequests.id }),
    );
    expect(approved).toHaveLength(0);
    expect((await readRequest(id)).status).toBe('expired');
  });

  it('expires the closed request’s phone approvals in system scope', async () => {
    const id = await seedElevation();
    await seedPhoneApprovals(id);

    await report(id);
    const expired = await runOutsideDbContext(() => expireSupersededMobileApprovals(id));

    expect(expired).toBe(2);
    const rows = await getTestDb().select({ status: approvalRequests.status })
      .from(approvalRequests).where(eq(approvalRequests.elevationRequestId, id));
    expect(rows.map((r) => r.status)).toEqual(['expired', 'expired']);
  });

  it('the first report wins; a repeat changes nothing', async () => {
    const id = await seedElevation();
    await report(id, 'helper_start_failed', 'helper failed to start after repeated attempts');
    const first = await readRequest(id);

    const again = await report(id, 'helper_unavailable', 'something else');

    expect(again).toEqual({ kind: 'already_reported', status: 'expired' });
    const row = await readRequest(id);
    expect(row.deviceUnableReason).toBe('helper_start_failed');
    expect(row.deviceUnableDetail).toBe('helper failed to start after repeated attempts');
    expect(row.deviceUnableAt?.getTime()).toBe(first.deviceUnableAt?.getTime());
    expect(await readAudit(id)).toHaveLength(2);
  });

  it('a device cannot report another device’s request in the same org', async () => {
    const id = await seedElevation();

    const result = await report(id, 'helper_unavailable', undefined, agentContext(orgId, partnerId), otherDeviceId);

    expect(result).toEqual({ kind: 'not_found' });
    const row = await readRequest(id);
    expect(row.status).toBe('pending');
    expect(row.deviceUnableAt).toBeNull();
    expect(await readAudit(id)).toHaveLength(0);
  });

  it('another org’s request is invisible under the agent’s org context (RLS)', async () => {
    const id = await seedElevation();

    // Even naming the right device id, a credential scoped to another org
    // cannot see or touch the row.
    const result = await report(id, 'helper_unavailable', undefined, agentContext(otherOrgId, otherPartnerId), deviceId);

    expect(result).toEqual({ kind: 'not_found' });
    expect((await readRequest(id)).status).toBe('pending');
  });

  it.each(['auto_approved', 'denied'] as const)('records but does not close a %s request', async (status) => {
    const id = await seedElevation({ status });

    const result = await report(id, 'helper_unavailable', 'no helper lifecycle manager to spawn one');

    expect(result).toMatchObject({ kind: 'recorded', priorStatus: status, status, closed: false });
    const row = await readRequest(id);
    expect(row.status).toBe(status);
    expect(row.expiredAt).toBeNull();
    expect(row.deviceUnableReason).toBe('helper_unavailable');
    expect(await readAudit(id)).toEqual([
      { eventType: 'device_unable', actor: 'system', details: { reason: 'helper_unavailable', prior_status: status, closed: false } },
    ]);
  });

  it('phone approvals of a still-pending request are left alone', async () => {
    // expireSupersededMobileApprovals only acts on a non-pending elevation, so
    // the route's post-exit expiry is a no-op if the report's write rolled back.
    const pendingId = await seedElevation();
    await seedPhoneApprovals(pendingId);

    const expired = await runOutsideDbContext(() => expireSupersededMobileApprovals(pendingId));

    expect(expired).toBe(0);
  });

  it('sanitizes and caps the agent’s detail; an empty detail is stored as NULL', async () => {
    const a = await seedElevation();
    const b = await seedElevation();

    await report(a, 'helper_start_failed', `line one\n\tline two\u0000${'x'.repeat(2 * PAM_DEVICE_UNABLE_DETAIL_MAX)}`);
    await report(b, 'helper_start_failed', ' \n\t ');

    const rowA = await readRequest(a);
    expect(rowA.deviceUnableDetail!.startsWith('line one line two x')).toBe(true);
    expect(rowA.deviceUnableDetail).toHaveLength(PAM_DEVICE_UNABLE_DETAIL_MAX);
    expect(rowA.deviceUnableDetail).not.toMatch(/[\u0000-\u001f]/);
    expect((await readRequest(b)).deviceUnableDetail).toBeNull();
  });

  it('the CHECK keeps the three columns together and bounds the code', async () => {
    const id = await seedElevation();
    const tdb = getTestDb();

    // drizzle wraps the driver error; the constraint is on the cause.
    const violatesCheck = async (query: Promise<unknown>) => {
      const err = await query.then(() => null, (e: unknown) => e as { cause?: { constraint_name?: string; message?: string } });
      expect(err, 'the update should have been rejected').not.toBeNull();
      expect(err?.cause?.constraint_name ?? err?.cause?.message).toMatch(/elevation_requests_device_unable_chk/);
    };
    await violatesCheck(tdb.execute(sql`UPDATE elevation_requests SET device_unable_reason = 'helper_unavailable' WHERE id = ${id}`));
    await violatesCheck(tdb.execute(sql`UPDATE elevation_requests SET device_unable_at = now(), device_unable_reason = 'Helper-Unavailable' WHERE id = ${id}`));
    await violatesCheck(tdb.execute(sql`UPDATE elevation_requests SET device_unable_at = now(), device_unable_reason = 'helper_unavailable', device_unable_detail = ${'x'.repeat(1001)} WHERE id = ${id}`));
    // A newer agent's category needs no migration.
    await tdb.execute(sql`UPDATE elevation_requests SET device_unable_at = now(), device_unable_reason = 'future_category' WHERE id = ${id}`);
  });

  it('system scope sees the recorded columns too (ops queries)', async () => {
    const id = await seedElevation();
    await report(id);

    const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db.select({ reason: elevationRequests.deviceUnableReason }).from(elevationRequests).where(eq(elevationRequests.id, id)),
    ));
    expect(row?.reason).toBe('helper_start_failed');
  });
});
