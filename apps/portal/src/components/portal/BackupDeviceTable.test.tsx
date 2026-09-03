// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BackupDeviceRow } from '@breeze/shared';
import { BackupDeviceTable } from './BackupDeviceTable';

const configuredDevice: BackupDeviceRow = {
  id: 'd-1',
  name: 'File Server',
  configured: true,
  lastRestorePointAt: '2026-09-02T10:00:00Z',
  lastRestorePointDegraded: false,
  lastTestRestore: {
    status: 'passed',
    completedAt: '2026-09-01T08:00:00Z',
    restoreTimeSeconds: 180,
  },
  openBreaches: [],
  readinessScore: 92,
  estimatedRtoMinutes: 30,
  estimatedRpoMinutes: 60,
};

describe('BackupDeviceTable', () => {
  it('renders configured device backup details', () => {
    render(<BackupDeviceTable devices={[configuredDevice]} />);

    const row = screen.getByTestId('portal-backup-device-d-1');
    expect(row.textContent).toContain('File Server');
    expect(row.textContent).toContain('2026-09-02T10:00:00Z');
    expect(row.textContent).toContain('passed — 2026-09-01T08:00:00Z');
    expect(row.textContent).toContain('None');
    expect(row.textContent).toContain('92');
  });

  it('marks degraded restore points and lists open breaches', () => {
    render(
      <BackupDeviceTable
        devices={[
          {
            ...configuredDevice,
            id: 'd-2',
            lastRestorePointDegraded: true,
            openBreaches: ['RPO', 'RTO'],
          },
        ]}
      />
    );

    const row = screen.getByTestId('portal-backup-device-d-2');
    expect(row.textContent).toContain('2026-09-02T10:00:00Z (degraded)');
    expect(row.textContent).toContain('RPO, RTO');
  });

  it('shows a not-configured device instead of a blank row', () => {
    render(
      <BackupDeviceTable
        devices={[
          {
            id: 'd-3',
            name: 'Laptop',
            configured: false,
            lastRestorePointAt: null,
            lastRestorePointDegraded: false,
            lastTestRestore: null,
            openBreaches: [],
            readinessScore: null,
            estimatedRtoMinutes: null,
            estimatedRpoMinutes: null,
          },
        ]}
      />
    );

    expect(screen.getByTestId('portal-backup-device-d-3').textContent).toContain(
      'No backup is configured for this device'
    );
  });

  it('renders an honest empty state', () => {
    render(<BackupDeviceTable devices={[]} />);

    expect(screen.getByTestId('portal-backup-device-empty').textContent).toContain(
      'No backup devices are available'
    );
  });
});
