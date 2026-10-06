import { writeRouteAudit, type AuthContext as AuditAuthContext } from './auditEvents';

export type BillingDocumentType = 'quote' | 'invoice' | 'contract';

/**
 * Audit a write to a quote, invoice or contract under the document's own org.
 *
 * These routes are partner-scoped and take the org from the request body (a
 * create) or from a row that no longer exists afterwards (a hard delete), so
 * the generic request-derived fallback in index.ts cannot attribute them to
 * the customer org. Record the identifiers only — never the request payload.
 */
export function auditBillingDocument(
  c: unknown,
  type: BillingDocumentType,
  verb: string,
  doc: { id: string; orgId: string; name?: string | null },
  details?: Record<string, unknown>,
): void {
  writeRouteAudit(c as AuditAuthContext, {
    orgId: doc.orgId,
    action: `${type}.${verb}`,
    resourceType: type,
    resourceId: doc.id,
    resourceName: doc.name ?? undefined,
    ...(details ? { details } : {}),
  });
}
