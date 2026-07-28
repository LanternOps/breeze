import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { portalRoutes } from './portal';

const { sendPasswordResetMock, createTicketMock } = vi.hoisted(() => ({
  sendPasswordResetMock: vi.fn().mockResolvedValue(undefined),
  createTicketMock: vi.fn()
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'nanoid-token')
}));

// Mock all services
vi.mock('../services/password', () => ({
  hashPassword: vi.fn().mockResolvedValue('hashed-password'),
  isPasswordStrong: vi.fn(() => ({ valid: true, errors: [] })),
  verifyPassword: vi.fn()
}));

vi.mock('../services/email', () => ({
  getEmailService: vi.fn(() => ({
    sendPasswordReset: sendPasswordResetMock
  }))
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve())
      }))
    }))
  }
}));

// Portal ticket creation routes through the ticket service (stamps partner_id,
// allocates internal numbers, emits lifecycle events) — mock the service here.
vi.mock('../services/ticketService', () => ({
  createTicket: createTicketMock,
  TicketServiceError: class TicketServiceError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.name = 'TicketServiceError';
      this.status = status;
    }
  }
}));

vi.mock('../db/schema', () => ({
  assetCheckouts: {},
  devices: {},
  // The portal route graph transitively imports networkBaseline.ts, which reads
  // discoveredAssetTypeEnum.enumValues at module load — the full-module mock must
  // provide it or the whole suite fails to load.
  discoveredAssetTypeEnum: { enumValues: [] },
  portalBranding: {},
  portalUsers: {},
  ticketComments: {},
  tickets: {},
  ticketStatuses: {}
}));

import { nanoid } from 'nanoid';
import { isPasswordStrong, verifyPassword } from '../services/password';
import { db } from '../db';

const makeThenable = (result: any, chain: Record<string, any>) => ({
  ...chain,
  then: (resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)
});

const makeLimitChain = (result: any) =>
  makeThenable(result, {
    offset: vi.fn().mockResolvedValue(result)
  });

const makeOrderChain = (result: any) =>
  makeThenable(result, {
    limit: vi.fn().mockReturnValue(makeLimitChain(result))
  });

const makeWhereChain = (result: any) =>
  makeThenable(result, {
    limit: vi.fn().mockResolvedValue(result),
    orderBy: vi.fn().mockReturnValue(makeOrderChain(result))
  });

const mockSelectResult = (result: any) => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue(makeWhereChain(result)),
    leftJoin: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(makeWhereChain(result))
    })
  })
});

const mockSelectLimit = mockSelectResult;
const mockSelectWhere = mockSelectResult;
const mockSelectOrderLimitOffset = mockSelectResult;
const mockSelectOrder = mockSelectResult;
const mockSelectLeftJoinWhere = mockSelectResult;
const mockSelectLeftJoinOrderLimitOffset = mockSelectResult;

const mockUpdateReturning = (result: any) => ({
  set: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(result)
    })
  })
});

const portalUser = {
  id: 'portal-user-1',
  orgId: 'org-123',
  email: 'portal@example.com',
  name: 'Portal User',
  passwordHash: 'hash',
  receiveNotifications: true,
  status: 'active'
};

describe('portal routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/portal', portalRoutes);
  });

  const loginUser = async () => {
    vi.mocked(verifyPassword).mockResolvedValue(true);

    const res = await app.request('/portal/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'portal@example.com',
        password: 'password123',
        orgId: 'f1b0c8a6-45d1-4f84-8b8b-0ad0ce620001'
      })
    });

    const body = await res.json();
    return body.accessToken as string;
  };

  describe('GET /portal/branding/:domain', () => {
    it('should return branding when domain is verified', async () => {
      vi.mocked(db.select).mockReturnValueOnce(
        mockSelectLimit([
          {
            id: 'branding-1',
            orgId: 'org-123',
            logoUrl: null,
            faviconUrl: null,
            primaryColor: '#111111',
            secondaryColor: '#222222',
            accentColor: '#333333',
            customDomain: 'portal.example.com',
            domainVerified: true,
            welcomeMessage: 'Welcome',
            supportEmail: 'support@example.com',
            supportPhone: null,
            footerText: 'Footer',
            customCss: null,
            enableTickets: true,
            enableAssetCheckout: true,
            enableSelfService: true,
            enablePasswordReset: true
          }
        ]) as any
      );

      const res = await app.request('/portal/branding/portal.example.com');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.branding.customDomain).toBe('portal.example.com');
    });

    it('should return 404 when branding is missing or unverified', async () => {
      vi.mocked(db.select).mockReturnValueOnce(
        mockSelectLimit([
          {
            id: 'branding-1',
            customDomain: 'portal.example.com',
            domainVerified: false
          }
        ]) as any
      );

      const res = await app.request('/portal/branding/portal.example.com');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /portal/auth/login', () => {
    it('should login successfully', async () => {
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(db.select).mockReturnValueOnce(
        mockSelectLimit([
          portalUser
        ]) as any
      );
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const res = await app.request('/portal/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'portal@example.com',
          password: 'password123',
          orgId: 'f1b0c8a6-45d1-4f84-8b8b-0ad0ce620001'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.email).toBe('portal@example.com');
      expect(body.accessToken).toBeDefined();
    });

    it('should reject invalid password', async () => {
      vi.mocked(verifyPassword).mockResolvedValue(false);
      vi.mocked(db.select).mockReturnValueOnce(
        mockSelectLimit([
          portalUser
        ]) as any
      );

      const res = await app.request('/portal/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'portal@example.com',
          password: 'bad-password',
          orgId: 'f1b0c8a6-45d1-4f84-8b8b-0ad0ce620001'
        })
      });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /portal/auth/forgot-password', () => {
    it('should always return success', async () => {
      vi.mocked(db.select).mockReturnValueOnce(mockSelectLimit([]) as any);

      const res = await app.request('/portal/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'missing@example.com'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(sendPasswordResetMock).not.toHaveBeenCalled();
    });

    it('should send password reset email when user exists', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectLimit([
          {
            id: 'portal-user-1',
            email: 'portal@example.com',
            orgId: 'f1b0c8a6-45d1-4f84-8b8b-0ad0ce620001'
          }
        ]) as any)
        .mockReturnValueOnce(mockSelectLimit([]) as any); // password reset defaults enabled

      const res = await app.request('/portal/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'portal@example.com',
          orgId: 'f1b0c8a6-45d1-4f84-8b8b-0ad0ce620001'
        })
      });

      expect(res.status).toBe(200);
      expect(sendPasswordResetMock).toHaveBeenCalledTimes(1);
      expect(sendPasswordResetMock).toHaveBeenCalledWith({
        to: 'portal@example.com',
        resetUrl: 'http://localhost:4321/portal/reset-password?token=nanoid-token&orgId=f1b0c8a6-45d1-4f84-8b8b-0ad0ce620001'
      });
    });

    it('keeps the generic response but does not issue a token when password reset is disabled', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectLimit([{
          id: 'portal-user-1',
          email: 'portal@example.com',
          orgId: 'f1b0c8a6-45d1-4f84-8b8b-0ad0ce620001',
        }]) as any)
        .mockReturnValueOnce(mockSelectLimit([{ enablePasswordReset: false }]) as any);

      const res = await app.request('/portal/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'portal@example.com',
          orgId: 'f1b0c8a6-45d1-4f84-8b8b-0ad0ce620001',
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true });
      expect(sendPasswordResetMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /portal/auth/reset-password', () => {
    it('should reset password with valid token', async () => {
      vi.mocked(nanoid).mockReturnValueOnce('reset-token');
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectLimit([
          {
            id: 'portal-user-1',
            email: 'portal@example.com',
            orgId: 'org-123'
          }
        ]) as any)
        .mockReturnValueOnce(mockSelectLimit([]) as any); // issuance feature flag

      await app.request('/portal/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'portal@example.com',
          orgId: 'f1b0c8a6-45d1-4f84-8b8b-0ad0ce620001'
        })
      });

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectLimit([{ orgId: 'org-123' }]) as any)
        .mockReturnValueOnce(mockSelectLimit([]) as any); // consumption feature flag

      const res = await app.request('/portal/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'reset-token',
          password: 'NewStrongPass123'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('should reject invalid token', async () => {
      vi.mocked(isPasswordStrong).mockReturnValue({ valid: true, errors: [] });

      const res = await app.request('/portal/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'invalid-token',
          password: 'NewStrongPass123'
        })
      });

      expect(res.status).toBe(400);
    });

    it('rejects a previously issued token if password reset is disabled before consumption', async () => {
      vi.mocked(nanoid).mockReturnValueOnce('disabled-after-issue-token');
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectLimit([{
          id: 'portal-user-reset-disabled',
          email: 'reset-disabled@example.com',
          orgId: 'org-reset-disabled',
        }]) as any)
        .mockReturnValueOnce(mockSelectLimit([{ enablePasswordReset: true }]) as any);

      await app.request('/portal/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'reset-disabled@example.com' }),
      });

      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectLimit([{ orgId: 'org-reset-disabled' }]) as any)
        .mockReturnValueOnce(mockSelectLimit([{ enablePasswordReset: false }]) as any);

      const res = await app.request('/portal/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'disabled-after-issue-token',
          password: 'NewStrongPass123',
        }),
      });

      expect(res.status).toBe(403);
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('GET /portal/devices', () => {
    it('returns 403 when self-service device access is disabled', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectLimit([portalUser]) as any)
        .mockReturnValueOnce(mockSelectLimit([portalUser]) as any)
        .mockReturnValueOnce(mockSelectLimit([{ enableSelfService: false }]) as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      } as any);

      const token = await loginUser();
      const res = await app.request('/portal/devices', {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'PORTAL_SELF_SERVICE_DISABLED' });
    });

    it('should return devices with pagination', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(mockSelectLimit([]) as any) // self-service defaults enabled
        .mockReturnValueOnce(mockSelectWhere([{ count: 2 }]) as any)
        .mockReturnValueOnce(
          mockSelectOrderLimitOffset([
            {
              id: 'device-1',
              hostname: 'host-1',
              displayName: 'Host 1',
              osType: 'windows',
              osVersion: '11',
              status: 'online',
              lastSeenAt: new Date()
            }
          ]) as any
        );

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const token = await loginUser();

      const res = await app.request('/portal/devices?page=1&limit=50', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pagination.total).toBe(2);
      expect(body.data).toHaveLength(1);
    });
  });

  describe('GET /portal/tickets', () => {
    it('should return tickets for portal user', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        // #2345 — portalTicketsEnabledMiddleware branding lookup (no row → fail-open, ticketing enabled)
        .mockReturnValueOnce(mockSelectLimit([]) as any)
        .mockReturnValueOnce(mockSelectWhere([{ count: 1 }]) as any)
        .mockReturnValueOnce(
          mockSelectOrderLimitOffset([
            {
              id: 'ticket-1',
              ticketNumber: 'TICKET-1',
              subject: 'Help needed',
              status: 'open',
              priority: 'normal',
              createdAt: new Date(),
              updatedAt: new Date()
            }
          ]) as any
        );

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const token = await loginUser();

      const res = await app.request('/portal/tickets?page=1&limit=25', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.pagination.total).toBe(1);
    });

    // #2345 — enforcement wiring regression guard: drives the REAL portalRoutes
    // mount (index.ts registration order included), not a re-wired test app. If
    // the portalTicketsEnabledMiddleware use() in routes/portal/index.ts is ever
    // removed or reordered, this fails.
    it('returns 403 PORTAL_TICKETS_DISABLED through the real mount when enable_tickets is false', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        // portalTicketsEnabledMiddleware branding lookup — explicit false
        .mockReturnValueOnce(mockSelectLimit([{ enableTickets: false }]) as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const token = await loginUser();

      const res = await app.request('/portal/tickets?page=1&limit=25', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Ticketing is not enabled for this portal');
      expect(body.code).toBe('PORTAL_TICKETS_DISABLED');
    });
  });

  describe('POST /portal/tickets', () => {
    it('should create a ticket', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        // #2345 — portalTicketsEnabledMiddleware branding lookup (no row → fail-open, ticketing enabled)
        .mockReturnValueOnce(mockSelectLimit([]) as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      createTicketMock.mockResolvedValueOnce({
        id: 'ticket-1',
        ticketNumber: 'TICKET-1',
        subject: 'Need help',
        description: 'Issue details',
        status: 'open',
        priority: 'normal',
        createdAt: new Date(),
        updatedAt: new Date()
      });

      const token = await loginUser();

      const res = await app.request('/portal/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          subject: 'Need help',
          description: 'Issue details',
          priority: 'normal'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.ticket.ticketNumber).toBe('TICKET-1');

      // Creation must flow through the ticket service with portal provenance.
      expect(createTicketMock).toHaveBeenCalledTimes(1);
      expect(createTicketMock).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: portalUser.orgId,
          subject: 'Need help',
          source: 'portal',
          submittedBy: portalUser.id,
          submitterEmail: portalUser.email
        }),
        expect.objectContaining({ userId: portalUser.id })
      );
    });
  });

  describe('GET /portal/tickets/:id', () => {
    it('should return ticket details with comments', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        // #2345 — portalTicketsEnabledMiddleware branding lookup (no row → fail-open, ticketing enabled)
        .mockReturnValueOnce(mockSelectLimit([]) as any)
        .mockReturnValueOnce(
          mockSelectLimit([
            {
              id: 'ticket-1',
              ticketNumber: 'TICKET-1',
              subject: 'Need help',
              description: 'Issue details',
              status: 'open',
              priority: 'normal',
              createdAt: new Date(),
              updatedAt: new Date()
            }
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectOrder([
            {
              id: 'comment-1',
              authorName: 'Support',
              content: 'We are on it',
              createdAt: new Date()
            }
          ]) as any
        );

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const token = await loginUser();

      const res = await app.request('/portal/tickets/2e3f2d2f-3f1f-4bcf-bd0c-4c7d5f0b0001', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ticket.comments).toHaveLength(1);
    });

    it('should return 404 when ticket is missing', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        // #2345 — portalTicketsEnabledMiddleware branding lookup (no row → fail-open, ticketing enabled)
        .mockReturnValueOnce(mockSelectLimit([]) as any)
        .mockReturnValueOnce(mockSelectLimit([]) as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const token = await loginUser();

      const res = await app.request('/portal/tickets/2e3f2d2f-3f1f-4bcf-bd0c-4c7d5f0b0001', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /portal/tickets/:id/comments', () => {
    it('should add a comment', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        // #2345 — portalTicketsEnabledMiddleware branding lookup (no row → fail-open, ticketing enabled)
        .mockReturnValueOnce(mockSelectLimit([]) as any)
        .mockReturnValueOnce(mockSelectLimit([{ id: 'ticket-1' }]) as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            {
              id: 'comment-1',
              authorName: 'Portal User',
              content: 'Any update?',
              createdAt: new Date()
            }
          ])
        })
      } as any);

      const token = await loginUser();

      const res = await app.request(
        '/portal/tickets/2e3f2d2f-3f1f-4bcf-bd0c-4c7d5f0b0001/comments',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ content: 'Any update?' })
        }
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.comment.content).toBe('Any update?');
    });

    it('should return 404 when ticket is missing', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        // #2345 — portalTicketsEnabledMiddleware branding lookup (no row → fail-open, ticketing enabled)
        .mockReturnValueOnce(mockSelectLimit([]) as any)
        .mockReturnValueOnce(mockSelectLimit([]) as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const token = await loginUser();

      const res = await app.request(
        '/portal/tickets/2e3f2d2f-3f1f-4bcf-bd0c-4c7d5f0b0001/comments',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ content: 'Any update?' })
        }
      );

      expect(res.status).toBe(404);
    });
  });

  describe('GET /portal/assets', () => {
    it('returns 403 when asset checkout is disabled', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectLimit([portalUser]) as any)
        .mockReturnValueOnce(mockSelectLimit([portalUser]) as any)
        .mockReturnValueOnce(mockSelectLimit([{ enableAssetCheckout: false }]) as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      } as any);

      const token = await loginUser();
      const res = await app.request('/portal/assets', {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'PORTAL_ASSET_CHECKOUT_DISABLED' });
    });

    it('should return available assets', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(mockSelectLimit([]) as any) // asset checkout defaults enabled
        .mockReturnValueOnce(mockSelectLeftJoinWhere([{ count: 1 }]) as any)
        .mockReturnValueOnce(
          mockSelectLeftJoinOrderLimitOffset([
            {
              id: 'device-1',
              hostname: 'asset-1',
              displayName: 'Asset 1',
              osType: 'linux',
              status: 'online',
              lastSeenAt: new Date()
            }
          ]) as any
        );

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const token = await loginUser();

      const res = await app.request('/portal/assets', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pagination.total).toBe(1);
      expect(body.data).toHaveLength(1);
    });
  });

  describe('POST /portal/assets/:id/checkout', () => {
    it('should checkout an asset', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(mockSelectLimit([]) as any) // asset checkout defaults enabled
        .mockReturnValueOnce(mockSelectLimit([{ id: 'device-1' }]) as any)
        .mockReturnValueOnce(mockSelectLimit([]) as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            {
              id: 'checkout-1',
              deviceId: 'device-1',
              checkedOutTo: 'portal-user-1',
              checkedOutAt: new Date(),
              expectedReturnAt: null,
              checkoutNotes: null,
              condition: 'good'
            }
          ])
        })
      } as any);

      const token = await loginUser();

      const res = await app.request('/portal/assets/2e3f2d2f-3f1f-4bcf-bd0c-4c7d5f0b0001/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ condition: 'good' })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.checkout.deviceId).toBe('device-1');
    });

    it('should return 409 when asset is already checked out', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(mockSelectLimit([]) as any) // asset checkout defaults enabled
        .mockReturnValueOnce(mockSelectLimit([{ id: 'device-1' }]) as any)
        .mockReturnValueOnce(mockSelectLimit([{ id: 'checkout-1' }]) as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const token = await loginUser();

      const res = await app.request('/portal/assets/2e3f2d2f-3f1f-4bcf-bd0c-4c7d5f0b0001/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(409);
    });
  });

  describe('POST /portal/assets/:id/checkin', () => {
    it('should checkin an asset', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(mockSelectLimit([]) as any) // asset checkout defaults enabled
        .mockReturnValueOnce(mockSelectLimit([{ id: 'checkout-1', checkedOutTo: portalUser.id }]) as any);

      vi.mocked(db.update)
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined)
          })
        } as any)
        .mockReturnValueOnce(
          mockUpdateReturning([
            {
              id: 'checkout-1',
              deviceId: 'device-1',
              checkedInAt: new Date(),
              checkinNotes: 'returned',
              condition: 'good'
            }
          ]) as any
        );

      const token = await loginUser();

      const res = await app.request('/portal/assets/2e3f2d2f-3f1f-4bcf-bd0c-4c7d5f0b0001/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ checkinNotes: 'returned', condition: 'good' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.checkout.id).toBe('checkout-1');
    });

    it('should return 400 when asset is not checked out', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(mockSelectLimit([]) as any) // asset checkout defaults enabled
        .mockReturnValueOnce(mockSelectLimit([]) as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const token = await loginUser();

      const res = await app.request('/portal/assets/2e3f2d2f-3f1f-4bcf-bd0c-4c7d5f0b0001/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);
    });

    it('does not allow another portal contact in the same org to check in the asset', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectLimit([portalUser]) as any)
        .mockReturnValueOnce(mockSelectLimit([portalUser]) as any)
        .mockReturnValueOnce(mockSelectLimit([]) as any) // feature flag default enabled
        .mockReturnValueOnce(mockSelectLimit([{ id: 'checkout-1', checkedOutTo: 'another-contact' }]) as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      } as any);

      const token = await loginUser();
      const res = await app.request('/portal/assets/2e3f2d2f-3f1f-4bcf-bd0c-4c7d5f0b0001/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(403);
      expect(db.update).toHaveBeenCalledTimes(1); // login timestamp only
    });

    it('reports a conflict when checkout ownership changes before the atomic update', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectLimit([portalUser]) as any)
        .mockReturnValueOnce(mockSelectLimit([portalUser]) as any)
        .mockReturnValueOnce(mockSelectLimit([]) as any) // feature flag default enabled
        .mockReturnValueOnce(mockSelectLimit([{ id: 'checkout-1', checkedOutTo: portalUser.id }]) as any);

      vi.mocked(db.update)
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
        } as any)
        .mockReturnValueOnce(mockUpdateReturning([]) as any);

      const token = await loginUser();
      const res = await app.request('/portal/assets/2e3f2d2f-3f1f-4bcf-bd0c-4c7d5f0b0001/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(409);
    });
  });

  describe('GET /portal/profile', () => {
    it('should return current portal user', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        );

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const token = await loginUser();

      const res = await app.request('/portal/profile', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.email).toBe('portal@example.com');
    });
  });

  describe('PATCH /portal/profile', () => {
    it('should update profile fields', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        );

      vi.mocked(db.update)
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined)
          })
        } as any)
        .mockReturnValueOnce(
          mockUpdateReturning([
            {
              id: 'portal-user-1',
              orgId: 'org-123',
              email: 'portal@example.com',
              name: 'Updated User',
              receiveNotifications: false,
              status: 'active'
            }
          ]) as any
        );

      const token = await loginUser();

      const res = await app.request('/portal/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: 'Updated User',
          receiveNotifications: false,
          password: 'NewStrongPass123'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.name).toBe('Updated User');
    });

    it('should reject weak password updates', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        )
        .mockReturnValueOnce(
          mockSelectLimit([
            portalUser
          ]) as any
        );

      vi.mocked(isPasswordStrong).mockReturnValue({
        valid: false,
        errors: ['Password too weak']
      });

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const token = await loginUser();

      const res = await app.request('/portal/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password: 'weak' })
      });

      expect(res.status).toBe(400);
    });
  });
});
