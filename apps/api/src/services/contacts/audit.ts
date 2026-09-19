/**
 * Audit trail for contact writes (issue #3258).
 *
 * WHY THIS IS A SHARED HELPER, mirroring `services/orgImport/audit.ts`: neither
 * `commitContactImport` nor the CRUD service has a Hono context, so neither can
 * attribute a write to an actor, IP, or user agent. The audit loop therefore
 * lives at the route — and a second caller that forgets it (the `add_contact`
 * AI tool, a future PSA sync) writes contact PII with no trail at all. Keeping
 * the event shapes here means every caller emits the identical trail.
 *
 * `contactCreateAuditEvent` below is the actual guarantee behind that last
 * sentence for CREATE specifically: it is the ONE place that turns a created
 * `ContactRecord` into `{action, resourceType, resourceId, resourceName,
 * details}`. Both callers that write a contact and then have to audit it —
 * the `/organizations/:id/contacts` route (via `writeContactAudit`, which has
 * a Hono context) and the `add_contact` AI tool (via `writeAuditEvent`
 * directly, which has none) — build their event off this function instead of
 * re-deriving `{isPrimary, roles}` by hand, so the two payloads cannot drift
 * (found in review: they already had, once).
 */

import { writeRouteAudit, type AuthContext as AuditRouteContext } from '../auditEvents';
import type { ContactImportSummary } from './types';
import type { ContactRecord } from './crud';

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

/** The `{action, resourceType, resourceId, resourceName, details}` shape every CREATE audit event shares. */
export interface ContactCreateAuditEvent {
  action: 'contact.create';
  resourceType: 'contact';
  resourceId: string;
  /** Nullable, like the column: an email-only contact has no name. */
  resourceName?: string;
  details: { isPrimary: boolean; roles: string[] };
}

/**
 * Build the one audit event a contact CREATE emits, from the row `createContact`
 * returned. Pure — no I/O, no Hono context — so both write paths (the route's
 * `writeContactAudit`, the AI tool's direct `writeAuditEvent`) can adapt this
 * same shape to their own writer instead of re-deriving `details` themselves.
 */
export function contactCreateAuditEvent(
  contact: Pick<ContactRecord, 'id' | 'name' | 'isPrimary' | 'roles'>,
): ContactCreateAuditEvent {
  return {
    action: 'contact.create',
    resourceType: 'contact',
    resourceId: contact.id,
    resourceName: contact.name ?? undefined,
    details: { isPrimary: contact.isPrimary, roles: contact.roles },
  };
}
