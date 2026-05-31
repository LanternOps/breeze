import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock, insertMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn()
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: selectMock,
    insert: insertMock
  }
}));

vi.mock('../../db/schema', () => ({
  userNotifications: { id: 'userNotifications.id' },
  organizationUsers: {
    userId: 'organizationUsers.userId',
    orgId: 'organizationUsers.orgId'
  },
  users: {
    id: 'users.id',
    status: 'users.status'
  },
  partnerUsers: {
    userId: 'partnerUsers.userId',
    partnerId: 'partnerUsers.partnerId',
    orgAccess: 'partnerUsers.orgAccess',
    orgIds: 'partnerUsers.orgIds'
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId'
  }
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  or: vi.fn((...args: unknown[]) => ({ type: 'or', args })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    type: 'sql',
    text: strings.join('?'),
    values
  }))
}));

import { sendInAppNotification, sendInAppNotificationToUsers } from './inAppSender';
import { and, eq, sql } from 'drizzle-orm';
import { partnerUsers } from '../../db/schema';

function createOrgSelect(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows)
      })
    })
  };
}

function createUserSelect(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows)
      })
    })
  };
}

describe('in-app sender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertMock.mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined)
    });
  });

  it('includes selected-org partner users and deduplicates recipients', async () => {
    const payload = {
      alertId: 'alert-1',
      alertName: 'CPU High',
      severity: 'high' as const,
      message: 'CPU > 90%',
      orgId: '00000000-0000-0000-0000-000000000001'
    };

    selectMock
      .mockReturnValueOnce(createOrgSelect([{ partnerId: 'partner-1' }]) as any)
      .mockReturnValueOnce(createUserSelect([{ userId: 'org-user-1' }]) as any)
      .mockReturnValueOnce(createUserSelect([{ userId: 'partner-user-1' }, { userId: 'org-user-1' }]) as any);

    const result = await sendInAppNotification(payload);

    expect(result.success).toBe(true);
    expect(result.notificationCount).toBe(2);

    expect(eq).toHaveBeenCalledWith(partnerUsers.orgAccess, 'all');
    expect(eq).toHaveBeenCalledWith(partnerUsers.orgAccess, 'selected');
    expect(and).toHaveBeenCalled();
    expect(sql).toHaveBeenCalled();
    expect(
      vi.mocked(sql).mock.calls.some((call) => {
        const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
        return strings.join('?').includes('= ANY(') && values.includes(payload.orgId);
      })
    ).toBe(true);
  });

  it('returns zero notifications when no org or partner recipients are eligible', async () => {
    selectMock
      .mockReturnValueOnce(createOrgSelect([{ partnerId: 'partner-1' }]) as any)
      .mockReturnValueOnce(createUserSelect([]) as any)
      .mockReturnValueOnce(createUserSelect([]) as any);

    const result = await sendInAppNotification({
      alertId: 'alert-2',
      alertName: 'Disk Full',
      severity: 'critical',
      message: 'Disk > 98%',
      orgId: '00000000-0000-0000-0000-000000000002'
    });

    expect(result).toEqual({
      success: true,
      notificationCount: 0
    });
    expect(insertMock).not.toHaveBeenCalled();
  });

  // --- link open-redirect hardening (server-side defense-in-depth) ---
  // A hostile/absolute link must never persist; it collapses to the safe
  // /alerts/<id> fallback. Mirrors the client getSafeNext guard.

  it('sanitizes a hostile payload.link to the /alerts/<id> fallback (sendInAppNotification)', async () => {
    const valuesMock = vi.fn().mockResolvedValue(undefined);
    insertMock.mockReturnValue({ values: valuesMock });

    selectMock
      .mockReturnValueOnce(createOrgSelect([{ partnerId: null }]) as any)
      .mockReturnValueOnce(createUserSelect([{ userId: 'org-user-1' }]) as any);

    const result = await sendInAppNotification({
      alertId: 'alert-1',
      alertName: 'CPU High',
      severity: 'high',
      message: 'CPU > 90%',
      orgId: '00000000-0000-0000-0000-000000000001',
      link: 'https://evil.com/phish'
    });

    expect(result.success).toBe(true);
    const inserted = valuesMock.mock.calls[0]?.[0] as Array<{ link: string }>;
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.link).toBe('/alerts/alert-1');
  });

  it('preserves a safe relative payload.link (sendInAppNotification)', async () => {
    const valuesMock = vi.fn().mockResolvedValue(undefined);
    insertMock.mockReturnValue({ values: valuesMock });

    selectMock
      .mockReturnValueOnce(createOrgSelect([{ partnerId: null }]) as any)
      .mockReturnValueOnce(createUserSelect([{ userId: 'org-user-1' }]) as any);

    await sendInAppNotification({
      alertId: 'alert-2',
      alertName: 'Disk',
      severity: 'low',
      message: 'm',
      orgId: '00000000-0000-0000-0000-000000000001',
      link: '/devices/42'
    });

    const inserted = valuesMock.mock.calls[0]?.[0] as Array<{ link: string }>;
    expect(inserted[0]?.link).toBe('/devices/42');
  });

  it('sanitizes a hostile payload.link to the /alerts/<id> fallback (sendInAppNotificationToUsers)', async () => {
    const valuesMock = vi.fn().mockResolvedValue(undefined);
    insertMock.mockReturnValue({ values: valuesMock });

    const result = await sendInAppNotificationToUsers(['user-1', 'user-2'], {
      alertId: 'alert-9',
      alertName: 'Suspicious',
      severity: 'critical',
      message: 'm',
      link: '//evil.com/phish'
    });

    expect(result.success).toBe(true);
    const inserted = valuesMock.mock.calls[0]?.[0] as Array<{ link: string }>;
    expect(inserted).toHaveLength(2);
    expect(inserted[0]?.link).toBe('/alerts/alert-9');
    expect(inserted[1]?.link).toBe('/alerts/alert-9');
  });

  it('preserves a safe relative payload.link (sendInAppNotificationToUsers)', async () => {
    const valuesMock = vi.fn().mockResolvedValue(undefined);
    insertMock.mockReturnValue({ values: valuesMock });

    await sendInAppNotificationToUsers(['user-1'], {
      alertId: 'alert-9',
      alertName: 'X',
      severity: 'low',
      message: 'm',
      link: '/scripts/7'
    });

    const inserted = valuesMock.mock.calls[0]?.[0] as Array<{ link: string }>;
    expect(inserted[0]?.link).toBe('/scripts/7');
  });
});
