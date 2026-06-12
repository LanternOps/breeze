import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { ticketParts } from '../../db/schema';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { ticketPartSchema, updateTicketPartSchema, listTimeEntriesQuerySchema } from '@breeze/shared';

const idParam = z.object({ id: z.string().uuid() });
const partIdParam = z.object({ id: z.string().uuid() });
import {
  addTicketPart, updateTicketPart, deleteTicketPart,
  listTimeEntries, getTicketBillingSummary, TimeEntryServiceError
} from '../../services/timeEntryService';
import { getScopedTicketOr404 } from './tickets';
import { timeActorFrom } from '../timeEntries/timeEntries';

// Internal-only (spec D4): parts + per-ticket time data never reach org scope.
export const ticketPartsRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action);
const writePerm = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof TimeEntryServiceError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

// /parts/:id BEFORE the hub's /:id routes — this router mounts first in index.ts.
ticketPartsRoutes.patch('/parts/:id', scopes, writePerm, zValidator('param', partIdParam), zValidator('json', updateTicketPartSchema), async (c) => {
  const auth = c.get('auth');
  const rows = await db.select().from(ticketParts).where(eq(ticketParts.id, c.req.valid('param').id)).limit(1);
  const part = rows[0];
  if (!part || !(await getScopedTicketOr404(auth, part.ticketId))) {
    return c.json({ error: 'Part not found' }, 404);
  }
  try {
    const updated = await updateTicketPart(part.id, c.req.valid('json'), timeActorFrom(c));
    return c.json({ data: updated });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

ticketPartsRoutes.delete('/parts/:id', scopes, writePerm, zValidator('param', partIdParam), async (c) => {
  const auth = c.get('auth');
  const rows = await db.select().from(ticketParts).where(eq(ticketParts.id, c.req.valid('param').id)).limit(1);
  const part = rows[0];
  if (!part || !(await getScopedTicketOr404(auth, part.ticketId))) {
    return c.json({ error: 'Part not found' }, 404);
  }
  try {
    await deleteTicketPart(part.id, timeActorFrom(c));
    return c.json({ data: { deleted: true } });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

ticketPartsRoutes.get('/:id/parts', scopes, readPerm, zValidator('param', idParam), async (c) => {
  const auth = c.get('auth');
  const ticket = await getScopedTicketOr404(auth, c.req.valid('param').id);
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
  const parts = await db.select().from(ticketParts).where(eq(ticketParts.ticketId, ticket.id));
  return c.json({ data: parts });
});

ticketPartsRoutes.post('/:id/parts', scopes, writePerm, zValidator('param', idParam), zValidator('json', ticketPartSchema), async (c) => {
  const auth = c.get('auth');
  const ticket = await getScopedTicketOr404(auth, c.req.valid('param').id);
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
  try {
    const part = await addTicketPart(ticket.id, c.req.valid('json'), timeActorFrom(c));
    return c.json({ data: part }, 201);
  } catch (err) {
    return handleServiceError(c, err);
  }
});

ticketPartsRoutes.get('/:id/time-entries', scopes, readPerm, zValidator('param', idParam), zValidator('query', listTimeEntriesQuerySchema), async (c) => {
  const auth = c.get('auth');
  const ticket = await getScopedTicketOr404(auth, c.req.valid('param').id);
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
  const q = c.req.valid('query');
  const { entries, total } = await listTimeEntries({ ...q, ticketId: ticket.id });
  return c.json({ data: entries, total });
});

ticketPartsRoutes.get('/:id/billing-summary', scopes, readPerm, zValidator('param', idParam), async (c) => {
  const auth = c.get('auth');
  const ticket = await getScopedTicketOr404(auth, c.req.valid('param').id);
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
  const summary = await getTicketBillingSummary(ticket.id);
  return c.json({ data: summary });
});
