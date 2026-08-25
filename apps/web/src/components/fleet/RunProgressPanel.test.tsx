import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getRunMock } = vi.hoisted(() => ({ getRunMock: vi.fn() }));

vi.mock('@/services/fleetFindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/fleetFindings')>();
  return { ...actual, getRun: getRunMock };
});

import RunProgressPanel, { RUN_POLL_INTERVAL_MS } from './RunProgressPanel';
import type {
  FleetRemediationRunDetail, FleetRemediationRunTarget, FleetRunStatus,
} from '@/services/fleetFindings';

const RUN_ID = 'rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr';
const DEVICE_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddda1';
const DEVICE_B = 'dddddddd-dddd-4ddd-8ddd-ddddddddddb2';

function target(overrides: Partial<FleetRemediationRunTarget> = {}): FleetRemediationRunTarget {
  return {
    deviceId: DEVICE_A,
    hostname: 'WS-ACME-01',
    siteId: '33333333-3333-4333-8333-333333333333',
    status: 'queued',
    skipReason: null,
    deviceCommandId: null,
    resultSummary: null,
    queuedAt: '2026-08-07T10:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

function run(
  status: FleetRunStatus,
  overrides: Partial<FleetRemediationRunDetail> = {}
): FleetRemediationRunDetail {
  return {
    id: RUN_ID,
    orgId: '11111111-1111-4111-8111-111111111111',
    findingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    findingRevision: 2,
    actionKind: 'command',
    scriptId: null,
    commandType: 'restart_service',
    parameterSnapshot: { name: 'Spooler' },
    status,
    targetCount: 2,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    createdAt: '2026-08-07T10:00:00.000Z',
    startedAt: null,
    completedAt: null,
    targets: [target(), target({ deviceId: DEVICE_B, hostname: 'WS-ACME-02' })],
    ...overrides,
  };
}

beforeEach(() => {
  getRunMock.mockResolvedValue(run('running'));
});

describe('RunProgressPanel polling', () => {
  it('polls until the run reaches a terminal status, then stops', async () => {
    vi.useFakeTimers();
    try {
      getRunMock
        .mockResolvedValueOnce(run('queued'))
        .mockResolvedValueOnce(run('running'))
        .mockResolvedValueOnce(
          run('partial', {
            succeededCount: 1,
            failedCount: 1,
            completedAt: '2026-08-07T10:05:00.000Z',
            // The summary now derives from target rows (not the roll-up
            // columns) whenever the snapshot holds every target (#3452), so
            // the target statuses must agree with succeededCount/failedCount.
            targets: [
              target({ status: 'succeeded' }),
              target({ deviceId: DEVICE_B, hostname: 'WS-ACME-02', status: 'failed' }),
            ],
          })
        );

      render(<RunProgressPanel runId={RUN_ID} onClose={vi.fn()} />);

      // Initial fetch on mount.
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(getRunMock).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS); });
      expect(getRunMock).toHaveBeenCalledTimes(2);

      await act(async () => { await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS); });
      expect(getRunMock).toHaveBeenCalledTimes(3);

      // Terminal ('partial') — no further polls, however long we wait.
      await act(async () => { await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS * 10); });
      expect(getRunMock).toHaveBeenCalledTimes(3);

      expect(screen.getByTestId('run-progress-summary').textContent).toContain('1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling on unmount', async () => {
    vi.useFakeTimers();
    try {
      getRunMock.mockResolvedValue(run('running'));

      const { unmount } = render(<RunProgressPanel runId={RUN_ID} onClose={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(getRunMock).toHaveBeenCalledTimes(1);

      unmount();

      await act(async () => { await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS * 5); });
      expect(getRunMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll a run that is already terminal on first read', async () => {
    vi.useFakeTimers();
    try {
      getRunMock.mockResolvedValue(run('failed', { failedCount: 2 }));

      render(<RunProgressPanel runId={RUN_ID} onClose={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(getRunMock).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS * 4); });
      expect(getRunMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RunProgressPanel rendering', () => {
  it('renders a row per device with status, summary and skip reason', async () => {
    getRunMock.mockResolvedValue(
      run('partial', {
        succeededCount: 1,
        skippedCount: 1,
        completedAt: '2026-08-07T10:05:00.000Z',
        targets: [
          target({ status: 'succeeded', resultSummary: 'Service Spooler restarted' }),
          target({
            deviceId: DEVICE_B,
            hostname: 'WS-ACME-02',
            status: 'skipped',
            skipReason: 'decommissioned',
          }),
        ],
      })
    );

    render(<RunProgressPanel runId={RUN_ID} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId(`run-progress-target-${DEVICE_A}`)).toBeTruthy());
    const a = screen.getByTestId(`run-progress-target-${DEVICE_A}`);
    expect(a.textContent).toContain('WS-ACME-01');
    expect(a.textContent).toContain('Service Spooler restarted');

    // Scope to the skip-reason summary span, not the whole row — the row also
    // renders a status chip ("Skipped") in the same `<li>`, so asserting over
    // `row.textContent` would pass even if the skip-reason text were wrong.
    const bSummary = screen.getByTestId(`run-progress-summary-${DEVICE_B}`);
    expect(bSummary.textContent?.toLowerCase()).toContain('removed');
  });

  it('caps an unbounded result summary rather than blowing out the row', async () => {
    const huge = 'x'.repeat(5000);
    getRunMock.mockResolvedValue(
      run('failed', { targets: [target({ status: 'failed', resultSummary: huge })] })
    );

    render(<RunProgressPanel runId={RUN_ID} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId(`run-progress-target-${DEVICE_A}`)).toBeTruthy());
    const text = screen.getByTestId(`run-progress-summary-${DEVICE_A}`).textContent ?? '';
    expect(text.length).toBeLessThan(400);
  });

  it('derives the summary from target rows when the roll-up has not caught up yet (#3452)', async () => {
    // Between dispatch and the first `pollRunProgress` tick, the server-side
    // roll-up columns can still read 0/0/0 while the target rows already show
    // their real terminal status — the summary must count the rows, not trust
    // the stale roll-up.
    getRunMock.mockResolvedValue(
      run('failed', {
        targetCount: 4,
        succeededCount: 0,
        failedCount: 0,
        skippedCount: 0,
        targets: [
          target({ deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddd01', hostname: 'WS-01', status: 'skipped', skipReason: 'decommissioned' }),
          target({ deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddd02', hostname: 'WS-02', status: 'skipped', skipReason: 'decommissioned' }),
          target({ deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddd03', hostname: 'WS-03', status: 'skipped', skipReason: 'decommissioned' }),
          target({ deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddd04', hostname: 'WS-04', status: 'skipped', skipReason: 'decommissioned' }),
        ],
      })
    );

    render(<RunProgressPanel runId={RUN_ID} onClose={vi.fn()} />);

    const summary = await screen.findByTestId('run-progress-summary');
    // The bug reported "0 succeeded, 0 failed, 0 skipped of 4 targeted"
    // despite all 4 rows already showing Skipped.
    expect(summary.textContent).toBe('0 succeeded, 0 failed, 4 skipped of 4 targeted');
  });

  it('falls back to the server roll-up when the targets array is a site-filtered subset', async () => {
    // A site-restricted caller gets `targets` filtered to their allowed sites
    // while targetCount and the roll-up counters still cover the whole run —
    // counting the (partial) targets array there would under-report.
    getRunMock.mockResolvedValue(
      run('partial', {
        targetCount: 5,
        succeededCount: 3,
        failedCount: 1,
        skippedCount: 1,
        targets: [target({ status: 'succeeded' })],
      })
    );

    render(<RunProgressPanel runId={RUN_ID} onClose={vi.fn()} />);

    const summary = await screen.findByTestId('run-progress-summary');
    // Server roll-up verbatim (3/1/1 of 5) rather than counting the single
    // (site-filtered) target row present in this snapshot.
    expect(summary.textContent).toBe('3 succeeded, 1 failed, 1 skipped of 5 targeted');
  });

  it('surfaces a load failure instead of an empty run', async () => {
    getRunMock.mockRejectedValue(new Error('run gone'));

    render(<RunProgressPanel runId={RUN_ID} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('run-progress-error')).toBeTruthy());
    expect(screen.getByTestId('run-progress-error').textContent).toContain('run gone');
  });

  it('keeps the last good snapshot under the error and re-arms polling on retry', async () => {
    vi.useFakeTimers();
    try {
      getRunMock
        .mockResolvedValueOnce(run('running'))
        .mockRejectedValueOnce(new Error('network blip'))
        .mockResolvedValue(run('succeeded', { succeededCount: 2 }));

      render(<RunProgressPanel runId={RUN_ID} onClose={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByTestId('run-progress-summary')).toBeTruthy();

      // Second poll fails — the run stays on screen rather than vanishing,
      // and polling stops instead of hammering a failing endpoint.
      await act(async () => { await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS); });
      expect(screen.getByTestId('run-progress-error')).toBeTruthy();
      expect(screen.getByTestId(`run-progress-target-${DEVICE_A}`)).toBeTruthy();

      await act(async () => { await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS * 4); });
      expect(getRunMock).toHaveBeenCalledTimes(2);

      await act(async () => {
        fireEvent.click(screen.getByTestId('run-progress-retry'));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(getRunMock).toHaveBeenCalledTimes(3);
      expect(screen.queryByTestId('run-progress-error')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
