import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { createHash } from 'crypto';
import { db } from '../db';
import {
  assetCheckouts,
  devices,
  portalBranding,
  portalUsers,
  ticketComments,
  tickets
} from '../db/schema';
import { hashPassword, isPasswordStrong, verifyPassword } from '../services/password';
import { writeAuditEvent } from '../services/auditEvents';

export const portalRoutes = new Hono();

type PortalSession = {
  token: string;
  portalUserId: string;
  orgId: string;
  createdAt: Date;
  expiresAt: Date;
};

type PortalAuthContext = {
  user: {
    id: string;
    orgId: string;
    email: string;
    name: string | null;
    receiveNotifications: boolean;
    status: string;
  };
  token: string;
};

declare module 'hono' {
  interface ContextVariableMap {
    portalAuth: PortalAuthContext;
  }
}

const portalSessions = new Map<string, PortalSession>();
const portalResetTokens = new Map<string, { userId: string; expiresAt: Date }>();

const SESSION_TTL_MS = 1000 * 60 * 60 * 24;
const RESET_TTL_MS = 1000 * 60 * 60;

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function buildPortalUserPayload(user: {
  id: string;
  orgId: string;
  email: string;
  name: string | null;
  receiveNotifications: boolean;
  status: string;
}) {
  return {
    id: user.id,
    orgId: user.orgId,
    email: user.email,
    name: user.name,
    receiveNotifications: user.receiveNotifications,
    status: user.status
  };
}

function writePortalAudit(
  c: Context,
  event: Parameters<typeof writeAuditEvent>[1]
) {
  if (process.env.NODE_ENV === 'test') {
    return;
  }
  writeAuditEvent(c, event);
}

async function portalAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }

  const token = authHeader.slice(7);
  const session = portalSessions.get(token);
  if (!session) {
    return c.json({ error: 'Invalid or expired session' }, 401);
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    portalSessions.delete(token);
    return c.json({ error: 'Invalid or expired session' }, 401);
  }

  const [user] = await db
    .select({
      id: portalUsers.id,
      orgId: portalUsers.orgId,
      email: portalUsers.email,
      name: portalUsers.name,
      receiveNotifications: portalUsers.receiveNotifications,
      status: portalUsers.status
    })
    .from(portalUsers)
    .where(and(eq(portalUsers.id, session.portalUserId), eq(portalUsers.orgId, session.orgId)))
    .limit(1);

  if (!user) {
    portalSessions.delete(token);
    return c.json({ error: 'Portal user not found' }, 401);
  }

  if (user.status !== 'active') {
    return c.json({ error: 'Account is not active' }, 403);
  }

  c.set('portalAuth', { user, token });
  return next();
}

async function generateTicketNumber(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = nanoid(10).toUpperCase();
    const [existing] = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.ticketNumber, candidate))
      .limit(1);

    if (!existing) {
      return candidate;
    }
  }

  return nanoid(12).toUpperCase();
}

const brandingParamSchema = z.object({
  domain: z.string().min(1)
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  orgId: z.string().uuid()
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
  orgId: z.string().uuid().optional()
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8)
});

const listSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional()
});

const ticketPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);

const createTicketSchema = z.object({
  subject: z.string().min(1).max(255),
  description: z.string().min(1),
  priority: ticketPrioritySchema.optional().default('normal')
});

const ticketParamSchema = z.object({
  id: z.string().uuid()
});

const commentSchema = z.object({
  content: z.string().min(1).max(5000)
});

const assetParamSchema = z.object({
  id: z.string().uuid()
});

const checkoutSchema = z.object({
  expectedReturnAt: z.string().datetime().optional(),
  checkoutNotes: z.string().max(2000).optional(),
  condition: z.string().max(100).optional()
});

const checkinSchema = z.object({
  checkinNotes: z.string().max(2000).optional(),
  condition: z.string().max(100).optional()
});

const updateProfileSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  receiveNotifications: z.boolean().optional(),
  password: z.string().min(8).optional()
});

// ============================================
// Public routes
// ============================================

portalRoutes.get('/branding/:domain', zValidator('param', brandingParamSchema), async (c) => {
  const { domain } = c.req.valid('param');
  const normalizedDomain = domain.trim().toLowerCase();

  const [branding] = await db
    .select({
      id: portalBranding.id,
      orgId: portalBranding.orgId,
      logoUrl: portalBranding.logoUrl,
      faviconUrl: portalBranding.faviconUrl,
      primaryColor: portalBranding.primaryColor,
      secondaryColor: portalBranding.secondaryColor,
      accentColor: portalBranding.accentColor,
      customDomain: portalBranding.customDomain,
      domainVerified: portalBranding.domainVerified,
      welcomeMessage: portalBranding.welcomeMessage,
      supportEmail: portalBranding.supportEmail,
      supportPhone: portalBranding.supportPhone,
      footerText: portalBranding.footerText,
      customCss: portalBranding.customCss,
      enableTickets: portalBranding.enableTickets,
      enableAssetCheckout: portalBranding.enableAssetCheckout,
      enableSelfService: portalBranding.enableSelfService,
      enablePasswordReset: portalBranding.enablePasswordReset
    })
    .from(portalBranding)
    .where(eq(portalBranding.customDomain, normalizedDomain))
    .limit(1);

  if (!branding || !branding.domainVerified) {
    return c.json({ error: 'Branding not found' }, 404);
  }

  return c.json({ branding });
});

// ============================================
// Auth routes
// ============================================

portalRoutes.post('/auth/login', zValidator('json', loginSchema), async (c) => {
  const { email, password, orgId } = c.req.valid('json');
  const normalizedEmail = normalizeEmail(email);

  const [user] = await db
    .select({
      id: portalUsers.id,
      orgId: portalUsers.orgId,
      email: portalUsers.email,
      name: portalUsers.name,
      passwordHash: portalUsers.passwordHash,
      receiveNotifications: portalUsers.receiveNotifications,
      status: portalUsers.status
    })
    .from(portalUsers)
    .where(and(eq(portalUsers.orgId, orgId), eq(portalUsers.email, normalizedEmail)))
    .limit(1);

  if (!user || !user.passwordHash) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  const validPassword = await verifyPassword(user.passwordHash, password);
  if (!validPassword) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  if (user.status !== 'active') {
    return c.json({ error: 'Account is not active' }, 403);
  }

  const now = new Date();
  const token = nanoid(48);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  portalSessions.set(token, {
    token,
    portalUserId: user.id,
    orgId: user.orgId,
    createdAt: now,
    expiresAt
  });

  await db
    .update(portalUsers)
    .set({ lastLoginAt: now, updatedAt: now })
    .where(eq(portalUsers.id, user.id));

  return c.json({
    user: buildPortalUserPayload(user),
    accessToken: token,
    expiresAt
  });
});

portalRoutes.post('/auth/forgot-password', zValidator('json', forgotPasswordSchema), async (c) => {
  const { email, orgId } = c.req.valid('json');
  const normalizedEmail = normalizeEmail(email);

  const [user] = await db
    .select({ id: portalUsers.id, email: portalUsers.email, orgId: portalUsers.orgId })
    .from(portalUsers)
    .where(
      orgId
        ? and(eq(portalUsers.orgId, orgId), eq(portalUsers.email, normalizedEmail))
        : eq(portalUsers.email, normalizedEmail)
    )
    .limit(1);

  if (user) {
    const resetToken = nanoid(48);
    const tokenHash = createHash('sha256').update(resetToken).digest('hex');
    const expiresAt = new Date(Date.now() + RESET_TTL_MS);
    portalResetTokens.set(tokenHash, { userId: user.id, expiresAt });
    console.log(`Portal password reset token for ${user.email}: ${resetToken}`);
  }

  return c.json({ success: true, message: 'If this email exists, a reset link will be sent.' });
});

portalRoutes.post('/auth/reset-password', zValidator('json', resetPasswordSchema), async (c) => {
  const { token, password } = c.req.valid('json');

  const passwordCheck = isPasswordStrong(password);
  if (!passwordCheck.valid) {
    return c.json({ error: passwordCheck.errors[0] }, 400);
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const stored = portalResetTokens.get(tokenHash);

  if (!stored || stored.expiresAt.getTime() <= Date.now()) {
    portalResetTokens.delete(tokenHash);
    return c.json({ error: 'Invalid or expired reset token' }, 400);
  }

  const passwordHash = await hashPassword(password);
  const now = new Date();

  await db
    .update(portalUsers)
    .set({ passwordHash, updatedAt: now })
    .where(eq(portalUsers.id, stored.userId));

  portalResetTokens.delete(tokenHash);

  for (const [sessionToken, session] of portalSessions.entries()) {
    if (session.portalUserId === stored.userId) {
      portalSessions.delete(sessionToken);
    }
  }

  return c.json({ success: true, message: 'Password reset successfully' });
});

// ============================================
// Protected routes
// ============================================

portalRoutes.use('/devices/*', portalAuthMiddleware);
portalRoutes.use('/devices', portalAuthMiddleware);
portalRoutes.use('/tickets/*', portalAuthMiddleware);
portalRoutes.use('/tickets', portalAuthMiddleware);
portalRoutes.use('/assets/*', portalAuthMiddleware);
portalRoutes.use('/assets', portalAuthMiddleware);
portalRoutes.use('/profile/*', portalAuthMiddleware);
portalRoutes.use('/profile', portalAuthMiddleware);

portalRoutes.get('/devices', zValidator('query', listSchema), async (c) => {
  const auth = c.get('portalAuth');
  const query = c.req.valid('query');
  const { page, limit, offset } = getPagination(query);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(devices)
    .where(eq(devices.orgId, auth.user.orgId));
  const count = countResult[0]?.count ?? 0;

  const data = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      displayName: devices.displayName,
      osType: devices.osType,
      osVersion: devices.osVersion,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt
    })
    .from(devices)
    .where(eq(devices.orgId, auth.user.orgId))
    .orderBy(desc(devices.lastSeenAt))
    .limit(limit)
    .offset(offset);

  return c.json({
    data,
    pagination: { page, limit, total: Number(count ?? 0) }
  });
});

portalRoutes.get('/tickets', zValidator('query', listSchema), async (c) => {
  const auth = c.get('portalAuth');
  const query = c.req.valid('query');
  const { page, limit, offset } = getPagination(query);

  const conditions = and(
    eq(tickets.orgId, auth.user.orgId),
    eq(tickets.submittedBy, auth.user.id)
  );

  const ticketCountResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(tickets)
    .where(conditions);
  const ticketCount = ticketCountResult[0]?.count ?? 0;

  const data = await db
    .select({
      id: tickets.id,
      ticketNumber: tickets.ticketNumber,
      subject: tickets.subject,
      status: tickets.status,
      priority: tickets.priority,
      createdAt: tickets.createdAt,
      updatedAt: tickets.updatedAt
    })
    .from(tickets)
    .where(conditions)
    .orderBy(desc(tickets.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({
    data,
    pagination: { page, limit, total: Number(ticketCount) }
  });
});

portalRoutes.post('/tickets', zValidator('json', createTicketSchema), async (c) => {
  const auth = c.get('portalAuth');
  const payload = c.req.valid('json');
  const now = new Date();
  const ticketNumber = await generateTicketNumber();

  const [ticket] = await db
    .insert(tickets)
    .values({
      orgId: auth.user.orgId,
      ticketNumber,
      submittedBy: auth.user.id,
      submitterEmail: auth.user.email,
      submitterName: auth.user.name ?? auth.user.email,
      subject: payload.subject,
      description: payload.description,
      priority: payload.priority,
      createdAt: now,
      updatedAt: now
    })
    .returning({
      id: tickets.id,
      ticketNumber: tickets.ticketNumber,
      subject: tickets.subject,
      description: tickets.description,
      status: tickets.status,
      priority: tickets.priority,
      createdAt: tickets.createdAt,
      updatedAt: tickets.updatedAt
    });

  writePortalAudit(c, {
    orgId: auth.user.orgId,
    actorType: 'user',
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: 'portal.ticket.create',
    resourceType: 'ticket',
    resourceId: ticket.id,
    resourceName: ticket.subject,
    details: {
      priority: ticket.priority,
      ticketNumber: ticket.ticketNumber,
    },
  });

  return c.json({ ticket }, 201);
});

portalRoutes.get('/tickets/:id', zValidator('param', ticketParamSchema), async (c) => {
  const auth = c.get('portalAuth');
  const { id } = c.req.valid('param');

  const [ticket] = await db
    .select({
      id: tickets.id,
      ticketNumber: tickets.ticketNumber,
      subject: tickets.subject,
      description: tickets.description,
      status: tickets.status,
      priority: tickets.priority,
      createdAt: tickets.createdAt,
      updatedAt: tickets.updatedAt
    })
    .from(tickets)
    .where(
      and(
        eq(tickets.id, id),
        eq(tickets.orgId, auth.user.orgId),
        eq(tickets.submittedBy, auth.user.id)
      )
    )
    .limit(1);

  if (!ticket) {
    return c.json({ error: 'Ticket not found' }, 404);
  }

  const comments = await db
    .select({
      id: ticketComments.id,
      authorName: ticketComments.authorName,
      content: ticketComments.content,
      createdAt: ticketComments.createdAt
    })
    .from(ticketComments)
    .where(and(eq(ticketComments.ticketId, ticket.id), eq(ticketComments.isPublic, true)))
    .orderBy(desc(ticketComments.createdAt));

  return c.json({ ticket: { ...ticket, comments } });
});

portalRoutes.post(
  '/tickets/:id/comments',
  zValidator('param', ticketParamSchema),
  zValidator('json', commentSchema),
  async (c) => {
    const auth = c.get('portalAuth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const [ticket] = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          eq(tickets.id, id),
          eq(tickets.orgId, auth.user.orgId),
          eq(tickets.submittedBy, auth.user.id)
        )
      )
      .limit(1);

    if (!ticket) {
      return c.json({ error: 'Ticket not found' }, 404);
    }

    const [comment] = await db
      .insert(ticketComments)
      .values({
        ticketId: ticket.id,
        portalUserId: auth.user.id,
        authorName: auth.user.name ?? auth.user.email,
        authorType: 'portal',
        content: payload.content,
        isPublic: true,
        createdAt: new Date()
      })
      .returning({
        id: ticketComments.id,
        authorName: ticketComments.authorName,
        content: ticketComments.content,
        createdAt: ticketComments.createdAt
      });

    writePortalAudit(c, {
      orgId: auth.user.orgId,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'portal.ticket.comment.create',
      resourceType: 'ticket_comment',
      resourceId: comment.id,
      details: {
        ticketId: ticket.id,
      },
    });

    return c.json({ comment }, 201);
  }
);

portalRoutes.get('/assets', zValidator('query', listSchema), async (c) => {
  const auth = c.get('portalAuth');
  const query = c.req.valid('query');
  const { page, limit, offset } = getPagination(query);

  const availableWhere = and(
    eq(devices.orgId, auth.user.orgId),
    isNull(assetCheckouts.id)
  );

  const assetCountResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(devices)
    .leftJoin(
      assetCheckouts,
      and(
        eq(assetCheckouts.deviceId, devices.id),
        eq(assetCheckouts.orgId, auth.user.orgId),
        isNull(assetCheckouts.checkedInAt)
      )
    )
    .where(availableWhere);
  const assetCount = assetCountResult[0]?.count ?? 0;

  const data = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      displayName: devices.displayName,
      osType: devices.osType,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt
    })
    .from(devices)
    .leftJoin(
      assetCheckouts,
      and(
        eq(assetCheckouts.deviceId, devices.id),
        eq(assetCheckouts.orgId, auth.user.orgId),
        isNull(assetCheckouts.checkedInAt)
      )
    )
    .where(availableWhere)
    .orderBy(desc(devices.updatedAt))
    .limit(limit)
    .offset(offset);

  return c.json({
    data,
    pagination: { page, limit, total: Number(assetCount) }
  });
});

portalRoutes.post(
  '/assets/:id/checkout',
  zValidator('param', assetParamSchema),
  zValidator('json', checkoutSchema),
  async (c) => {
    const auth = c.get('portalAuth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const [device] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.id, id), eq(devices.orgId, auth.user.orgId)))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Asset not found' }, 404);
    }

    const [activeCheckout] = await db
      .select({ id: assetCheckouts.id })
      .from(assetCheckouts)
      .where(
        and(
          eq(assetCheckouts.deviceId, id),
          eq(assetCheckouts.orgId, auth.user.orgId),
          isNull(assetCheckouts.checkedInAt)
        )
      )
      .limit(1);

    if (activeCheckout) {
      return c.json({ error: 'Asset is already checked out' }, 409);
    }

    const now = new Date();
    const expectedReturnAt = payload.expectedReturnAt ? new Date(payload.expectedReturnAt) : null;

    const [checkout] = await db
      .insert(assetCheckouts)
      .values({
        orgId: auth.user.orgId,
        deviceId: id,
        checkedOutTo: auth.user.id,
        checkedOutToName: auth.user.name ?? auth.user.email,
        checkedOutAt: now,
        expectedReturnAt,
        checkoutNotes: payload.checkoutNotes,
        condition: payload.condition,
        createdAt: now,
        updatedAt: now
      })
      .returning({
        id: assetCheckouts.id,
        deviceId: assetCheckouts.deviceId,
        checkedOutTo: assetCheckouts.checkedOutTo,
        checkedOutAt: assetCheckouts.checkedOutAt,
        expectedReturnAt: assetCheckouts.expectedReturnAt,
        checkoutNotes: assetCheckouts.checkoutNotes,
        condition: assetCheckouts.condition
      });

    writePortalAudit(c, {
      orgId: auth.user.orgId,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'portal.asset.checkout',
      resourceType: 'asset_checkout',
      resourceId: checkout.id,
      details: {
        deviceId: checkout.deviceId,
      },
    });

    return c.json({ checkout }, 201);
  }
);

portalRoutes.post(
  '/assets/:id/checkin',
  zValidator('param', assetParamSchema),
  zValidator('json', checkinSchema),
  async (c) => {
    const auth = c.get('portalAuth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const [activeCheckout] = await db
      .select({ id: assetCheckouts.id })
      .from(assetCheckouts)
      .where(
        and(
          eq(assetCheckouts.deviceId, id),
          eq(assetCheckouts.orgId, auth.user.orgId),
          isNull(assetCheckouts.checkedInAt)
        )
      )
      .limit(1);

    if (!activeCheckout) {
      return c.json({ error: 'Asset is not checked out' }, 400);
    }

    const now = new Date();
    const [checkout] = await db
      .update(assetCheckouts)
      .set({
        checkedInAt: now,
        checkinNotes: payload.checkinNotes,
        condition: payload.condition,
        updatedAt: now
      })
      .where(eq(assetCheckouts.id, activeCheckout.id))
      .returning({
        id: assetCheckouts.id,
        deviceId: assetCheckouts.deviceId,
        checkedInAt: assetCheckouts.checkedInAt,
        checkinNotes: assetCheckouts.checkinNotes,
        condition: assetCheckouts.condition
      });

    writePortalAudit(c, {
      orgId: auth.user.orgId,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'portal.asset.checkin',
      resourceType: 'asset_checkout',
      resourceId: checkout.id,
      details: {
        deviceId: checkout.deviceId,
      },
    });

    return c.json({ checkout });
  }
);

portalRoutes.get('/profile', async (c) => {
  const auth = c.get('portalAuth');
  return c.json({ user: buildPortalUserPayload(auth.user) });
});

portalRoutes.patch('/profile', zValidator('json', updateProfileSchema), async (c) => {
  const auth = c.get('portalAuth');
  const payload = c.req.valid('json');
  const updates: {
    name?: string;
    receiveNotifications?: boolean;
    passwordHash?: string;
    updatedAt: Date;
  } = { updatedAt: new Date() };

  if (payload.name !== undefined) {
    updates.name = payload.name;
  }

  if (payload.receiveNotifications !== undefined) {
    updates.receiveNotifications = payload.receiveNotifications;
  }

  if (payload.password) {
    const passwordCheck = isPasswordStrong(payload.password);
    if (!passwordCheck.valid) {
      return c.json({ error: passwordCheck.errors[0] }, 400);
    }
    updates.passwordHash = await hashPassword(payload.password);
  }

  const userResult = await db
    .update(portalUsers)
    .set(updates)
    .where(eq(portalUsers.id, auth.user.id))
    .returning({
      id: portalUsers.id,
      orgId: portalUsers.orgId,
      email: portalUsers.email,
      name: portalUsers.name,
      receiveNotifications: portalUsers.receiveNotifications,
      status: portalUsers.status
    });

  const user = userResult[0];
  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  writePortalAudit(c, {
    orgId: user.orgId,
    actorType: 'user',
    actorId: user.id,
    actorEmail: user.email,
    action: 'portal.profile.update',
    resourceType: 'portal_user',
    resourceId: user.id,
    resourceName: user.name ?? user.email,
    details: {
      updatedFields: Object.keys(payload),
      passwordUpdated: Boolean(payload.password),
    },
  });

  return c.json({ user: buildPortalUserPayload(user) });
});
