/**
 * Audit trail for an org-import commit.
 *
 * WHY THIS IS A SHARED HELPER (#3246): the org/site/link audit events are NOT
 * written by `commitOrgImport` — the seam runs its tenant-creating writes in a
 * SYSTEM db context and has no Hono context, so it cannot attribute anything to
 * an actor, IP, or user agent. The audit loop therefore lives in the ROUTE, and
 * every new route that commits an import must write it or the import silently
 * creates organizations with NO audit trail.
 *
 * That is exactly the trap a second import route walks into, so the loop that
 * used to be inline in `routes/orgs.ts` now lives here and both callers share
 * it. Anything that calls `commitOrgImport` must call this with the resulting
 * summary.
 */

import { writeRouteAudit, type AuthContext as AuditRouteContext } from '../auditEvents';
import type { ImportRow, OrgImportSummary } from './types';

/**
 * Mirrors `DEFAULT_IMPORT_SYSTEM` in ./index, duplicated deliberately.
 *
 * This module must not import the pipeline barrel: route test suites mock
 * '../services/orgImport' wholesale, which would resolve the constant to
 * `undefined` and silently write `system: undefined` into the audit details.
 * `audit.test.ts` asserts the two stay equal, so the duplication cannot drift.
 */
export const AUDIT_FALLBACK_IMPORT_SYSTEM = 'csv';

/** The per-row identity needed for the external-link audit event. */
export type AuditSourceRow = Pick<ImportRow, 'externalSystem' | 'externalId'>;

export interface OrgImportAuditOptions {
  summary: OrgImportSummary;
  /**
   * The rows as committed, indexed by `entry.index` — used only to recover the
   * link identity (`externalSystem` / `externalId`) for link audit events.
   */
  rows: ReadonlyArray<AuditSourceRow | undefined>;
  partnerId: string;
  /** Provenance tag in `details.source`, e.g. 'org_import' or 'psa_import'. */
  source: string;
}

/**
 * Emit one audit event per organization, site, link, reactivation, and update
 * produced by a commit. Fire-and-forget, like `writeRouteAudit` itself — an
 * audit hiccup must never fail an import that already committed.
 */
export function writeOrgImportAudits(
  c: AuditRouteContext,
  { summary, rows, partnerId, source }: OrgImportAuditOptions
): void {
  for (const entry of summary.imported) {
    const sourceRow = rows[entry.index];

    if (entry.createdOrganization) {
      writeRouteAudit(c, {
        orgId: entry.organizationId,
        action: 'organization.create',
        resourceType: 'organization',
        resourceId: entry.organizationId,
        resourceName: entry.organization,
        details: { partnerId, source, slug: entry.slug }
      });
    }

    if (entry.createdLink) {
      writeRouteAudit(c, {
        orgId: entry.organizationId,
        action: 'organization.external_link.create',
        resourceType: 'organization_external_link',
        resourceId: entry.organizationId,
        resourceName: entry.organization,
        details: {
          system: sourceRow?.externalSystem ?? AUDIT_FALLBACK_IMPORT_SYSTEM,
          externalId: sourceRow?.externalId,
          source
        }
      });
    }

    if (entry.siteId) {
      writeRouteAudit(c, {
        orgId: entry.organizationId,
        action: 'site.create',
        resourceType: 'site',
        resourceId: entry.siteId,
        resourceName: entry.siteName ?? entry.organization,
        details: { source }
      });
    }
  }

  for (const entry of summary.updated) {
    const sourceRow = rows[entry.index];

    if (entry.reactivated) {
      writeRouteAudit(c, {
        orgId: entry.organizationId,
        action: 'organization.reactivate',
        resourceType: 'organization',
        resourceId: entry.organizationId,
        resourceName: entry.organization,
        details: { source }
      });
    }

    if (entry.createdLink) {
      writeRouteAudit(c, {
        orgId: entry.organizationId,
        action: 'organization.external_link.create',
        resourceType: 'organization_external_link',
        resourceId: entry.organizationId,
        resourceName: entry.organization,
        details: {
          system: sourceRow?.externalSystem ?? AUDIT_FALLBACK_IMPORT_SYSTEM,
          externalId: sourceRow?.externalId,
          source
        }
      });
    }

    if (entry.siteId && entry.createdSite) {
      writeRouteAudit(c, {
        orgId: entry.organizationId,
        action: 'site.create',
        resourceType: 'site',
        resourceId: entry.siteId,
        resourceName: entry.siteName ?? entry.organization,
        details: { source }
      });
    } else if (!entry.reactivated && !entry.createdLink) {
      writeRouteAudit(c, {
        orgId: entry.organizationId,
        action: 'organization.update',
        resourceType: 'organization',
        resourceId: entry.organizationId,
        resourceName: entry.organization,
        details: { source }
      });
    }
  }
}
