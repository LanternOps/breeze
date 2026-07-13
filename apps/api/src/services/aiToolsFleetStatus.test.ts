import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('../db/schema/deploymentInvites', () => ({
  deploymentInvites: {
    id: 'di.id',
    partnerId: 'di.partner_id',
    orgId: 'di.org_id',
    invitedEmail: 'di.invited_email',
    status: 'di.status',
    clickedAt: 'di.clicked_at',
    enrolledAt: 'di.enrolled_at',
    deviceId: 'di.device_id',
  },
}));

vi.mock('../db/schema/devices', () => ({
  devices: {
    id: 'd.id',
    hostname: 'd.hostname',
    osType: 'd.os_type',
    status: 'd.status',
    orgId: 'd.org_id',
    siteId: 'd.site_id',
  },
}));

vi.mock('../db/schema/orgs', () => ({
  enrollmentKeys: {
    id: 'ek.id',
    siteId: 'ek.site_id',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _op: 'and', args }),
  eq: (a: unknown, b: unknown) => ({ _op: 'eq', a, b }),
  inArray: (a: unknown, b: unknown) => ({ _op: 'inArray', a, b }),
}));

import { computeInviteFunnel } from './aiToolsFleetStatus';
import { db } from '../db';
import type { AuthContext } from '../middleware/auth';

const PARTNER_ID = '22222222-2222-2222-2222-222222222222';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// Captured WHERE predicate passed to the first select() (the invites query).
let capturedInviteWhere: unknown;

function mockSelectQueue(results: unknown[][]): void {
  const queue = [...results];
  capturedInviteWhere = undefined;
  let call = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const idx = call++;
    const result = queue.shift() ?? [];
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      // The invites query now joins enrollment_keys for the site sub-axis.
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn((predicate: unknown) => {
        // The first select() is the deployment_invites query — capture its
        // scope predicate so tests can assert org- vs partner-axis filtering.
        if (idx === 0) capturedInviteWhere = predicate;
        return Promise.resolve(result);
      }),
    };
    return chain as any;
  });
}

/** Minimal AuthContext — computeInviteFunnel only reads scope/orgId/partnerId/canAccessSite. */
function auth(partial: Partial<AuthContext>): AuthContext {
  return partial as AuthContext;
}

const partnerAuth = auth({ scope: 'partner', partnerId: PARTNER_ID, orgId: null });
const orgAuth = auth({ scope: 'organization', partnerId: PARTNER_ID, orgId: ORG_A });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeInviteFunnel', () => {
  it('returns zeros and empty array when no invites exist', async () => {
    mockSelectQueue([[]]); // one select call (invites), no device lookup needed

    const out = await computeInviteFunnel(partnerAuth);

    expect(out).toEqual({
      total_invited: 0,
      invites_clicked: 0,
      devices_enrolled: 0,
      devices_online: 0,
      devices_pending: 0,
      recent_enrollments: [],
    });
  });

  it('partner scope filters deployment_invites by partner_id', async () => {
    mockSelectQueue([[]]);

    await computeInviteFunnel(partnerAuth);

    // partner-axis aggregation across the whole partner.
    expect(capturedInviteWhere).toEqual({ _op: 'eq', a: 'di.partner_id', b: PARTNER_ID });
  });

  it('organization scope filters deployment_invites by org_id (sibling-org isolation)', async () => {
    mockSelectQueue([[]]);

    await computeInviteFunnel(orgAuth);

    // MCP-OAUTH-06: an org-scoped caller must aggregate only its OWN org's
    // invites — never the partner-wide set that would leak sibling-org counts.
    expect(capturedInviteWhere).toEqual({ _op: 'eq', a: 'di.org_id', b: ORG_A });
  });

  it('rejects organization scope with no org context (malformed)', async () => {
    mockSelectQueue([[]]);
    await expect(
      computeInviteFunnel(auth({ scope: 'organization', partnerId: PARTNER_ID, orgId: null })),
    ).rejects.toThrow(/organization scope requires/i);
  });

  it('rejects partner scope with no partner context (malformed)', async () => {
    mockSelectQueue([[]]);
    await expect(
      computeInviteFunnel(auth({ scope: 'partner', partnerId: null, orgId: null })),
    ).rejects.toThrow(/partner scope requires/i);
  });

  it('rejects an ambiguous/unsupported scope (does not rely on RLS alone)', async () => {
    mockSelectQueue([[]]);
    await expect(
      computeInviteFunnel(auth({ scope: 'system', partnerId: PARTNER_ID, orgId: null })),
    ).rejects.toThrow(/scope/i);
  });

  it('counts clicked, enrolled, and online devices correctly', async () => {
    const enrolledAt1 = new Date('2026-04-19T10:00:00Z');
    const enrolledAt2 = new Date('2026-04-19T11:00:00Z');

    const invites = [
      // Clicked-only (no device yet)
      {
        id: 'i1',
        email: 'clicked@acme.com',
        status: 'clicked',
        clickedAt: new Date('2026-04-19T09:00:00Z'),
        enrolledAt: null,
        deviceId: null,
      },
      // Sent, never clicked
      {
        id: 'i2',
        email: 'pending@acme.com',
        status: 'sent',
        clickedAt: null,
        enrolledAt: null,
        deviceId: null,
      },
      // Enrolled + online
      {
        id: 'i3',
        email: 'online@acme.com',
        status: 'enrolled',
        clickedAt: new Date('2026-04-19T08:00:00Z'),
        enrolledAt: enrolledAt1,
        deviceId: 'dev-1',
      },
      // Enrolled but offline
      {
        id: 'i4',
        email: 'offline@acme.com',
        status: 'enrolled',
        clickedAt: new Date('2026-04-19T08:30:00Z'),
        enrolledAt: enrolledAt2,
        deviceId: 'dev-2',
      },
    ];

    const deviceRows = [
      { id: 'dev-1', hostname: 'macbook-1', osType: 'macos', status: 'online', orgId: 'org-1' },
      { id: 'dev-2', hostname: 'thinkpad-1', osType: 'windows', status: 'offline', orgId: 'org-1' },
    ];

    mockSelectQueue([invites, deviceRows]);

    const out = await computeInviteFunnel(partnerAuth);

    expect(out.total_invited).toBe(4);
    // 3 clicked (two enrolled rows have clickedAt + the explicitly clicked one)
    expect(out.invites_clicked).toBe(3);
    expect(out.devices_enrolled).toBe(2);
    expect(out.devices_online).toBe(1);
    expect(out.recent_enrollments).toHaveLength(2);
    // Most recent first (dev-2 @ 11:00 before dev-1 @ 10:00)
    expect(out.recent_enrollments[0]).toEqual({
      device_id: 'dev-2',
      hostname: 'thinkpad-1',
      os: 'windows',
      invited_email: 'offline@acme.com',
      enrolled_at: enrolledAt2.toISOString(),
    });
    expect(out.recent_enrollments[1]?.device_id).toBe('dev-1');
  });

  it('falls back to "unknown" hostname/os if the device row is missing', async () => {
    const enrolledAt = new Date('2026-04-19T10:00:00Z');
    const invites = [
      {
        id: 'i1',
        email: 'orphan@acme.com',
        status: 'enrolled',
        clickedAt: enrolledAt,
        enrolledAt,
        deviceId: 'missing-device',
      },
    ];
    // deviceRows empty — device was deleted after invite matched
    mockSelectQueue([invites, []]);

    const out = await computeInviteFunnel(partnerAuth);

    expect(out.total_invited).toBe(1);
    expect(out.devices_enrolled).toBe(1);
    expect(out.devices_online).toBe(0);
    expect(out.recent_enrollments[0]).toEqual({
      device_id: 'missing-device',
      hostname: 'unknown',
      os: 'unknown',
      invited_email: 'orphan@acme.com',
      enrolled_at: enrolledAt.toISOString(),
    });
  });
});
