import type { Context } from 'hono';
import { z } from 'zod';
import type { AuthContext } from '../../middleware/auth';
import { MigrationWindowError } from '../../services/migrationWindows';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE, canManagePartnerWidePolicies } from '../../services/partnerWideAccess';
import { TicketImportError } from '../../services/ticketImport/importErrors';
import {
  SourceAuthError,
  SourceHttpError,
  SourceResponseTooLargeError,
  SourceUnavailableError,
} from '../../services/ticketImport/sourceFetch';
import { SsrfBlockedError } from '../../services/urlSafety';

/**
 * Shared pieces of the /ticket-imports routes (#8313 W4; spec 2026-10-19
 * §5.7). Every route is partner scope, a partner-wide admin
 * (canManagePartnerWidePolicies), and every write also needs MFA. Creating
 * and editing a source and its mappings is further owner-only: the caller
 * must own the source's service principal.
 */

export const idParamSchema = z.object({ id: z.string().guid() });
export const runIdParamSchema = z.object({ runId: z.string().guid() });

/** The caller's partner, or the response refusing the request. */
export function callerPartner(c: Context): { auth: AuthContext; partnerId: string } | { response: Response } {
  const auth = c.var.auth as AuthContext;
  if (auth.scope !== 'partner' || !auth.partnerId) {
    return { response: c.json({ error: 'Partner context required' }, 403) };
  }
  if (!canManagePartnerWidePolicies(auth)) {
    return { response: c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403) };
  }
  return { auth, partnerId: auth.partnerId };
}

/** A refusal as `{ error, code, details? }` with its status; anything else is rethrown. */
export function importErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof TicketImportError || error instanceof MigrationWindowError) {
    return c.json(
      { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) },
      error.status,
    );
  }
  throw error;
}

/**
 * A module call made from a route (connect, catalog) that failed, as the
 * caller should see it. Never echoes the source's answer body.
 */
export function sourceCallError(error: unknown): TicketImportError {
  if (error instanceof SsrfBlockedError) {
    return new TicketImportError('TICKET_IMPORT_INVALID_URL', 'The source URL is not allowed', 400);
  }
  if (error instanceof SourceAuthError || (error instanceof SourceHttpError && error.status === 403)) {
    return new TicketImportError('TICKET_IMPORT_INVALID_CREDENTIALS', 'The source refused the credentials', 400, {
      status: error.status,
    });
  }
  if (error instanceof SourceHttpError) {
    return new TicketImportError('TICKET_IMPORT_SOURCE_UNREACHABLE', 'The source answered with an error', 502, { status: error.status });
  }
  if (error instanceof SourceUnavailableError || error instanceof SourceResponseTooLargeError) {
    return new TicketImportError('TICKET_IMPORT_SOURCE_UNREACHABLE', 'The source could not be reached', 502);
  }
  return new TicketImportError('TICKET_IMPORT_SOURCE_UNREACHABLE', 'The source could not be checked', 502);
}
