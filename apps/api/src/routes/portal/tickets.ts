import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { tickets, ticketComments } from '../../db/schema';
import {
  listSchema,
  createTicketSchema,
  ticketParamSchema,
  commentSchema,
} from './schemas';
import {
  applyPortalCacheHeaders,
  buildWeakEtag,
  getPagination,
  isEtagFresh,
  validatePortalCookieCsrfRequest,
  writePortalAudit,
} from './helpers';
import { createTicket, TicketServiceError } from '../../services/ticketService';

export const ticketRoutes = new Hono();

ticketRoutes.get('/tickets', zValidator('query', listSchema), async (c) => {
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

  const payload = {
    data,
    pagination: { page, limit, total: Number(ticketCount) }
  };

  applyPortalCacheHeaders(c, {
    scope: 'private',
    browserMaxAgeSeconds: 15,
    staleWhileRevalidateSeconds: 90,
    vary: ['Authorization', 'Cookie']
  });
  const etag = buildWeakEtag(payload);
  c.header('ETag', etag);

  if (isEtagFresh(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: c.res.headers });
  }

  return c.json(payload);
});

ticketRoutes.post('/tickets', zValidator('json', createTicketSchema), async (c) => {
  const csrfError = validatePortalCookieCsrfRequest(c);
  if (csrfError) {
    return c.json({ error: csrfError }, 403);
  }

  const auth = c.get('portalAuth');
  const payload = c.req.valid('json');

  let created: Awaited<ReturnType<typeof createTicket>>;
  try {
    // NOTE: the actor `userId` here is a portal_users id, NOT a users.id. The
    // ticket service only uses it for audit/event metadata (no FK). It must
    // never be routed into a column that FKs users.id — in particular, do NOT
    // call addTicketComment from portal handlers (it writes actor.userId →
    // ticket_comments.user_id). Portal comments set portal_user_id directly
    // (see the POST /tickets/:id/comments handler below).
    created = await createTicket(
      {
        orgId: auth.user.orgId,
        subject: payload.subject,
        description: payload.description,
        priority: payload.priority,
        source: 'portal',
        submittedBy: auth.user.id,
        submitterEmail: auth.user.email,
        submitterName: auth.user.name ?? auth.user.email,
      },
      { userId: auth.user.id, name: auth.user.name ?? auth.user.email, email: auth.user.email }
    );
  } catch (err) {
    if (err instanceof TicketServiceError) {
      return c.json({ error: err.message }, err.status);
    }
    throw err;
  }

  const ticket = {
    id: created.id,
    ticketNumber: created.ticketNumber,
    subject: created.subject,
    description: created.description,
    status: created.status,
    priority: created.priority,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
  };

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

ticketRoutes.get('/tickets/:id', zValidator('param', ticketParamSchema), async (c) => {
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
    .where(and(
      eq(ticketComments.ticketId, ticket.id),
      eq(ticketComments.isPublic, true),
      isNull(ticketComments.deletedAt)
    ))
    .orderBy(desc(ticketComments.createdAt));

  const payload = { ticket: { ...ticket, comments } };

  applyPortalCacheHeaders(c, {
    scope: 'private',
    browserMaxAgeSeconds: 15,
    staleWhileRevalidateSeconds: 90,
    vary: ['Authorization', 'Cookie']
  });
  const etag = buildWeakEtag(payload);
  c.header('ETag', etag);

  if (isEtagFresh(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: c.res.headers });
  }

  return c.json(payload);
});

ticketRoutes.post(
  '/tickets/:id/comments',
  zValidator('param', ticketParamSchema),
  zValidator('json', commentSchema),
  async (c) => {
    const csrfError = validatePortalCookieCsrfRequest(c);
    if (csrfError) {
      return c.json({ error: csrfError }, 403);
    }

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
    if (!comment) {
      // Near-impossible (an insert that neither throws nor returns a row), but
      // every other failure on this route flows through onError+Sentry — make
      // this branch visible too rather than returning a silent 500.
      console.error('[portal] ticket_comments insert returned no row', {
        ticketId: ticket.id,
        orgId: auth.user.orgId,
      });
      return c.json({ error: 'Failed to create ticket comment' }, 500);
    }

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
