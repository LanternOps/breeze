import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from '../db';
import { aiTools } from './aiTools';
import type { AuthContext } from '../middleware/auth';

function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    token: {} as any,
    partnerId: null,
    orgId: 'org-123',
    scope: 'organization',
    accessibleOrgIds: ['org-123'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  };
}

function mockChangeSelect(rows: any[]) {
  return {
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
  } as any;
}

function mockCountSelect(total: number) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ count: total }]),
    }),
  } as any;
}

function mockDeviceAccess(found: boolean) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(
          found
            ? [{ id: 'device-123', hostname: 'DESKTOP-01', status: 'online' }]
            : []
        ),
      }),
    }),
  } as any;
}

describe('query_change_log tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns change log results with totals', async () => {
    const tool = aiTools.get('query_change_log');
    expect(tool).toBeTruthy();

    vi.mocked(db.select)
      .mockReturnValueOnce(mockChangeSelect([
        {
          timestamp: new Date('2026-02-21T10:00:00Z'),
          changeType: 'software',
          changeAction: 'updated',
          subject: 'Chrome',
          beforeValue: { version: '121' },
          afterValue: { version: '122' },
          details: null,
          hostname: 'DESKTOP-01',
          deviceId: 'device-123',
        },
      ]))
      .mockReturnValueOnce(mockCountSelect(1));

    const output = await tool!.handler({ limit: 50 }, makeAuth());
    const parsed = JSON.parse(output);

    expect(parsed.total).toBe(1);
    expect(parsed.showing).toBe(1);
    expect(parsed.changes[0].subject).toBe('Chrome');
    expect(parsed.changes[0].changeAction).toBe('updated');
  });

  it('returns access error when deviceId is not accessible', async () => {
    const tool = aiTools.get('query_change_log');
    expect(tool).toBeTruthy();

    vi.mocked(db.select).mockReturnValueOnce(mockDeviceAccess(false));

    const output = await tool!.handler({ deviceId: '8f5f9b9e-53be-4554-bf9e-421f2f74d8bb' }, makeAuth());
    const parsed = JSON.parse(output);
    expect(parsed.error).toContain('Device not found or access denied');
  });
});

