import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requirePermission, requireScope, withAuthDbAccessContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { TicketImportError } from '../../services/ticketImport/importErrors';
import { getTicketImportModule } from '../../services/ticketImport/moduleRegistry';
import { openSourceCredentials } from '../../services/ticketImport/sourceCredentials';
import { buildSourceHandle } from '../../services/ticketImport/sourceHandle';
import { readSourceForUse } from '../../services/ticketImport/sourceStore';
import { callerPartner, idParamSchema, importErrorResponse, sourceCallError } from './shared';

/**
 * Source people by key, read live (#8313 W6; spec 2026-10-19 §5.10): the
 * report's `owner_unmatched` rows hold the source user key only, and "the
 * wizard shows the name by reading the source's user list live". The route
 * resolves at most SOURCE_USER_KEYS_MAX keys through the source's module and
 * its SSRF-guarded client. Nothing is stored or audited, and names are never
 * logged.
 *
 * Who: the report's readers, a partner-wide admin of the caller's partner
 * (`callerPartner`). A POST only to carry the key list; it changes nothing.
 * In SELF_MANAGED_DB_CONTEXT_ROUTES: the source call runs with no request
 * transaction held, the source read in its own short context.
 */
export const ticketImportSourceUserRoutes = new Hono();

export const SOURCE_USER_KEYS_MAX = 200;

const readGate = [
  requireScope('partner'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
] as const;

const resolveSchema = z.object({
  keys: z.array(z.string().min(1).max(64)).min(1).max(SOURCE_USER_KEYS_MAX),
}).strict();

ticketImportSourceUserRoutes.post(
  '/sources/:id/source-users/resolve',
  ...readGate,
  zValidator('param', idParamSchema),
  zValidator('json', resolveSchema),
  async (c) => {
    const caller = callerPartner(c);
    if ('response' in caller) return caller.response;
    const { auth, partnerId } = caller;
    const { id } = c.req.valid('param');
    const keys = [...new Set(c.req.valid('json').keys)];
    try {
      const current = await withAuthDbAccessContext(auth, () => readSourceForUse(partnerId, id));
      if (!current) throw new TicketImportError('TICKET_IMPORT_SOURCE_NOT_FOUND', 'Ticket import source not found', 404);
      if (!current.credentialsEncrypted) {
        throw new TicketImportError('TICKET_IMPORT_SOURCE_REVOKED', 'The source is revoked; reconnect it with new credentials first', 409);
      }
      const module = getTicketImportModule(current.view.module);
      const people: Record<string, { name: string | null; email: string | null } | null> = Object.fromEntries(keys.map((k) => [k, null]));
      // A module that cannot name people answers every key as unknown; the wizard shows the key.
      if (!module?.resolvePeople) return c.json({ data: people });
      const handle = buildSourceHandle({
        sourceId: id,
        baseUrl: current.view.baseUrl,
        credentials: openSourceCredentials(id, current.credentialsEncrypted),
        options: current.view.options,
      });
      let resolved;
      try {
        resolved = await module.resolvePeople(handle, keys);
      } catch (error) {
        throw sourceCallError(error);
      }
      for (const key of keys) people[key] = resolved.get(key) ?? null;
      return c.json({ data: people });
    } catch (error) {
      return importErrorResponse(c, error);
    }
  },
);
