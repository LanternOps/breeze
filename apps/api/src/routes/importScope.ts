/**
 * Shared partner resolution for the bulk-import routes (#3242, #3258).
 *
 * `POST /orgs/import*` and `POST /orgs/contacts/import*` answer the same
 * question — "which partner is this import for, and may this caller import into
 * it?". The org importer answered it inline; this is that code lifted out so
 * the contact importer (#3258) reuses it instead of growing a second copy. One
 * copy is enough: the 400/403 messages are part of the wire contract for both,
 * and two copies drift.
 *
 * Deliberately free of database and schema imports so either route's test suite
 * can import it without adding a mock.
 */

import type { AuthContext } from '../middleware/auth';

export type ImportPartnerResolution =
  | { partnerId: string }
  | { error: string; status: 400 | 403 };

/**
 * @param subject  Pluralised noun for the 400 copy, e.g. 'organizations'.
 *
 * Only SYSTEM scope may name a partner other than its own. Partner- and
 * organization-scoped callers are pinned to `auth.partnerId`: an organization
 * token carries a partnerId but has no authority over its siblings, so letting
 * a body field redirect the import would be a cross-tenant write attempt
 * answered with a 200.
 */
export function resolveImportPartnerId(
  auth: AuthContext,
  bodyPartnerId: string | undefined,
  subject: string,
): ImportPartnerResolution {
  if (auth.scope === 'system') {
    const partnerId = bodyPartnerId ?? auth.partnerId;
    if (!partnerId) {
      return { error: 'partnerId is required for system scope', status: 400 };
    }
    return { partnerId };
  }

  if (!auth.partnerId) {
    return { error: `Partner context required to import ${subject}`, status: 400 };
  }
  if (bodyPartnerId && bodyPartnerId !== auth.partnerId) {
    return { error: 'Access denied to this partner', status: 403 };
  }
  return { partnerId: auth.partnerId };
}
