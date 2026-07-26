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
}
