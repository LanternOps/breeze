import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { writeContactAudit } from '../../services/contacts/audit';
import { PERMISSIONS } from '../../services/permissions';
import { listCreatedContacts, removeCreatedContacts } from '../../services/ticketImport/createdContacts';
import { activeRunOf, getSource, lockSource, runActive } from '../../services/ticketImport/sourceStore';
import { callerPartner, idParamSchema, importErrorResponse } from './shared';

/**
 * The contacts a source created (#8313 W4b; spec 2026-10-19 §5.7, §5.13),
 * listed from their links and removable as a set. A partner-wide admin of the
 * caller's partner (`callerPartner`); removal narrows, so any partner-wide
 * admin may, with MFA, and never while a run of the source is queued or
 * running (409 TICKET_IMPORT_RUN_ACTIVE).
 *
 * Both run in the ambient request transaction: they call no source. Removal
 * writes the live `contact.delete` audit row per contact, as the contact
 * delete route does, and one partner-level summary row.
 */
export const ticketImportCreatedContactRoutes = new Hono();

const readGate = [
  requireScope('partner'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
] as const;
const writeGate = [
  requireScope('partner'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
] as const;

const listQuerySchema = z.object({
  after: z.string().guid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

ticketImportCreatedContactRoutes.get(
  '/sources/:id/created-contacts',
  ...readGate,
  zValidator('param', idParamSchema),
  zValidator('query', listQuerySchema),
  async (c) => {
    const caller = callerPartner(c);
    if ('response' in caller) return caller.response;
    const { id } = c.req.valid('param');
    if (!(await getSource(caller.partnerId, id))) {
      return c.json({ error: 'Ticket import source not found', code: 'TICKET_IMPORT_SOURCE_NOT_FOUND' }, 404);
    }
    const page = await listCreatedContacts(id, c.req.valid('query'));
    return c.json({ data: page.contacts, next: page.next });
  },
);

ticketImportCreatedContactRoutes.post(
  '/sources/:id/created-contacts/remove',
  ...writeGate,
  zValidator('param', idParamSchema),
  async (c) => {
    const caller = callerPartner(c);
    if ('response' in caller) return caller.response;
    const { auth, partnerId } = caller;
    const { id } = c.req.valid('param');
    try {
      // The source lock serializes with a run's start (startRun locks it too),
      // so no run creates or links a contact while the set is removed.
      await lockSource(partnerId, id);
      const active = await activeRunOf(id);
      if (active) throw runActive(active);
      // A human removes customer data: the destination provenance of a technician.
      const result = await removeCreatedContacts(id, { userId: auth.user?.id ?? null, destinationSource: 'technician' });
      for (const contact of result.removed) {
        writeContactAudit(c as never, {
          orgId: contact.orgId,
          action: 'contact.delete',
          contactId: contact.contactId,
          contactName: contact.name,
          details: { isPrimary: contact.isPrimary, via: 'ticket_import.created_contacts_remove', sourceId: id },
        });
      }
      writeRouteAudit(c as never, {
        orgId: null,
        action: 'ticket_import.created_contacts_removed',
        resourceType: 'ticket_import_source',
        resourceId: id,
        details: { partnerId, removed: result.removed.length, skipped: result.skipped, skippedBy: result.skippedBy, remaining: result.remaining },
      });
      return c.json({
        data: { removed: result.removed.length, skipped: result.skipped, skippedBy: result.skippedBy, remaining: result.remaining },
      });
    } catch (error) {
      return importErrorResponse(c, error);
    }
  },
);
