/**
 * Portal registration W5 (#11382): Entra tenant domain check. A domain is
 * verified for an org when it is a non-initial verified domain of the Entra
 * tenant the org PROVED (portalEntraTenantProof), read live through the org's
 * Microsoft 365 connection. Neither the domain string nor any tenant hint is
 * ever evidence (inv. 2): only the proven tenant and Graph's answer count.
 */
import { findProvenEntraTenantForOrg } from '../../portalEntraTenantProof';
import { readM365OrganizationForVerification } from '../../m365ControlPlane/readActionService';
import type { DomainCheckResult, DomainCheckTarget, DomainVerificationChecker } from '../types';

export const entraTenantChecker: DomainVerificationChecker = {
  method: 'entra_tenant',
  async check(target: DomainCheckTarget): Promise<DomainCheckResult> {
    try {
      const proven = await findProvenEntraTenantForOrg(target.orgId);
      if (!proven) return { status: 'fail', reason: 'tenant_not_proven' };

      const read = await readM365OrganizationForVerification(target.orgId, proven.tenantId);
      if (!read.ok) {
        if (read.code !== 'no_connection') {
          // A permanent Graph/schema problem must not look like a silent outage.
          console.warn(`[portalDomainVerification] entra organization read for org ${target.orgId} returned ${read.code}`);
        }
        switch (read.code) {
          case 'no_connection':
            return { status: 'fail', reason: 'connection_missing' };
          case 'timeout':
            return { status: 'unavailable', reason: 'timeout' };
          default:
            return { status: 'unavailable', reason: 'graph_unavailable' };
        }
      }

      if (read.tenantId.toLowerCase() !== proven.tenantId.toLowerCase()) {
        console.error(
          `[portalDomainVerification] entra tenant mismatch for org ${target.orgId}: proven ${proven.tenantId}, graph returned ${read.tenantId}`,
        );
        return { status: 'unavailable', reason: 'graph_tenant_mismatch' };
      }

      const domain = target.domain.toLowerCase();
      const listed = read.verifiedDomains.some(
        (d) => d.name === domain && d.isInitial !== true && !d.name.endsWith('.onmicrosoft.com'),
      );
      if (!listed) return { status: 'fail', reason: 'not_in_directory' };
      return {
        status: 'pass',
        evidence: { via: 'entra_tenant', tenantId: proven.tenantId, connectionId: read.connectionId },
      };
    } catch (err) {
      console.error(
        `[portalDomainVerification] entra check failed for org ${target.orgId}:`,
        err instanceof Error ? err.message : 'unknown error',
      );
      return { status: 'unavailable', reason: 'graph_unavailable' };
    }
  },
};
