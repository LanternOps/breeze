import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { ticketsRoutes as ticketsApiRoutes } from './tickets';
import { ticketsBulkRoutes } from './bulk';
import { ticketExportRoutes } from './export';
import { ticketPartsRoutes } from './parts';
import { ticketMoveOrgRoutes } from './moveOrg';
import { ticketAttachmentRoutes } from './attachments';
import { ticketAiDraftsRoutes } from './aiDrafts';

export const ticketsRoutes = new Hono();

// Apply auth middleware to all routes — requireScope/requirePermission in the
// sub-routers depend on c.get('auth') being populated (same pattern as alerts/index.ts)
ticketsRoutes.use('*', authMiddleware);

// Literal-path routers BEFORE the /:id-bearing routers so they are never
// captured by a param matcher (Hono matching is registration-ordered).
ticketsRoutes.route('/', ticketExportRoutes);  // /export/... before /:id
ticketsRoutes.route('/', ticketPartsRoutes);   // /parts/:id + /:id/parts before generic /:id
ticketsRoutes.route('/', ticketsBulkRoutes);   // /bulk before /:id
// move-org BEFORE core /:id routes so POST /:id/move-org is not captured by
// the generic /:id param matcher (mirrors devices/index.ts mount ordering).
ticketsRoutes.route('/', ticketMoveOrgRoutes);
// attachments BEFORE core /:id routes so /:id/attachments and
// /:id/attachments/:attachmentId/content are not captured by the generic
// /:id param matcher (W08 #3902).
ticketsRoutes.route('/', ticketAttachmentRoutes);
// ai-drafts BEFORE the generic /:id routes for the same reason — its own
// segment count doesn't collide with bare /:id, but registration order stays
// consistent with the rest of this file's mount ordering rule.
ticketsRoutes.route('/', ticketAiDraftsRoutes);
ticketsRoutes.route('/', ticketsApiRoutes);
