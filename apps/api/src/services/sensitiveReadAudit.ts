import type { AuthContext } from './auditEvents';
import { writeRouteAudit } from './auditEvents';

type SensitiveReadAuditInput = {
  action:
    | 'file.download'
    | 'contract.document.download'
    | 'billing.billables.download'
    | 'report.run.download';
  orgId: string | null;
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
