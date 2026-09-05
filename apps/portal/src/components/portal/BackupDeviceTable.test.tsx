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
  });

  it('totals the ledger at its foot, in the register’s small caps', () => {
    render(<BackupDeviceTable devices={[configuredDevice]} total={125} />);

    const foot = screen.getByTestId('portal-backup-device-count');
    expect(foot.textContent).toContain('Showing 1 of 125 devices');
    // A ledger totals itself below the rows, like Devices and Security do.
    const table = screen.getByTestId('portal-backup-device-table');
    expect(table.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(foot.className).toContain('border-t');
    expect(foot.className).toContain('uppercase');
    expect(foot.className).toContain('tracking-[0.08em]');

    // Section titles are the 1.125rem Title, not a second display size.
    expect(
      screen.getByRole('heading', { name: 'Device backup readiness' }).className
    ).toContain('text-lg');
  });

  it('reads label over value on a phone card, not one muted run-on', () => {
    render(<BackupDeviceTable devices={[configuredDevice]} />);

    const labels = Array.from(
      screen.getByTestId('portal-backup-device-d-1').querySelectorAll('.sm\\:hidden')
    );
    expect(labels.map((el) => el.textContent)).toEqual([
      'Last backup',
      'Last restore test',
      'Needs attention',
      'Recovery readiness',
    ]);
    for (const label of labels) {
      // The Label style: 12px semibold small-caps in quiet ink, on its own line
      // above the value (apps/portal/DESIGN.md, Typography → Label).
      expect(label.className).toContain('block');
      expect(label.className).toContain('text-xs');
      expect(label.className).toContain('font-semibold');
      expect(label.className).toContain('uppercase');
      expect(label.className).toContain('tracking-[0.08em]');
      expect(label.className).toContain('text-muted-foreground');
    }
  });

  it('stamps device times in the org’s own zone and names it', () => {
    render(<BackupDeviceTable devices={[configuredDevice]} timezone="America/Denver" />);

    const row = screen.getByTestId('portal-backup-device-d-1');
    expect(row.textContent).toContain('Sep 2, 2026, 04:00 AM MDT');
    expect(row.textContent).toContain('Sep 1, 2026, 02:00 AM MDT');
  });

  it('says what the customer should do instead of printing the backend error', () => {
    render(<BackupDeviceTable devices={[]} error="ECONNREFUSED 10.0.0.4:5432" />);

    const notice = screen.getByRole('alert');
    expect(notice.textContent).toBe(
      "We couldn't load your backup devices just now. Your IT team can help."
    );
    expect(notice.textContent).not.toContain('ECONNREFUSED');
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
