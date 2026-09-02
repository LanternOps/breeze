/**
 * Audit trail for contact writes (issue #3258).
 *
 * WHY THIS IS A SHARED HELPER, mirroring `services/orgImport/audit.ts`: neither
 * `commitContactImport` nor the CRUD service has a Hono context, so neither can
 * attribute a write to an actor, IP, or user agent. The audit loop therefore
 * lives at the route — and a second caller that forgets it (the `add_contact`
 * AI tool, a future PSA sync) writes contact PII with no trail at all. Keeping
 * the event shapes here means every caller emits the identical trail.
 */

import { writeRouteAudit, type AuthContext as AuditRouteContext } from '../auditEvents';
import type { ContactImportSummary } from './types';

export type ContactAuditAction = 'contact.create' | 'contact.update' | 'contact.delete';

export interface ContactAuditInput {
  orgId: string;
  action: ContactAuditAction;
  contactId: string;
  /** Nullable, like the column: an email-only contact has no name. */
  contactName?: string | null;
  details?: Record<string, unknown>;
}

/** One event for a single create, update, or delete. */
export function writeContactAudit(c: AuditRouteContext, event: ContactAuditInput): void {
  writeRouteAudit(c, {
    orgId: event.orgId,
    action: event.action,
    resourceType: 'contact',
    resourceId: event.contactId,
    resourceName: event.contactName ?? undefined,
    ...(event.details ? { details: event.details } : {}),
  });
}

/**
 * One event per contact an import created or updated.
 *
 * Skipped rows are deliberately not audited: they are the rows the commit left
 * untouched, and one event per unchanged row would bury the real writes on
 * every re-import of an unchanged file.
 */
export function writeContactImportAudits(
  c: AuditRouteContext,
  { summary, source }: { summary: ContactImportSummary; source: string },
): void {
  for (const entry of summary.imported) {
    writeContactAudit(c, {
      orgId: entry.organizationId,
      action: 'contact.create',
      contactId: entry.contactId,
      contactName: entry.name,
      details: { source, createdLink: entry.createdLink },
    });
  }
  for (const entry of summary.updated) {
    writeContactAudit(c, {
      orgId: entry.organizationId,
      action: 'contact.update',
      contactId: entry.contactId,
      contactName: entry.name,
      details: { source, createdLink: entry.createdLink },
    });
  }
}
