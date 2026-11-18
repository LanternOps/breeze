import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveBackupJob } from '@breeze/shared';

import DeviceBackupActiveJobs from './DeviceBackupActiveJobs';

const NOW = new Date('2026-11-05T12:00:00.000Z');

const job = (overrides: Partial<ActiveBackupJob> = {}): ActiveBackupJob => ({
  id: 'job-running',
  status: 'running',
  backupMode: 'file',
  backupType: 'file',
  createdAt: '2026-11-05T11:00:00.000Z',
  startedAt: '2026-11-05T11:50:00.000Z',
  totalSize: 4_000_000,
  transferredSize: 1_000_000,
  fileCount: 10,
  totalFiles: 40,
  lastProgressAt: '2026-11-05T11:59:50.000Z',
  lastKeepaliveAt: '2026-11-05T11:59:50.000Z',
  resumedAt: null,
  ...overrides,
});

describe('DeviceBackupActiveJobs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing without jobs', () => {
    const { container } = render(<DeviceBackupActiveJobs jobs={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders two cards running-first with phases', () => {
    // The API already orders running first; the component must keep that order.
    render(
      <DeviceBackupActiveJobs
        jobs={[
          job(),
          job({
            id: 'job-pending',
            status: 'pending',
            backupMode: 'system_image',
            startedAt: null,
            totalSize: null,
            transferredSize: null,
            fileCount: null,
            totalFiles: null,
            lastProgressAt: null,
            lastKeepaliveAt: '2026-11-05T11:59:40.000Z',
          }),
        ]}
      />,
    );

    const cards = screen.getAllByTestId('device-backup-active-job');
    expect(cards.map((c) => c.getAttribute('data-phase'))).toEqual(['backing_up', 'queued_on_device']);
    expect(within(cards[0]!).getByText('Backing up')).toBeTruthy();
    expect(within(cards[0]!).getByTestId('device-backup-active-job-progress').getAttribute('data-indeterminate')).toBe('false');
    expect(within(cards[0]!).getByText('10 / 40 files')).toBeTruthy();
    // 1 MB in 10 min ≈ 1.67 KB/s → 3 MB left ≈ 30 min.
    expect(within(cards[0]!).getByTestId('device-backup-active-job-eta').textContent).toBe('about 30m left');
    expect(within(cards[0]!).getByTestId('device-backup-active-job-heard').textContent).toContain('Last heard from the device');

    expect(within(cards[1]!).getByText('Waiting for another backup on this device to finish')).toBeTruthy();
    expect(within(cards[1]!).getByTestId('device-backup-active-job-progress').getAttribute('data-indeterminate')).toBe('true');
    expect(within(cards[1]!).queryByTestId('device-backup-active-job-eta')).toBeNull();
  });

  it('labels a pending job the device has not picked up yet', () => {
    render(<DeviceBackupActiveJobs jobs={[job({ status: 'pending', startedAt: null, lastKeepaliveAt: null, lastProgressAt: null })]} />);
    const card = screen.getByTestId('device-backup-active-job');
    expect(card.getAttribute('data-phase')).toBe('waiting_for_device');
    expect(within(card).getByText('Sent to the device, waiting for it to start')).toBeTruthy();
    expect(within(card).queryByTestId('device-backup-active-job-heard')).toBeNull();
  });

  it('shows Scanning files with an indeterminate bar while the total is unknown', () => {
    render(<DeviceBackupActiveJobs jobs={[job({ totalSize: null, totalFiles: null, transferredSize: 5000 })]} />);
    const card = screen.getByTestId('device-backup-active-job');
    expect(card.getAttribute('data-phase')).toBe('scanning');
    expect(within(card).getByText('Scanning files')).toBeTruthy();
    expect(within(card).getByTestId('device-backup-active-job-progress').getAttribute('data-indeterminate')).toBe('true');
  });

  it('resuming phase shows no ETA and no stalled chip while keepalive is fresh', () => {
    // #11014's shape: a resumed run sits at transferredSize 0 for a long time.
    render(
      <DeviceBackupActiveJobs
        jobs={[
          job({
            startedAt: '2026-11-05T08:00:00.000Z',
            resumedAt: '2026-11-05T08:01:00.000Z',
            transferredSize: 0,
            lastProgressAt: '2026-11-05T08:01:00.000Z',
            lastKeepaliveAt: '2026-11-05T11:59:30.000Z',
          }),
        ]}
      />,
    );
    const card = screen.getByTestId('device-backup-active-job');
    expect(card.getAttribute('data-phase')).toBe('resuming');
    expect(within(card).getByText('Resuming an interrupted backup')).toBeTruthy();
    expect(within(card).queryByTestId('device-backup-active-job-eta')).toBeNull();
    expect(within(card).queryByTestId('device-backup-active-job-stalled')).toBeNull();
  });

  it('stalled chip appears after keepalive older than 2 minutes', () => {
    render(<DeviceBackupActiveJobs jobs={[job({ lastKeepaliveAt: '2026-11-05T11:55:00.000Z' })]} />);
    const card = screen.getByTestId('device-backup-active-job');
    const chip = within(card).getByTestId('device-backup-active-job-stalled');
    expect(chip.getAttribute('title')).toContain('5');
    // A stalled run has no believable ETA.
    expect(within(card).queryByTestId('device-backup-active-job-eta')).toBeNull();
  });

  it('offers Stop only when onStop is given, and passes the job id', () => {
    const onStop = vi.fn();
    const { rerender } = render(<DeviceBackupActiveJobs jobs={[job()]} />);
    expect(screen.queryByTestId('device-backup-active-job-stop')).toBeNull();

    rerender(<DeviceBackupActiveJobs jobs={[job()]} onStop={onStop} />);
    fireEvent.click(screen.getByTestId('device-backup-active-job-stop'));
    expect(onStop).toHaveBeenCalledWith('job-running');
  });

  it('disables every Stop button while one stop is in flight', () => {
    // The tab handles one stop at a time, so a live button on the other card
    // would swallow the click with no feedback.
    render(
      <DeviceBackupActiveJobs
        jobs={[job(), job({ id: 'job-other', status: 'pending', startedAt: null })]}
        onStop={vi.fn()}
        stoppingId="job-running"
      />,
    );
    const buttons = screen.getAllByTestId('device-backup-active-job-stop') as HTMLButtonElement[];
    expect(buttons.map((b) => b.disabled)).toEqual([true, true]);
  });

  it('derives speed and ETA from the delta between polls, and drops them when bytes stop moving', () => {
    const { rerender } = render(<DeviceBackupActiveJobs jobs={[job()]} />);
    // First sample: the running average, 1 MB over 10 min → 3 MB left ≈ 30 min.
    expect(screen.getByTestId('device-backup-active-job-eta').textContent).toBe('about 30m left');

    // 10 s later, 100 KB more: 10 KB/s → 2.9 MB left ≈ 4 min 50 s. A running
    // average would say about 26 min, so this proves the sample was kept.
    vi.setSystemTime(new Date(NOW.getTime() + 10_000));
    rerender(<DeviceBackupActiveJobs jobs={[job({ transferredSize: 1_100_000 })]} />);
    expect(screen.getByTestId('device-backup-active-job-eta').textContent).toBe('about 4m left');

    // Same bytes on the next poll: no speed, so no ETA, not a misleading average.
    vi.setSystemTime(new Date(NOW.getTime() + 15_000));
    rerender(<DeviceBackupActiveJobs jobs={[job({ transferredSize: 1_100_000 })]} />);
    expect(screen.queryByTestId('device-backup-active-job-eta')).toBeNull();
  });
});
