import { beforeEach, describe, expect, it, vi } from 'vitest';

const { provisionMock, captureExceptionMock } = vi.hoisted(() => ({
  provisionMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

vi.mock('./reportsSelfService', () => ({
  provisionPortalReportDefinitions: provisionMock,
}));

vi.mock('../sentry', () => ({
  captureException: captureExceptionMock,
}));
import {
  PORTAL_PERMISSION_FLAG_KEYS,
  PORTAL_SENSITIVE_FLAG_KEYS,
  PORTAL_VISIBILITY_FLAG_KEYS,
  onPortalFlagsChanged
} from './portalFlags';

describe('PORTAL_VISIBILITY_FLAG_KEYS', () => {
  it('lists exactly the fourteen visibility flags', () => {
    expect(PORTAL_VISIBILITY_FLAG_KEYS).toEqual([
      'enableDashboard',
      'enableSecurity',
      'enableBackups',
      'enableReports',
      'enableSupportUsage',
      'enableService',
      'enableDocuments',
      'enableLifecycle',
      'enableHardwareHealth',
      'enableHardwareInventory',
      'enablePerformanceMetrics',
      'enableSoftwareInventory',
      'enableNetworkVisibility',
      'enableEdrVisibility'
    ]);
  });
});

describe('PORTAL_SENSITIVE_FLAG_KEYS', () => {
  it('lists the flags that stay outside "Enable all"', () => {
    expect(PORTAL_SENSITIVE_FLAG_KEYS).toEqual(['enableNetworkAlerts', 'enableHourBlock', 'enablePatchDetail', 'enableVulnerabilityDetail']);
  });

  it('keeps the billing-sensitive Support hours flag out of "Enable all"', () => {
    // enableHourBlock (block hours W04) exposes a prepaid-hours balance and has
    // its own fail-closed gate: switched on one org at a time.
    expect(PORTAL_VISIBILITY_FLAG_KEYS).not.toContain('enableHourBlock');
  });

  it('keeps the sensitive patch detail flag out of "Enable all"', () => {
    // enablePatchDetail (portal visibility W05) shows per-host missing patches.
    expect(PORTAL_VISIBILITY_FLAG_KEYS).not.toContain('enablePatchDetail');
  });

  it('keeps managed endpoint protection IN "Enable all" (strict but not sensitive, EDR #8164)', () => {
    expect(PORTAL_VISIBILITY_FLAG_KEYS).toContain('enableEdrVisibility');
    expect(PORTAL_SENSITIVE_FLAG_KEYS).not.toContain('enableEdrVisibility');
  });

  it('keeps the sensitive vulnerability detail flag out of "Enable all"', () => {
    // enableVulnerabilityDetail (portal visibility W06) shows per-host CVE findings.
    expect(PORTAL_VISIBILITY_FLAG_KEYS).not.toContain('enableVulnerabilityDetail');
  });

  it('never overlaps the flags that "Enable all" turns on', () => {
    for (const key of PORTAL_SENSITIVE_FLAG_KEYS) {
      expect(PORTAL_VISIBILITY_FLAG_KEYS).not.toContain(key);
    }
  });
});

describe('PORTAL_PERMISSION_FLAG_KEYS (Trust Center W3d)', () => {
  it('lists the flags that grant portal users a write permission', () => {
    expect(PORTAL_PERMISSION_FLAG_KEYS).toEqual(['enableTrustPageEditing']);
  });

  it('keeps every permission flag out of "Enable all" and out of the sensitive list', () => {
    for (const key of PORTAL_PERMISSION_FLAG_KEYS) {
      expect(PORTAL_VISIBILITY_FLAG_KEYS as readonly string[]).not.toContain(key);
      expect(PORTAL_SENSITIVE_FLAG_KEYS as readonly string[]).not.toContain(key);
    }
  });
});

describe('onPortalFlagsChanged', () => {
  const current = {
    enableDashboard: false,
    enableSecurity: false,
    enableBackups: false,
    enableReports: false,
    enableSupportUsage: false,
    enableService: false,
    enableDocuments: false,
    enableLifecycle: false,
    enableHardwareHealth: false,
    enableHardwareInventory: false,
    enablePerformanceMetrics: false,
    enableSoftwareInventory: false,
    enableNetworkVisibility: false,
    enableEdrVisibility: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    provisionMock.mockResolvedValue(undefined);
  });

  it('provisions definitions when reports are requested on', async () => {
    await onPortalFlagsChanged({
      orgId: 'org-1',
      createdBy: 'user-1',
      requested: { enableReports: true },
      current,
    });

    expect(provisionMock).toHaveBeenCalledWith({
      orgId: 'org-1',
      createdBy: 'user-1',
    });
  });

  it('provisions again on a retry when reports are already enabled', async () => {
    await onPortalFlagsChanged({
      orgId: 'org-1',
      createdBy: 'user-1',
      requested: { enableReports: true },
      current: { ...current, enableReports: true },
    });

    expect(provisionMock).toHaveBeenCalledOnce();
  });

  it('does not provision unless enableReports is explicitly requested true', async () => {
    await onPortalFlagsChanged({
      orgId: 'org-1',
      createdBy: 'user-1',
      requested: { enableReports: false, enableDashboard: true },
      current: { ...current, enableReports: true },
    });

    expect(provisionMock).not.toHaveBeenCalled();
  });

  it('logs and reports provisioning failures without rejecting the settings update', async () => {
    const error = new Error('database unavailable');
    provisionMock.mockRejectedValue(error);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(onPortalFlagsChanged({
      orgId: 'org-1',
      createdBy: 'user-1',
      requested: { enableReports: true },
      current,
    })).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      '[portalFlags] Failed to provision portal report definitions',
      { orgId: 'org-1', error },
    );
    expect(captureExceptionMock).toHaveBeenCalledWith(error, undefined, {
      org_id: 'org-1',
    });
    consoleError.mockRestore();
  });
});
