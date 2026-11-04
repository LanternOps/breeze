import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BackupHealthRow } from '@breeze/shared';

import BackupHealthDeviceTable from './BackupHealthDeviceTable';

function makeRow(overrides: Partial<BackupHealthRow> = {}): BackupHealthRow {
  return {
    key: 'breeze:dev-1',
    source: 'breeze',
    providerKey: null,
    providerLabel: null,
    orgId: 'org-1',
    orgName: 'Acme',
    siteId: null,
    deviceId: 'dev-1',
    name: 'DESKTOP-1',
    computerName: 'DESKTOP-1',
    osType: 'workstation',
    accountType: 'endpoint',
    status: 'completed',
    health: 'healthy',
    recency: 'under_24h',
    covered: true,
    stale: false,
    lastSuccessAt: '2026-09-20T00:00:00.000Z',
    lastSessionAt: '2026-09-20T00:00:00.000Z',
    selectedBytes: 1024,
    usedBytes: 512,
    errorsCount: 0,
    dataSources: ['files'],
    history28d: [],
    agentOnline: true,
    ...overrides,
  };
}

describe('BackupHealthDeviceTable — Type column (sweep F3)', () => {
  it('translates the osType enum instead of printing the raw value', () => {
    render(<BackupHealthDeviceTable rows={[makeRow({ osType: 'workstation' })]} />);
    const row = screen.getByTestId('backup-health-row-breeze:dev-1');
    expect(row).toHaveTextContent('Workstation');
    expect(row).not.toHaveTextContent('workstation');
  });

  it('translates unknown osType too', () => {
    render(<BackupHealthDeviceTable rows={[makeRow({ key: 'breeze:dev-2', osType: 'unknown' })]} />);
    const row = screen.getByTestId('backup-health-row-breeze:dev-2');
    expect(row).toHaveTextContent('Unknown');
  });
});


describe('BackupHealthDeviceTable SaaS workloads', () => {
  it.each([
    ['m365', 'cove', 'm365_mail', 'Microsoft 365 mail'],
    ['m365', 'dropsuite', 'm365_onedrive', 'OneDrive'],
    ['m365', 'dropsuite', 'm365_sharepoint', 'SharePoint'],
    ['m365', 'dropsuite', 'm365_teams', 'Teams'],
    ['gws', 'dropsuite', 'gws_mail', 'Google Workspace mail'],
    ['gws', 'dropsuite', 'gws_drive', 'Google Drive'],
    ['gws', 'dropsuite', 'gws_shared_drive', 'Google shared drives'],
  ] as const)('renders %s %s %s as a SaaS workload without a device link', (accountType, providerKey, source, label) => {
    render(<BackupHealthDeviceTable rows={[makeRow({
      key: 'provider:saas', source: 'provider', providerKey, accountType,
      deviceId: 'legacy-device-link', name: 'Vendor raw name', osType: 'unknown',
      dataSources: [source], computerName: null,
    })]} />);
    expect(screen.getByTestId('backup-health-type-provider:saas')).toHaveTextContent('SaaS');
    expect(screen.getByTestId('backup-health-data-sources-provider:saas')).toHaveTextContent(label);
    expect(screen.getByTestId('backup-health-name-provider:saas')).toHaveTextContent(`${label} backup`);
    expect(screen.queryByTestId('backup-health-device-link-provider:saas')).toBeNull();
  });

  it('preserves navigation to linked endpoint devices', () => {
    render(<BackupHealthDeviceTable rows={[makeRow()]} />);
    expect(screen.getByTestId('backup-health-device-link-breeze:dev-1')).toHaveAttribute('href', '/devices/dev-1');
  });
});
