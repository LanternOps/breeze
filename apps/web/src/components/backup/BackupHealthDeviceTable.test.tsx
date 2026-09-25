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
