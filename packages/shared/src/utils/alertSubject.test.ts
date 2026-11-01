import { describe, expect, it } from 'vitest';
import { formatAlertSubject } from './alertSubject';

describe('formatAlertSubject', () => {
  it('labels a workload and its customer without provider identifiers', () => {
    expect(formatAlertSubject({ ownerKind: 'backup_workload', ownerRef: 'workload-1', orgName: 'Example organization' }, {
      dataSources: ['m365_mail'], customerName: 'Example customer', providerLabel: 'Private provider',
    })).toMatchObject({ ownerKind: 'backup_workload', ownerLabel: 'Microsoft 365 mail backup', subjectName: 'Microsoft 365 mail backup · Example customer', owner: { kind: 'backup_workload', ref: 'workload-1' } });
  });
  it('reveals the provider only for an opted-in portal label', () => {
    const alert = { ownerKind: 'backup_workload' as const, orgName: 'Example organization' };
    const workload = { dataSources: ['gws_drive'], providerLabel: 'Example provider', portalShowProviderName: true };
    expect(formatAlertSubject(alert, workload, { portal: true }).subjectName).toBe('Google Drive backup (Example provider) · Example organization');
    expect(formatAlertSubject(alert, { ...workload, portalShowProviderName: false }, { portal: true }).subjectName).toBe('Google Drive backup · Example organization');
  });
  it('falls back safely when a workload has been deleted', () => {
    const text = formatAlertSubject({ ownerKind: 'backup_workload', orgName: 'Example organization' }).subjectName;
    expect(text).toBe('SaaS backup · Example organization');
    expect(text).not.toContain('null');
  });
  it('uses the owning site even with a provenance device', () => {
    expect(formatAlertSubject({ ownerKind: 'topology_site', topologySiteId: 'site-1', siteName: 'Branch', deviceName: 'origin' })).toMatchObject({ subjectName: 'Branch', owner: { kind: 'topology_site', ref: 'site-1' } });
  });
  it('preserves device names', () => {
    expect(formatAlertSubject({ deviceId: 'd1', deviceName: 'Server' })).toMatchObject({ subjectName: 'Server', ownerKind: 'device', owner: { kind: 'device', ref: 'd1' } });
  });
});
