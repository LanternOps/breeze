import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('../db/schema/deploymentInvites', () => ({
  deploymentInvites: {
    id: 'di.id',
    partnerId: 'di.partner_id',
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
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _op: 'and', args }),
  eq: (a: unknown, b: unknown) => ({ _op: 'eq', a, b }),
  inArray: (a: unknown, b: unknown) => ({ _op: 'inArray', a, b }),
}));

import { computeInviteFunnel } from './aiToolsFleetStatus';
import { db } from '../db';

const PARTNER_ID = '22222222-2222-2222-2222-222222222222';

function mockSelectQueue(results: unknown[][]): void {
  const queue = [...results];
  vi.mocked(db.select).mockImplementation(() => {
    const result = queue.shift() ?? [];
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue(Promise.resolve(result)),
    };
    return chain as any;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeInviteFunnel', () => {
  it('returns zeros and empty array when no invites exist', async () => {
    mockSelectQueue([[]]); // one select call (invites), no device lookup needed

    const out = await computeInviteFunnel(PARTNER_ID);

    expect(out).toEqual({
      total_invited: 0,
      invites_clicked: 0,
      devices_enrolled: 0,
      devices_online: 0,
      recent_enrollments: [],
    });
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

    const out = await computeInviteFunnel(PARTNER_ID);

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

    const out = await computeInviteFunnel(PARTNER_ID);

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
