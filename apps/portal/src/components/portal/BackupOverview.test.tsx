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

const emptyOverview: BackupOverviewDto = {
  ...configuredOverview,
  dataStatus: 'no_data',
  protected: 0,
  unprotected: 0,
  total: 4,
  lastPassedVerification: null,
  lastTestRestoreAt: null,
  lastTestRestoreStatus: null,
  openRpoBreaches: null,
  openRtoBreaches: null,
  meanReadinessScore: null,
  readinessScoredDevices: null,
  readinessTotalDevices: null,
};

describe('BackupOverview', () => {
  it('renders configured backup health and breach counts in the reader’s words', () => {
    render(<BackupOverview overview={configuredOverview} hasBackupActivity />);

    const overview = screen.getByTestId('portal-backup-overview');
    expect(overview.textContent).toContain('3 of 4');
    expect(
      screen.getByTestId('portal-backup-overview-last-verification').textContent
    ).toContain('Sep 1, 2026');
    expect(
      screen.getByTestId('portal-backup-overview-last-verification').textContent
    ).not.toContain('2026-09-01T09:30:00Z');
    expect(screen.getByTestId('portal-backup-overview-last-test-restore').textContent).toContain(
      'Aug 30, 2026'
    );
    expect(screen.getByTestId('portal-backup-overview-as-of').textContent).toContain('Sep 2, 2026');
    expect(screen.getByTestId('portal-backup-overview-readiness').textContent).toContain('76');
    expect(screen.getByTestId('portal-backup-overview-rpo-breaches').textContent).toContain('2');
    expect(screen.getByTestId('portal-backup-overview-rto-breaches').textContent).toContain('1');

    // Nothing on this page explains itself with an acronym.
    expect(overview.textContent).toContain('Backups behind schedule');
    expect(overview.textContent).toContain('Restores slower than promised');
    expect(overview.textContent).toContain('Recovery readiness');
    expect(overview.textContent).toContain('Last restore test');
    expect(overview.textContent).not.toContain('RPO');
    expect(overview.textContent).not.toContain('RTO');
    expect(overview.textContent).not.toContain('Mean readiness');
  });

  it('gives the last restore test a tone and a plain word', () => {
    render(<BackupOverview overview={configuredOverview} hasBackupActivity />);

    const tile = screen.getByTestId('portal-backup-overview-last-test-restore');
    expect(tile.textContent).toContain('Failed');
    expect(tile.textContent).not.toContain('failed —');
    expect(tile.querySelector('.text-destructive-on-tint')).not.toBeNull();
  });

  it('never contradicts a ledger that holds backups', () => {
    // dataStatus 'no_data' keys on a passed VERIFICATION, not on backups: the
    // band used to sit above "Protected devices 3 of 4" and a real restore point.
    render(
      <BackupOverview
        overview={{ ...configuredOverview, dataStatus: 'no_data', lastPassedVerification: null }}
        hasBackupActivity
      />
    );

    expect(screen.queryByTestId('portal-backup-overview-status')).toBeNull();
    expect(
      screen.getByTestId('portal-backup-overview-last-verification').textContent
    ).toContain('No verification has run yet.');
  });

  it('bands the page only when nothing has been backed up', () => {
    render(<BackupOverview overview={emptyOverview} />);

    const band = screen.getByTestId('portal-backup-overview-status');
    expect(band.textContent).toContain('No backup data is available yet.');
    // A sentence is body copy: the small-caps label style is for labels only.
    expect(band.querySelector('.uppercase')).toBeNull();
    expect(band.className).not.toContain('uppercase');
  });

  it('distinguishes not-configured and stale states', () => {
    const { rerender } = render(
      <BackupOverview overview={{ ...emptyOverview, dataStatus: 'not_configured' }} />
    );
    expect(screen.getByTestId('portal-backup-overview-status').textContent).toContain(
      'Backups are not configured'
    );

    rerender(<BackupOverview overview={{ ...configuredOverview, dataStatus: 'stale' }} hasBackupActivity />);
    expect(screen.getByTestId('portal-backup-overview-status').textContent).toContain(
      'Backup data may be out of date'
    );
  });

  it('keeps dead-end values out of the money face', () => {
    render(
      <BackupOverview
        overview={{ ...emptyOverview, dataStatus: 'not_configured', protected: null, total: null }}
      />
    );

    expect(screen.getByTestId('portal-backup-overview-protected').textContent).toContain(
      'Not available'
    );
    const deadEnds = screen.getAllByText('Not available');
    expect(deadEnds.length).toBeGreaterThanOrEqual(3);
    for (const el of deadEnds) {
      expect(el.className).not.toMatch(/font-display|text-2xl|text-figures/);
      expect(el.closest('.text-figures')).toBeNull();
      expect(el.closest('.font-display')).toBeNull();
    }
  });

  it('rules the summary as a hairline ledger, never a boxed grid', () => {
    render(<BackupOverview overview={configuredOverview} hasBackupActivity />);

    const ledger = screen.getByTestId('portal-backup-overview-summary');
    expect(ledger.tagName).toBe('DL');
    expect(ledger.className).toContain('divide-y');
    // Data is never boxed (apps/portal/DESIGN.md): no card grid, no cell
    // borders, no rounded surface around figures.
    expect(ledger.className).not.toMatch(/rounded|grid|bg-|overflow-hidden/);
    expect(ledger.className).not.toMatch(/(^|\s)border(\s|$)/);

    const rows = Array.from(ledger.children);
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.querySelector('dt')).not.toBeNull();
      expect(row.querySelector('dd')).not.toBeNull();
      expect(row.className).not.toMatch(/rounded|bg-/);
      expect(row.className).not.toMatch(/(^|\s)border(\s|$)/);
    }

    for (const label of [
      'Protected devices',
      'Last verification',
      'Last restore test',
      'Recovery readiness',
      'Backups behind schedule',
      'Restores slower than promised',
    ]) {
      expect(screen.getByText(label).tagName).toBe('DT');
    }
  });

  it('keeps the serif money face on real figures only', () => {
    render(<BackupOverview overview={configuredOverview} hasBackupActivity />);

    expect(
      screen.getByTestId('portal-backup-overview-protected').querySelector('.font-display')
        ?.textContent
    ).toBe('3 of 4');
    expect(
      screen.getByTestId('portal-backup-overview-readiness').querySelector('.font-display')
        ?.textContent
    ).toBe('76');

    // A date is a tabular column but never a serif moment.
    expect(
      screen
        .getByTestId('portal-backup-overview-last-verification')
        .querySelector('.font-display')
    ).toBeNull();

    // The secondary line is quiet 12px text under the value, not a figure.
    const secondary = screen.getByText(/Average across/);
    expect(secondary.className).toContain('text-xs');
    expect(secondary.className).not.toMatch(/font-display|text-figures/);
  });
});
