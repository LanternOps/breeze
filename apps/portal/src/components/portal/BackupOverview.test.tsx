// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BackupOverviewDto } from '@breeze/shared';
import { BackupOverview } from './BackupOverview';

const configuredOverview: BackupOverviewDto = {
  asOf: '2026-09-02T12:00:00Z',
  dataStatus: 'ok',
  protected: 3,
  unprotected: 1,
  total: 4,
  lastPassedVerification: {
    completedAt: '2026-09-01T09:30:00Z',
    verificationType: 'automated',
  },
  lastTestRestoreAt: '2026-08-30T14:15:00Z',
  lastTestRestoreStatus: 'failed',
  openRpoBreaches: 2,
  openRtoBreaches: 1,
  meanReadinessScore: 76,
  readinessScoredDevices: 3,
  readinessTotalDevices: 4,
};

describe('BackupOverview', () => {
  it('renders configured backup health and breach counts', () => {
    render(<BackupOverview overview={configuredOverview} />);

    expect(screen.getByTestId('portal-backup-overview').textContent).toContain('3 of 4');
    expect(
      screen.getByTestId('portal-backup-overview-last-verification').textContent
    ).toContain('Sep 1, 2026');
    expect(
      screen.getByTestId('portal-backup-overview-last-verification').textContent
    ).not.toContain('2026-09-01T09:30:00Z');
    expect(screen.getByTestId('portal-backup-overview-last-test-restore').textContent).toContain(
      'Aug 30, 2026'
    );
    expect(screen.getByTestId('portal-backup-overview-last-test-restore').textContent).toContain(
      'Last test restore'
    );
    expect(screen.getByTestId('portal-backup-overview-last-test-restore').textContent).toContain(
      'failed'
    );
    expect(screen.getByTestId('portal-backup-overview-as-of').textContent).toContain('Sep 2, 2026');
    expect(screen.getByTestId('portal-backup-overview-readiness').textContent).toContain('76');
    expect(screen.getByTestId('portal-backup-overview-readiness').textContent).toContain(
      'mean over 3 of 4 devices'
    );
    expect(screen.getByTestId('portal-backup-overview-rpo-breaches').textContent).toContain('2');
    expect(screen.getByTestId('portal-backup-overview-rto-breaches').textContent).toContain('1');
  });

  it('renders honest not-configured copy without inventing numeric values', () => {
    render(
      <BackupOverview
        overview={{
          ...configuredOverview,
          dataStatus: 'not_configured',
          protected: null,
          unprotected: null,
          total: null,
          lastPassedVerification: null,
          lastTestRestoreAt: null,
          lastTestRestoreStatus: null,
          openRpoBreaches: null,
          openRtoBreaches: null,
          meanReadinessScore: null,
          readinessScoredDevices: null,
          readinessTotalDevices: null,
        }}
      />
    );

    expect(screen.getByTestId('portal-backup-overview').textContent).toContain(
      'Backups are not configured'
    );
    expect(screen.getByTestId('portal-backup-overview-protected').textContent).toContain(
      'Not available'
    );
    expect(screen.getByTestId('portal-backup-overview-rpo-breaches').textContent).toContain(
      'Not available'
    );
    expect(screen.getByTestId('portal-backup-overview-rto-breaches').textContent).toContain(
      'Not available'
    );
  });

  it('distinguishes no-data and stale states', () => {
    const { rerender } = render(
      <BackupOverview overview={{ ...configuredOverview, dataStatus: 'no_data' }} />
    );
    expect(screen.getByTestId('portal-backup-overview-status').textContent).toContain(
      'No backup data is available yet'
    );

    rerender(<BackupOverview overview={{ ...configuredOverview, dataStatus: 'stale' }} />);
    expect(screen.getByTestId('portal-backup-overview-status').textContent).toContain(
      'Backup data may be out of date'
    );
  });
});
