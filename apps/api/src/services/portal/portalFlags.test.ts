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
  PORTAL_VISIBILITY_FLAG_KEYS,
  onPortalFlagsChanged
} from './portalFlags';

describe('PORTAL_VISIBILITY_FLAG_KEYS', () => {
  it('lists exactly the five visibility flags', () => {
    expect(PORTAL_VISIBILITY_FLAG_KEYS).toEqual([
      'enableDashboard',
      'enableSecurity',
      'enableBackups',
      'enableReports',
      'enableSupportUsage'
    ]);
  });
});

describe('onPortalFlagsChanged', () => {
  const current = {
    enableDashboard: false,
    enableSecurity: false,
    enableBackups: false,
    enableReports: false,
    enableSupportUsage: false,
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
