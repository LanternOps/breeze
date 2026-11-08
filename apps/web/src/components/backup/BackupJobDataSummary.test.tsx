import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_FULL_RUN_REASONS,
  type BackupFullRunDisplayReason,
  type BackupJobDataAccounting,
} from '@breeze/shared';

import BackupJobDataSummary from './BackupJobDataSummary';

const accounting = (overrides: Partial<BackupJobDataAccounting> = {}): BackupJobDataAccounting => ({
  protectedBytes: 10485760,
  uploadedBytes: 4194304,
  reusedBytes: 6291456,
  processedBytes: null,
  runKind: 'incremental',
  fullRunReason: null,
  ...overrides,
});

const stopped = accounting({
  protectedBytes: null,
  uploadedBytes: null,
  reusedBytes: null,
  processedBytes: 1400 * 1024 * 1024,
});

const REASON_LABELS: Record<BackupFullRunDisplayReason, string> = {
  no_prior_snapshot: 'First backup for this device and destination',
  base_expired: 'The previous backup had expired under retention',
  storage_identity_changed: 'The backup destination changed',
  backup_type_mismatch: 'The previous backup was a different type',
  base_job_not_completed: 'No earlier backup finished successfully',
  base_retired: 'The previous backup was removed by retention',
  base_deleted_race: 'The previous backup was removed by retention',
  base_retired_race: 'The previous backup was removed by retention',
  no_verified_base: 'No earlier backup passed integrity verification',
  key_root_changed: 'The destination folder (prefix) changed',
  base_key_root_unreadable: "The previous backup's storage location could not be read",
  invalid_destination_prefix: 'The destination prefix is invalid',
  nothing_reused: 'An earlier backup was available, but no unchanged files could be reused',
  unrecorded: 'Reason not recorded (this backup ran before Breeze tracked it)',
};

describe('BackupJobDataSummary cell', () => {
  it('cell restorable shows uploaded and reused', () => {
    render(<BackupJobDataSummary accounting={accounting()} variant="cell" />);

    const summary = screen.getByTestId('backup-job-data-summary');
    expect(summary.textContent).toContain('4.00 MB uploaded · 6.00 MB reused');
    expect(screen.queryByTestId('backup-run-full')).toBeNull();
  });

  it("cell failed shows processed before it stopped and no 'uploaded' text", () => {
    render(<BackupJobDataSummary accounting={stopped} variant="cell" />);

    const summary = screen.getByTestId('backup-job-data-summary');
    expect(summary.textContent).toContain('1.37 GB processed before it stopped');
    expect(summary.textContent).not.toMatch(/uploaded/i);
    expect(screen.queryByTestId('backup-run-full')).toBeNull();
  });

  it('cell of a run that stopped before processing anything shows a dash', () => {
    render(<BackupJobDataSummary accounting={{ ...stopped, processedBytes: 0 }} variant="cell" />);

    expect(screen.getByTestId('backup-job-data-summary').textContent).toBe('-');
  });

  it('cell with no reuse model shows only the size', () => {
    render(<BackupJobDataSummary accounting={accounting({ runKind: null })} variant="cell" />);

    const summary = screen.getByTestId('backup-job-data-summary');
    expect(summary.textContent).toBe('10.0 MB');
  });

  it('full chip title is the reason label', () => {
    render(
      <BackupJobDataSummary
        accounting={accounting({ runKind: 'full', fullRunReason: 'key_root_changed' })}
        variant="cell"
      />,
    );

    const chip = screen.getByTestId('backup-run-full');
    expect(chip.textContent).toBe('Full');
    expect(chip.getAttribute('title')).toBe('The destination folder (prefix) changed');
  });

  it.each(Object.entries(REASON_LABELS))('%s has its label', (reason, label) => {
    render(
      <BackupJobDataSummary
        accounting={accounting({ runKind: 'full', fullRunReason: reason as BackupFullRunDisplayReason })}
        variant="cell"
      />,
    );

    expect(screen.getByTestId('backup-run-full').getAttribute('title')).toBe(label);
  });

  it('every stored reason is in the label table above', () => {
    for (const reason of BACKUP_FULL_RUN_REASONS) {
      expect(REASON_LABELS[reason]).toBeTruthy();
    }
  });
});

describe('BackupJobDataSummary detail', () => {
  it('restorable incremental run lists what it stored and links to the docs', () => {
    render(<BackupJobDataSummary accounting={accounting()} variant="detail" />);

    const summary = within(screen.getByTestId('backup-job-data-summary'));
    expect(summary.getByText('What this run stored')).toBeTruthy();
    expect(summary.getByText('Protected')).toBeTruthy();
    expect(summary.getByText('10.0 MB')).toBeTruthy();
    expect(summary.getByText('Uploaded this run')).toBeTruthy();
    expect(summary.getByText('4.00 MB')).toBeTruthy();
    expect(summary.getByText('Reused from earlier backups')).toBeTruthy();
    expect(summary.getByText('6.00 MB')).toBeTruthy();
    expect(summary.getByText('Incremental')).toBeTruthy();
    expect(
      summary.getByText(/Only new or changed files are uploaded\. Unchanged files are reused from earlier backups/),
    ).toBeTruthy();
    expect(summary.getByRole('link').getAttribute('href')).toBe(
      'https://docs.breezermm.com/backup/incremental-backups/',
    );
  });

  it('full run names the reason', () => {
    render(
      <BackupJobDataSummary
        accounting={accounting({ runKind: 'full', fullRunReason: 'no_prior_snapshot' })}
        variant="detail"
      />,
    );

    expect(screen.getByText('Full — First backup for this device and destination')).toBeTruthy();
  });

  it('legacy full run says the reason was not recorded', () => {
    render(
      <BackupJobDataSummary
        accounting={accounting({ runKind: 'full', fullRunReason: 'unrecorded' })}
        variant="detail"
      />,
    );

    expect(
      screen.getByText('Full — Reason not recorded (this backup ran before Breeze tracked it)'),
    ).toBeTruthy();
  });

  it('detail shows resumed line when resumedAt is set', () => {
    render(
      <BackupJobDataSummary
        accounting={accounting()}
        variant="detail"
        resumedAt="2026-11-05T10:02:00.000Z"
      />,
    );

    expect(screen.getByTestId('backup-job-resumed').textContent).toMatch(
      /^This run resumed an interrupted backup at .*2026.*\.$/,
    );
  });

  it('detail has no resumed line for a run that never resumed', () => {
    render(<BackupJobDataSummary accounting={accounting()} variant="detail" resumedAt={null} />);

    expect(screen.queryByTestId('backup-job-resumed')).toBeNull();
  });

  it('failed run is never labelled uploaded', () => {
    render(<BackupJobDataSummary accounting={stopped} variant="detail" />);

    const summary = screen.getByTestId('backup-job-data-summary');
    expect(summary.textContent).toContain('1.37 GB processed before it stopped');
    expect(summary.textContent).not.toContain('Uploaded this run');
    expect(summary.textContent).not.toContain('Protected');
  });

  it('a failed run does not show the incremental explainer, even with a recorded run kind', () => {
    render(
      <BackupJobDataSummary
        accounting={{ ...stopped, runKind: 'incremental' }}
        variant="detail"
      />,
    );

    const summary = screen.getByTestId('backup-job-data-summary');
    expect(summary.textContent).not.toContain('Only new or changed files');
    expect(summary.textContent).not.toContain('How incremental backups work');
  });

  it('an in-flight run keeps the incremental explainer', () => {
    render(
      <BackupJobDataSummary accounting={{ ...stopped, runKind: 'incremental' }} variant="detail" inFlight />,
    );

    expect(screen.getByText('How incremental backups work')).toBeTruthy();
  });

  it('a finished run still shows the incremental explainer', () => {
    render(<BackupJobDataSummary accounting={accounting()} variant="detail" />);

    expect(screen.getByText('How incremental backups work')).toBeTruthy();
  });

  it('a stopped run with no recorded reason makes no claim about its backup type', () => {
    // It may never have reached dispatch, so "ran before Breeze tracked it" is
    // not something the row can support.
    render(
      <BackupJobDataSummary
        accounting={{ ...stopped, runKind: 'full', fullRunReason: 'unrecorded' }}
        variant="detail"
      />,
    );

    expect(screen.getByTestId('backup-job-data-summary').textContent).not.toContain('Reason not recorded');
  });

  it('a stopped run with a stored reason still names it', () => {
    render(
      <BackupJobDataSummary
        accounting={{ ...stopped, runKind: 'full', fullRunReason: 'no_prior_snapshot' }}
        variant="detail"
      />,
    );

    expect(screen.getByText('Full — First backup for this device and destination')).toBeTruthy();
  });

  it('an in-flight run shows its type and resume, and no processed-before-it-stopped text', () => {
    render(
      <BackupJobDataSummary
        accounting={{ ...stopped, runKind: 'incremental' }}
        variant="detail"
        inFlight
        resumedAt="2026-11-05T10:02:00.000Z"
      />,
    );

    const summary = screen.getByTestId('backup-job-data-summary');
    expect(summary.textContent).toContain('Incremental');
    expect(summary.textContent).not.toContain('before it stopped');
    expect(screen.getByTestId('backup-job-resumed')).toBeTruthy();
  });

  it('mode with no reuse model lists the size and no reuse rows', () => {
    render(<BackupJobDataSummary accounting={accounting({ runKind: null })} variant="detail" />);

    const summary = screen.getByTestId('backup-job-data-summary');
    expect(summary.textContent).toContain('Protected');
    expect(summary.textContent).not.toContain('Uploaded this run');
    expect(summary.textContent).not.toContain('Reused from earlier backups');
    expect(summary.textContent).not.toContain('Only new or changed files');
  });
});
