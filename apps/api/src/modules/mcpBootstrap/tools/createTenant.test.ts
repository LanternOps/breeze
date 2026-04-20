import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../services/partnerCreate', () => ({
  createPartner: vi.fn().mockResolvedValue({
    partnerId: 'partner-1',
    orgId: 'org-1',
    siteId: 'site-1',
    adminUserId: 'user-1',
    adminRoleId: 'role-1',
    mcpOrigin: true,
  }),
  findRecentMcpPartnerByAdminEmail: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../services/rate-limit', () => ({
  rateLimiter: vi.fn().mockResolvedValue({ allowed: true, remaining: 1, resetAt: new Date() }),
}));

vi.mock('../../../services/redis', () => ({
  getRedis: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../db', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock('../../../db/schema', () => ({
  partnerActivations: {
    id: 'partnerActivations.id',
    partnerId: 'partnerActivations.partnerId',
    tokenHash: 'partnerActivations.tokenHash',
    expiresAt: 'partnerActivations.expiresAt',
  },
}));

vi.mock('../../../services/activationEmail', () => ({
  sendActivationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../services/auditEvents', async () => {
  const actual = await vi.importActual<any>('../../../services/auditEvents');
  return {
    ...actual,
    writeAuditEvent: vi.fn(),
  };
});

import { createTenantTool } from './createTenant';
import { createPartner, findRecentMcpPartnerByAdminEmail } from '../../../services/partnerCreate';
import { rateLimiter } from '../../../services/rate-limit';
import { db } from '../../../db';
import { sendActivationEmail } from '../../../services/activationEmail';
import { writeAuditEvent } from '../../../services/auditEvents';

const ctx = { ip: '1.2.3.4', userAgent: 'Claude', region: 'us' as const };

describe('create_tenant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true, remaining: 1, resetAt: new Date() });
    vi.mocked(findRecentMcpPartnerByAdminEmail).mockResolvedValue(null);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    } as any);
  });

  it('rejects free-provider emails', async () => {
    await expect(
      createTenantTool.handler(
        { org_name: 'Acme', admin_email: 'alex@gmail.com', admin_name: 'Alex', region: 'us' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_EMAIL' });
  });

  it('rejects when region does not match endpoint', async () => {
    await expect(
      createTenantTool.handler(
        { org_name: 'Acme', admin_email: 'alex@acme.com', admin_name: 'Alex', region: 'eu' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'REGION_MISMATCH' });
  });

  it('rejects when per-IP rate limit exhausted', async () => {
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(),
    });
    await expect(
      createTenantTool.handler(
        { org_name: 'Acme', admin_email: 'alex@acme.com', admin_name: 'Alex', region: 'us' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('creates partner, inserts activation token, sends email, writes audit, returns pending_email', async () => {
    const r = await createTenantTool.handler(
      { org_name: 'Acme', admin_email: 'alex@acme.com', admin_name: 'Alex', region: 'us' },
      ctx,
    );
    expect(r).toEqual({ tenant_id: 'partner-1', activation_status: 'pending_email' });
    expect(createPartner).toHaveBeenCalledWith(
      expect.objectContaining({
        orgName: 'Acme',
        adminEmail: 'alex@acme.com',
        adminName: 'Alex',
        passwordHash: null,
        origin: { mcp: true, ip: '1.2.3.4', userAgent: 'Claude' },
      }),
    );
    expect(db.insert).toHaveBeenCalled();
    expect(sendActivationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'alex@acme.com',
        partnerId: 'partner-1',
        rawToken: expect.any(String),
      }),
    );
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: 'system',
        action: 'partner.mcp_provisioned',
        resourceType: 'partner',
        resourceId: 'partner-1',
        result: 'success',
      }),
    );
  });

  it('is idempotent within 1h on same email + org_name — reuses existing partner and skips createPartner', async () => {
    vi.mocked(findRecentMcpPartnerByAdminEmail).mockResolvedValueOnce({ id: 'partner-1' });
    const r = await createTenantTool.handler(
      { org_name: 'Acme', admin_email: 'alex@acme.com', admin_name: 'Alex', region: 'us' },
      ctx,
    );
    expect(r).toEqual({ tenant_id: 'partner-1', activation_status: 'pending_email' });
    expect(createPartner).not.toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalled();
    expect(sendActivationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'alex@acme.com', partnerId: 'partner-1' }),
    );
  });
});
