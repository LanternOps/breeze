import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../../db';
import { tickets, ticketComments } from '../../db/schema';
import {
  listSchema,
  createTicketSchema,
  ticketParamSchema,
  commentSchema,
} from './schemas';
import {
  getPagination,
  validatePortalCookieCsrfRequest,
  writePortalAudit,
} from './helpers';

export const ticketRoutes = new Hono();

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

  return c.json({
    data,
    pagination: { page, limit, total: Number(ticketCount) }
  });
});

ticketRoutes.post('/tickets', zValidator('json', createTicketSchema), async (c) => {
  const csrfError = validatePortalCookieCsrfRequest(c);
  if (csrfError) {
    return c.json({ error: csrfError }, 403);
  }

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
  if (!ticket) {
    return c.json({ error: 'Failed to create ticket' }, 500);
  }

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
    .where(and(eq(ticketComments.ticketId, ticket.id), eq(ticketComments.isPublic, true)))
    .orderBy(desc(ticketComments.createdAt));

  return c.json({ ticket: { ...ticket, comments } });
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
