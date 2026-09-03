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
  it('renders configured device backup details under plain-language headers', () => {
    render(<BackupDeviceTable devices={[configuredDevice]} total={125} />);

    expect(
      Array.from(
        screen.getByTestId('portal-backup-device-table').querySelectorAll('th')
      ).map((th) => th.textContent?.trim())
    ).toEqual([
      'Device',
      'Last backup',
      'Last restore test',
      'Needs attention',
      'Recovery readiness',
    ]);

    const row = screen.getByTestId('portal-backup-device-d-1');
    expect(row.textContent).toContain('File Server');
    expect(row.textContent).toContain('Sep 2, 2026');
    expect(row.textContent).not.toContain('2026-09-02T10:00:00Z');
    expect(row.textContent).toContain('None');
    expect(row.textContent).toContain('92');
    expect(screen.getByTestId('portal-backup-device-count').textContent).toContain(
      'Showing 1 of 125 devices'
    );
  });

  it('maps the restore-test status to a tone and a plain word', () => {
    render(
      <BackupDeviceTable
        devices={[
          configuredDevice,
          {
            ...configuredDevice,
            id: 'd-2',
            lastTestRestore: { status: 'failed', completedAt: '2026-09-01T08:00:00Z', restoreTimeSeconds: null },
          },
          {
            ...configuredDevice,
            id: 'd-3',
            lastTestRestore: { status: 'in_progress', completedAt: null, restoreTimeSeconds: null },
          },
        ]}
      />
    );

    const passed = screen.getByTestId('portal-backup-device-d-1');
    expect(passed.textContent).toContain('Passed');
    expect(passed.textContent).not.toContain('passed —');
    expect(passed.querySelector('.text-success-on-tint')).not.toBeNull();

    const failed = screen.getByTestId('portal-backup-device-d-2');
    expect(failed.textContent).toContain('Failed');
    expect(failed.querySelector('.text-destructive-on-tint')).not.toBeNull();

    const other = screen.getByTestId('portal-backup-device-d-3');
    expect(other.textContent).toContain('In progress');
    expect(other.querySelector('.text-muted-foreground')).not.toBeNull();
    expect(other.querySelector('.text-success-on-tint')).toBeNull();
    expect(other.querySelector('.text-destructive-on-tint')).toBeNull();
  });

  it('marks degraded restore points and names open breaches without acronyms', () => {
    render(
      <BackupDeviceTable
        devices={[
          {
            ...configuredDevice,
            id: 'd-2',
            lastRestorePointDegraded: true,
            openBreaches: ['rpo_breach', 'rto_breach', 'missed_backup'],
          },
        ]}
      />
    );

    const row = screen.getByTestId('portal-backup-device-d-2');
    expect(row.textContent).toContain('Sep 2, 2026');
    expect(row.textContent).toContain('(degraded)');
    expect(row.textContent).toContain('Backup behind schedule');
    expect(row.textContent).toContain('Restore slower than promised');
    expect(row.textContent).toContain('Backup missed');
    expect(row.textContent).not.toContain('rpo_breach');
    expect(row.textContent).not.toContain('rto_breach');
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
      'No backup has run for this device yet'
    );
  });

  it('renders an honest empty state', () => {
    render(<BackupDeviceTable devices={[]} />);

    expect(screen.getByTestId('portal-backup-device-empty').textContent).toContain(
      'No backup devices are available'
    );
  });
});
