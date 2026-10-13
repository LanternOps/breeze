import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { devices } from '../db/schema';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

describe('devices PAM reconciliation reset capability', () => {
  it('includes the scalar protocol capability in tenant exports', () => {
    expect(getTableColumns(devices).pamReconciliationResetProtocolVersion.name)
      .toBe('pam_reconciliation_reset_protocol_version');
    expect(getTenantExportPolicyRegistry().devices?.columns.pam_reconciliation_reset_protocol_version?.decision)
      .toBe('include');
  });
});
