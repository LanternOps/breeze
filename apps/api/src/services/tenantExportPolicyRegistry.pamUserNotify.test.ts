import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { devices } from '../db/schema';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';
import { INSTALL_BOUNDARY_RESET_COLUMNS } from './deviceInstallBoundary/handlers/deviceRow';

// #8928 — devices.pam_user_notify_protocol_version is a scalar capability
// integer on an org-cascade table: exported (not excludedOpen), and reset at
// an install boundary like every other *ProtocolVersion column.
describe('devices PAM user-notify capability', () => {
  it('is a scalar column included in tenant exports', () => {
    expect(getTableColumns(devices).pamUserNotifyProtocolVersion.name)
      .toBe('pam_user_notify_protocol_version');
    expect(getTenantExportPolicyRegistry().devices?.columns.pam_user_notify_protocol_version?.decision)
      .toBe('include');
  });

  it('resets to 0 at an install boundary', () => {
    expect(INSTALL_BOUNDARY_RESET_COLUMNS.pamUserNotifyProtocolVersion).toBe(0);
  });
});
