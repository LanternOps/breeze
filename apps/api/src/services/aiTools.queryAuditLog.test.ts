import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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

function mockAuditSelect(rows: any[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  } as any;
}

describe('query_audit_log surfaces MCP-bootstrap audit events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mcpActions = [
    'partner.mcp_provisioned',
    'partner.activation_completed',
    'partner.payment_method_attached',
    'invite.sent',
    'invite.clicked',
    'invite.enrolled',
  ] as const;

  it.each(mcpActions)('returns audit entry with action %s', async (action) => {
    const tool = aiTools.get('query_audit_log');
    expect(tool).toBeTruthy();

    const row = {
      id: 'audit-1',
      timestamp: new Date('2026-04-20T10:00:00Z'),
      actorType: 'system',
      actorEmail: null,
      action,
      resourceType: 'partner',
      resourceName: 'Acme MSP',
      result: 'success',
      details: {},
    };

    vi.mocked(db.select).mockReturnValueOnce(mockAuditSelect([row]));

    const output = await tool!.handler({ action }, makeAuth());
    const parsed = JSON.parse(output);

    expect(parsed.showing).toBe(1);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].action).toBe(action);
  });
});
