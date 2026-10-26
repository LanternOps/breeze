import type { AuthContext, RequestLike } from './auditEvents';
import { writeAuditEvent, writeRouteAudit } from './auditEvents';

type SensitiveReadAuditInput = {
  action:
    | 'file.download'
    | 'contract.document.download'
    | 'billing.billables.download'
    | 'report.run.download';
  orgId: string | null;
  /** #3198 W01: the owning partner of a partner-owned resource (orgId null). */
  partnerId?: string | null;
  resourceType:
    | 'device_file'
    | 'contract_document'
    | 'billing_export'
    | 'report_run';
  resourceId: string;
  format: string;
  rowCount: number;
  byteCount: number;
};

export function auditSensitiveRead(
  c: AuthContext,
  input: SensitiveReadAuditInput,
): void {
  try {
    writeRouteAudit(c, {
      action: input.action,
      orgId: input.orgId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      details: {
        format: input.format,
        rowCount: input.rowCount,
        byteCount: input.byteCount,
        ...(input.partnerId ? { partnerId: input.partnerId } : {}),
      },
    });
  } catch (err) {
    // An audit write must never turn an authorized, completed retrieval into a
    // failure response. `writeAuditEventAsync` is NOT an `async` function, so
    // anything that throws before control reaches the retry-backed
    // `createAuditLogAsync` (payload sanitizing, trusted-client-IP resolution,
    // header access) propagates SYNCHRONOUSLY out of `writeRouteAudit` — and
    // the file-browser and contract-PDF handlers call this from inside a
    // try/catch that maps any throw to an error response, so the caller would
    // otherwise serve a 502 for a download whose bytes were already prepared.
    // Loud, never silent: the delivery failure is reported, the read is not.
    console.error('[audit] sensitive-read audit failed:', err);
  }
}

/**
 * The same sensitive-read record for a CUSTOMER PORTAL download (#9075 W3a):
 * the portal session has no staff `auth`, so writeRouteAudit would file the
 * read as the anonymous actor. The portal user is named instead (actorType
 * 'user' with the portal_users id, as routes/portal/assets.ts audits) and the
 * details mark `principal: 'portal_user'` so a reader never resolves the id
 * against staff users. Same never-throw contract as auditSensitiveRead.
 */
export function auditPortalSensitiveRead(
  c: RequestLike,
  portalUser: { id: string; email: string },
  input: SensitiveReadAuditInput,
): void {
  try {
    writeAuditEvent(c, {
      orgId: input.orgId,
      partnerId: input.partnerId ?? null,
      actorType: 'user',
      actorId: portalUser.id,
      actorEmail: portalUser.email,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      details: {
        format: input.format,
        rowCount: input.rowCount,
        byteCount: input.byteCount,
        principal: 'portal_user',
      },
    });
  } catch (err) {
    console.error('[audit] sensitive-read audit failed:', err);
  }
}
