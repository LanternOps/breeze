import { describe, it, expect, beforeEach, vi } from 'vitest';

const { createAuditLogAsync } = vi.hoisted(() => ({ createAuditLogAsync: vi.fn() }));
vi.mock('../../services/auditService', () => ({ createAuditLogAsync }));

import { auditLogin } from './helpers';
import type { RequestLike } from '../../services/auditEvents';

const c = { req: { header: () => 'test-agent' } } as unknown as RequestLike;
const base = { userId: 'u1', email: 'u@example.com', name: 'U', mfa: false, ip: '203.0.113.1' };

describe('auditLogin tenancy attribution (#9483)', () => {
  beforeEach(() => createAuditLogAsync.mockReset());

  it('partner-axis SSO login carries the provider partnerId top-level with a null org', () => {
    auditLogin(c, { ...base, orgId: null, partnerId: 'p1', scope: 'partner', method: 'sso-partner' });
    expect(createAuditLogAsync).toHaveBeenCalledTimes(1);
    const row = createAuditLogAsync.mock.calls[0]![0];
    expect(row.orgId).toBeUndefined();
    expect(row.partnerId).toBe('p1');
    expect(row.action).toBe('user.login');
    expect(row.details).toMatchObject({ method: 'sso-partner', scope: 'partner' });
  });

  it('org-scoped password login (control) keeps its orgId and sets no partnerId', () => {
    auditLogin(c, { ...base, orgId: 'o1', scope: 'organization' });
    const row = createAuditLogAsync.mock.calls[0]![0];
    expect(row.orgId).toBe('o1');
    expect(row.partnerId).toBeUndefined();
    expect(row.details).toMatchObject({ method: 'password' });
  });
});
