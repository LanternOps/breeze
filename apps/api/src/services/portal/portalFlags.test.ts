import { describe, it, expect } from 'vitest';
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
  it('is a no-op seam in W03 (resolves without throwing)', async () => {
    await expect(onPortalFlagsChanged({
      orgId: 'org-1',
      createdBy: 'user-1',
      requested: { enableReports: true },
      current: {
        enableDashboard: false,
        enableSecurity: false,
        enableBackups: false,
        enableReports: true,
        enableSupportUsage: false
      }
    })).resolves.toBeUndefined();
  });
});
