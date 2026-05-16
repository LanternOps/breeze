import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, count, desc, eq, inArray, ne } from 'drizzle-orm';
import * as dbModule from '../../db';
import {
  accountDeletionRequests,
  organizationUsers,
  partners,
  partnerUsers,
  roles,
  users,
} from '../../db/schema';
import {
  rateLimiter,
  getRedis,
  verifyPassword,
} from '../../services';
import { authMiddleware, requireMfa, requirePermission } from '../../middleware/auth';
import { getEmailService } from '../../services/email';
import { PERMISSIONS } from '../../services/permissions';
import {
  getClientRateLimitKey,
  resolveUserAuditOrgId,
  writeAuthAudit,
} from './helpers';

const { db } = dbModule;
export const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') return fn();
  // Escape any ambient request-scoped DB context BEFORE entering system
  // scope. authMiddleware wraps the admin handler in withDbAccessContext
  // (the admin's own partner/org scope); withSystemDbAccessContext
  // short-circuits when a context already exists, so without
  // runOutsideDbContext these "system" queries silently ran as the admin's
  // own user and the deletion-request queue always came back empty. Mirror
  // lifecycle.ts's asSystem. See PR #696 Critical #1.
  const runOutside = dbModule.runOutsideDbContext;
  return typeof runOutside === 'function'
    ? runOutside(() => withSystem(fn))
    : withSystem(fn);
};

export const accountDeletionRoutes = new Hono();

export const accountDeletionRequestSchema = z.object({
  password: z.string().min(1).max(256),
  reason: z.string().trim().max(2000).optional(),
});

const PROCESS_WINDOW_DAYS = 30;

function processByDate(from: Date = new Date()): Date {
  const out = new Date(from.getTime());
  out.setUTCDate(out.getUTCDate() + PROCESS_WINDOW_DAYS);
  return out;
}

interface AdminRecipient {
  email: string;
  name: string | null;
}

async function findOrgAdminRecipients(opts: {
  partnerId: string | null;
  excludeUserId: string;
}): Promise<AdminRecipient[]> {
  const partnerId = opts.partnerId;
  if (!partnerId) return [];

  // Anyone with a `Partner Admin` role under the same partner — these are
  // the staff with full admin access for this tenant. System scope so the
  // org-user-scoped auth context that triggered this notification can still
  // reach partner-axis tables.
  const rows = await runWithSystemDbAccess(async () =>
    db
      .select({
        email: users.email,
        name: users.name,
      })
      .from(partnerUsers)
      .innerJoin(users, eq(users.id, partnerUsers.userId))
      .innerJoin(roles, eq(roles.id, partnerUsers.roleId))
      .where(
        and(
          eq(partnerUsers.partnerId, partnerId),
          eq(roles.name, 'Partner Admin'),
          ne(users.id, opts.excludeUserId),
          eq(users.status, 'active'),
        )
      )
  );

  return rows.map((r) => ({ email: r.email, name: r.name ?? null }));
}

async function findPartnerBillingEmail(partnerId: string | null): Promise<string | null> {
  if (!partnerId) return null;
  const [row] = await runWithSystemDbAccess(async () =>
    db
      .select({ billingEmail: partners.billingEmail })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1)
  );
  return row?.billingEmail ?? null;
}

async function notifyAdminsOfDeletionRequest(opts: {
  requestId: string;
  user: { id: string; email: string; name: string };
  partnerId: string | null;
  orgId: string | null;
  reason: string | null;
  processBy: Date;
}): Promise<void> {
  const emailService = getEmailService();
  if (!emailService) {
    console.warn('[account-deletion] Email service not configured; admin notification skipped');
    return;
  }

  const admins = await findOrgAdminRecipients({
    partnerId: opts.partnerId,
    excludeUserId: opts.user.id,
  });

  let recipientEmails = admins.map((a) => a.email);
  if (recipientEmails.length === 0) {
    const billing = await findPartnerBillingEmail(opts.partnerId);
    if (billing) recipientEmails = [billing];
  }

  if (recipientEmails.length === 0) {
    console.warn(
      `[account-deletion] No admin recipients resolved for request ${opts.requestId} (partnerId=${opts.partnerId ?? 'null'})`
    );
    return;
  }

  const dashboardBase = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/$/, '');
  // Stub admin review URL — admin-side review UI is future work.
  const reviewUrl = `${dashboardBase}/admin/account-deletion-requests/${opts.requestId}`;

  const subject = `Account deletion request: ${opts.user.email}`;
  const reasonBlock = opts.reason
    ? `<p><strong>Reason given:</strong></p><blockquote style="margin:0 0 12px;padding:8px 12px;border-left:3px solid #d1d5db;color:#374151;">${escapeHtml(opts.reason)}</blockquote>`
    : '';
  const html = `
    <p>${escapeHtml(opts.user.name)} (<a href="mailto:${escapeHtml(opts.user.email)}">${escapeHtml(opts.user.email)}</a>) has requested deletion of their Breeze account.</p>
    <p>The request will be processed automatically on or before <strong>${opts.processBy.toUTCString()}</strong>. You can review or cancel it from the admin console.</p>
    ${reasonBlock}
    <p><a href="${reviewUrl}">Review deletion request</a></p>
    <p style="font-size:12px;color:#6b7280;">Request ID: ${opts.requestId}</p>
  `.trim();

  const text = [
    `${opts.user.name} (${opts.user.email}) has requested deletion of their Breeze account.`,
    `The request will be processed on or before ${opts.processBy.toUTCString()}.`,
    opts.reason ? `Reason: ${opts.reason}` : null,
    `Review: ${reviewUrl}`,
    `Request ID: ${opts.requestId}`,
  ].filter(Boolean).join('\n');

  try {
    await emailService.sendEmail({
      to: recipientEmails,
      subject,
      html,
      text,
    });
  } catch (error) {
    console.error('[account-deletion] Failed to send admin notification email:', error);
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function serializeRequest(row: typeof accountDeletionRequests.$inferSelect) {
  return {
    requestId: row.id,
    status: row.status,
    requestedAt: row.requestedAt instanceof Date ? row.requestedAt.toISOString() : row.requestedAt,
    processBy: row.processBy instanceof Date ? row.processBy.toISOString() : row.processBy,
    reason: row.reason,
  };
}

// GET /auth/account-deletion-request — returns the user's current pending request, if any.
accountDeletionRoutes.get('/account-deletion-request', authMiddleware, async (c) => {
  const auth = c.get('auth');

  const [row] = await db
    .select()
    .from(accountDeletionRequests)
    .where(
      and(
        eq(accountDeletionRequests.userId, auth.user.id),
        eq(accountDeletionRequests.status, 'pending')
      )
    )
    .limit(1);

  if (!row) {
    return c.json({ pending: null });
  }
  return c.json({ pending: serializeRequest(row) });
});

// POST /auth/account-deletion-request — submit a new deletion request.
accountDeletionRoutes.post(
  '/account-deletion-request',
  authMiddleware,
  requireMfa(),
  zValidator('json', accountDeletionRequestSchema),
  async (c) => {
    const auth = c.get('auth');
    const { password, reason } = c.req.valid('json');

    // Rate limit password reverify attempts: 5 per 5 min per client.
    const redis = getRedis();
    if (!redis) {
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }

    const rateKey = `account-deletion:${getClientRateLimitKey(c)}:${auth.user.id}`;
    const rateCheck = await rateLimiter(redis, rateKey, 5, 5 * 60);
    if (!rateCheck.allowed) {
      return c.json({
        error: 'Too many attempts. Please try again later.',
        retryAfter: Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000),
      }, 429);
    }

    // Reverify password against the stored hash.
    const [userRow] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        passwordHash: users.passwordHash,
        partnerId: users.partnerId,
        orgId: users.orgId,
      })
      .from(users)
      .where(eq(users.id, auth.user.id))
      .limit(1);

    if (!userRow?.passwordHash) {
      writeAuthAudit(c, {
        action: 'user.account_deletion.requested',
        result: 'denied',
        reason: 'no_password',
        userId: auth.user.id,
        email: auth.user.email,
      });
      return c.json({ error: 'Invalid password' }, 401);
    }

    const passwordOk = await verifyPassword(userRow.passwordHash, password);
    if (!passwordOk) {
      writeAuthAudit(c, {
        action: 'user.account_deletion.requested',
        result: 'failure',
        reason: 'invalid_password',
        userId: auth.user.id,
        email: auth.user.email,
      });
      return c.json({ error: 'Invalid password' }, 401);
    }

    // Idempotency: return the existing pending request if one exists.
    const [existing] = await db
      .select()
      .from(accountDeletionRequests)
      .where(
        and(
          eq(accountDeletionRequests.userId, auth.user.id),
          eq(accountDeletionRequests.status, 'pending')
        )
      )
      .limit(1);

    if (existing) {
      return c.json(serializeRequest(existing), 200);
    }

    const processBy = processByDate();

    const [inserted] = await db
      .insert(accountDeletionRequests)
      .values({
        userId: auth.user.id,
        orgId: userRow.orgId ?? null,
        reason: reason && reason.length > 0 ? reason : null,
        status: 'pending',
        processBy,
      })
      .returning();

    if (!inserted) {
      return c.json({ error: 'Failed to record deletion request' }, 500);
    }

    // Audit + notify admins. Notification failures must not block the request.
    const auditOrgId = await resolveUserAuditOrgId(auth.user.id);
    writeAuthAudit(c, {
      orgId: auditOrgId ?? undefined,
      action: 'user.account_deletion.requested',
      result: 'success',
      userId: auth.user.id,
      email: userRow.email,
      name: userRow.name,
      details: { requestId: inserted.id, processBy: processBy.toISOString() },
    });

    void notifyAdminsOfDeletionRequest({
      requestId: inserted.id,
      user: { id: userRow.id, email: userRow.email, name: userRow.name },
      partnerId: userRow.partnerId ?? null,
      orgId: userRow.orgId ?? null,
      reason: inserted.reason,
      processBy,
    }).catch((error) => {
      console.error('[account-deletion] notifyAdminsOfDeletionRequest threw:', error);
    });

    return c.json(serializeRequest(inserted), 201);
  }
);

// PATCH /auth/account-deletion-request/:id — cancel a pending request.
accountDeletionRoutes.patch(
  '/account-deletion-request/:id',
  authMiddleware,
  zValidator('json', z.object({ status: z.literal('cancelled') })),
  async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id');

    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
      return c.json({ error: 'Invalid request id' }, 400);
    }

    const [row] = await db
      .select()
      .from(accountDeletionRequests)
      .where(
        and(
          eq(accountDeletionRequests.id, id),
          eq(accountDeletionRequests.userId, auth.user.id)
        )
      )
      .limit(1);

    if (!row) {
      return c.json({ error: 'Request not found' }, 404);
    }

    if (row.status !== 'pending') {
      return c.json({ error: `Cannot cancel a request in status "${row.status}"` }, 409);
    }

    const [updated] = await db
      .update(accountDeletionRequests)
      .set({
        status: 'cancelled',
        updatedAt: new Date(),
      })
      .where(eq(accountDeletionRequests.id, id))
      .returning();

    const auditOrgId = await resolveUserAuditOrgId(auth.user.id);
    writeAuthAudit(c, {
      orgId: auditOrgId ?? undefined,
      action: 'user.account_deletion.cancelled',
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: { requestId: id },
    });

    if (!updated) {
      return c.json({ error: 'Failed to cancel request' }, 500);
    }
    return c.json(serializeRequest(updated));
  }
);

// ============================================================
// Admin review endpoints
// ============================================================
//
// Mounted at /api/v1/admin/account-deletion-requests via index.ts. Lets a
// scoped admin (USERS_WRITE) list, view, and dispose of pending deletion
// requests for users in their tenant. Approve transitions the row to
// 'processing' so the back-office worker can pick it up; this UI never
// deletes user data itself. Reject cancels the request with an admin note
// and emails the user.

export const accountDeletionAdminRoutes = new Hono();

const requireUsersWrite = requirePermission(
  PERMISSIONS.USERS_WRITE.resource,
  PERMISSIONS.USERS_WRITE.action
);

const adminProcessSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    adminNote: z.string().trim().max(2000).optional(),
  }),
  z.object({
    action: z.literal('reject'),
    adminNote: z.string().trim().min(1, 'adminNote is required when rejecting').max(2000),
  }),
]);

const adminListQuerySchema = z.object({
  status: z
    .enum(['pending', 'processing', 'completed', 'cancelled'])
    .optional()
    .default('pending'),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface AdminAuth {
  scope: 'system' | 'partner' | 'organization';
  partnerId?: string | null;
  accessibleOrgIds?: string[] | null;
  canAccessOrg?: (orgId: string) => boolean;
  user: { id: string; email?: string };
}

/**
 * Resolve the set of user-ids the calling admin can act on, scoped to the
 * admin's partner/org boundary. Mirrors lifecycle.ts `adminCanReachUser` but
 * returns the list (so we can filter list/count queries) rather than checking
 * a single id. System scope returns null — meaning "no scope filter".
 */
async function resolveReachableUserIds(auth: AdminAuth): Promise<string[] | null> {
  if (auth.scope === 'system') return null;

  return runWithSystemDbAccess(async () => {
    const ids = new Set<string>();

    if (auth.scope === 'partner' && auth.partnerId) {
      const partnerRows = await db
        .select({ userId: partnerUsers.userId })
        .from(partnerUsers)
        .where(eq(partnerUsers.partnerId, auth.partnerId));
      for (const r of partnerRows) ids.add(r.userId);
    }

    const orgIds = (auth.accessibleOrgIds ?? []).filter((id): id is string => !!id);
    if (orgIds.length > 0) {
      const orgRows = await db
        .select({ userId: organizationUsers.userId })
        .from(organizationUsers)
        .where(inArray(organizationUsers.orgId, orgIds));
      for (const r of orgRows) ids.add(r.userId);
    }

    return Array.from(ids);
  });
}

function adminCanReach(auth: AdminAuth, reachable: string[] | null, targetUserId: string): boolean {
  if (auth.scope === 'system') return true;
  if (!reachable) return true;
  return reachable.includes(targetUserId);
}

interface AdminRequestRow {
  request: typeof accountDeletionRequests.$inferSelect;
  user: { id: string; email: string; name: string; createdAt: Date | null } | null;
}

function serializeAdminRow(row: AdminRequestRow) {
  return {
    requestId: row.request.id,
    status: row.request.status,
    requestedAt: row.request.requestedAt instanceof Date
      ? row.request.requestedAt.toISOString()
      : row.request.requestedAt,
    processBy: row.request.processBy instanceof Date
      ? row.request.processBy.toISOString()
      : row.request.processBy,
    processedAt: row.request.processedAt instanceof Date
      ? row.request.processedAt.toISOString()
      : row.request.processedAt,
    processedBy: row.request.processedBy,
    reason: row.request.reason,
    adminNote: row.request.adminNote ?? null,
    orgId: row.request.orgId,
    user: row.user
      ? {
          id: row.user.id,
          email: row.user.email,
          name: row.user.name,
          joinedAt: row.user.createdAt instanceof Date
            ? row.user.createdAt.toISOString()
            : row.user.createdAt,
        }
      : null,
  };
}

accountDeletionAdminRoutes.use('*', authMiddleware);

// GET /admin/account-deletion-requests
accountDeletionAdminRoutes.get(
  '/account-deletion-requests',
  requireUsersWrite,
  zValidator('query', adminListQuerySchema),
  async (c) => {
    const auth = c.get('auth') as AdminAuth;
    const { status, limit, offset } = c.req.valid('query');

    const reachable = await resolveReachableUserIds(auth);

    // Non-system admins outside any tenant get an empty page without
    // round-tripping to the DB.
    if (auth.scope !== 'system' && (!reachable || reachable.length === 0)) {
      return c.json({ requests: [], limit, offset });
    }

    // Push tenant scoping into the SQL WHERE. Previously the limit/offset
    // ran first and then JS filtered out unreachable rows — which produced
    // partial pages for non-system admins.
    const reachabilityFilter = reachable
      ? inArray(accountDeletionRequests.userId, reachable)
      : undefined;
    const whereClause = reachabilityFilter
      ? and(eq(accountDeletionRequests.status, status), reachabilityFilter)
      : eq(accountDeletionRequests.status, status);

    const rows = await runWithSystemDbAccess(async () =>
      db
        .select({
          request: accountDeletionRequests,
          user: {
            id: users.id,
            email: users.email,
            name: users.name,
            createdAt: users.createdAt,
          },
        })
        .from(accountDeletionRequests)
        .leftJoin(users, eq(users.id, accountDeletionRequests.userId))
        .where(whereClause)
        .orderBy(desc(accountDeletionRequests.requestedAt))
        .limit(limit)
        .offset(offset)
    );

    return c.json({
      requests: rows.map(serializeAdminRow),
      limit,
      offset,
    });
  }
);

// GET /admin/account-deletion-requests/pending-count
//   Lightweight count for the sidebar badge. Same scoping as list.
accountDeletionAdminRoutes.get(
  '/account-deletion-requests/pending-count',
  requireUsersWrite,
  async (c) => {
    const auth = c.get('auth') as AdminAuth;
    const reachable = await resolveReachableUserIds(auth);

    if (auth.scope !== 'system' && (!reachable || reachable.length === 0)) {
      return c.json({ count: 0 });
    }

    const reachabilityFilter = reachable
      ? inArray(accountDeletionRequests.userId, reachable)
      : undefined;
    const whereClause = reachabilityFilter
      ? and(eq(accountDeletionRequests.status, 'pending'), reachabilityFilter)
      : eq(accountDeletionRequests.status, 'pending');

    const [row] = await runWithSystemDbAccess(async () =>
      db
        .select({ total: count() })
        .from(accountDeletionRequests)
        .where(whereClause)
    );

    return c.json({ count: row?.total ?? 0 });
  }
);

// GET /admin/account-deletion-requests/:id
accountDeletionAdminRoutes.get(
  '/account-deletion-requests/:id',
  requireUsersWrite,
  async (c) => {
    const auth = c.get('auth') as AdminAuth;
    const id = c.req.param('id') ?? '';
    if (!UUID_RE.test(id)) return c.json({ error: 'Invalid request id' }, 400);

    const [row] = await runWithSystemDbAccess(async () =>
      db
        .select({
          request: accountDeletionRequests,
          user: {
            id: users.id,
            email: users.email,
            name: users.name,
            createdAt: users.createdAt,
          },
        })
        .from(accountDeletionRequests)
        .leftJoin(users, eq(users.id, accountDeletionRequests.userId))
        .where(eq(accountDeletionRequests.id, id))
        .limit(1)
    );

    if (!row) return c.json({ error: 'Request not found' }, 404);

    const reachable = await resolveReachableUserIds(auth);
    if (!adminCanReach(auth, reachable, row.request.userId)) {
      return c.json({ error: 'Request not in your tenant' }, 403);
    }

    return c.json(serializeAdminRow(row));
  }
);

async function notifyUserOfRejection(opts: {
  user: { email: string; name: string };
  adminNote: string;
  reason: string | null;
}): Promise<void> {
  const emailService = getEmailService();
  if (!emailService) return;

  const subject = 'Your Breeze account deletion request was declined';
  const reasonBlock = opts.reason
    ? `<p><strong>Reason you provided:</strong></p><blockquote style="margin:0 0 12px;padding:8px 12px;border-left:3px solid #d1d5db;color:#374151;">${escapeHtml(opts.reason)}</blockquote>`
    : '';
  const html = `
    <p>Hi ${escapeHtml(opts.user.name)},</p>
    <p>An administrator on your Breeze organization has reviewed your account deletion request and declined it. Your account remains active.</p>
    ${reasonBlock}
    <p><strong>Note from your administrator:</strong></p>
    <blockquote style="margin:0 0 12px;padding:8px 12px;border-left:3px solid #2563eb;color:#1e3a8a;">${escapeHtml(opts.adminNote)}</blockquote>
    <p>If you'd still like to proceed, contact your administrator directly. You can also resubmit the request from your account settings at any time.</p>
  `.trim();
  const text = [
    `Hi ${opts.user.name},`,
    '',
    'An administrator on your Breeze organization has reviewed your account deletion request and declined it. Your account remains active.',
    opts.reason ? `\nReason you provided: ${opts.reason}` : '',
    `\nNote from your administrator: ${opts.adminNote}`,
    '',
    "If you'd still like to proceed, contact your administrator directly.",
  ].filter(Boolean).join('\n');

  try {
    await emailService.sendEmail({ to: opts.user.email, subject, html, text });
  } catch (error) {
    console.error('[account-deletion] Failed to send rejection email:', error);
  }
}

// POST /admin/account-deletion-requests/:id/process
accountDeletionAdminRoutes.post(
  '/account-deletion-requests/:id/process',
  requireUsersWrite,
  requireMfa(),
  zValidator('json', adminProcessSchema),
  async (c) => {
    const auth = c.get('auth') as AdminAuth;
    const id = c.req.param('id') ?? '';
    if (!UUID_RE.test(id)) return c.json({ error: 'Invalid request id' }, 400);

    const body = c.req.valid('json');

    const [existing] = await runWithSystemDbAccess(async () =>
      db
        .select({
          request: accountDeletionRequests,
          user: {
            id: users.id,
            email: users.email,
            name: users.name,
            createdAt: users.createdAt,
          },
        })
        .from(accountDeletionRequests)
        .leftJoin(users, eq(users.id, accountDeletionRequests.userId))
        .where(eq(accountDeletionRequests.id, id))
        .limit(1)
    );

    if (!existing) return c.json({ error: 'Request not found' }, 404);

    const reachable = await resolveReachableUserIds(auth);
    if (!adminCanReach(auth, reachable, existing.request.userId)) {
      return c.json({ error: 'Request not in your tenant' }, 403);
    }

    if (existing.request.status !== 'pending') {
      return c.json(
        { error: `Request is already ${existing.request.status}` },
        409
      );
    }

    const now = new Date();
    const nextStatus = body.action === 'approve' ? 'processing' : 'cancelled';

    const [updated] = await runWithSystemDbAccess(async () =>
      db
        .update(accountDeletionRequests)
        .set({
          status: nextStatus,
          processedAt: now,
          processedBy: auth.user.id,
          adminNote: body.adminNote ?? null,
          updatedAt: now,
        })
        .where(eq(accountDeletionRequests.id, id))
        .returning()
    );

    if (!updated) {
      return c.json({ error: 'Failed to update request' }, 500);
    }

    const auditAction = body.action === 'approve'
      ? 'account.deletion_request.approved'
      : 'account.deletion_request.rejected';
    const auditOrgId = await resolveUserAuditOrgId(existing.request.userId);
    writeAuthAudit(c, {
      orgId: auditOrgId ?? existing.request.orgId ?? undefined,
      action: auditAction,
      result: 'success',
      userId: auth.user.id,
      email: auth.user.email,
      details: {
        requestId: id,
        targetUserId: existing.request.userId,
        adminNote: body.adminNote ?? null,
      },
    });

    if (body.action === 'reject' && existing.user) {
      void notifyUserOfRejection({
        user: { email: existing.user.email, name: existing.user.name },
        adminNote: body.adminNote,
        reason: existing.request.reason,
      }).catch((error) => {
        console.error('[account-deletion] notifyUserOfRejection threw:', error);
      });
    }

    return c.json(
      serializeAdminRow({ request: updated, user: existing.user })
    );
  }
);

