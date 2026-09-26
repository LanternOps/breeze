import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

import AutomationRunHistory, {
  type AutomationRun,
  type DeviceRunResult,
} from './AutomationRunHistory';

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    automationName: 'Nightly patch',
    triggeredBy: 'manual',
    startedAt: '2026-07-08T00:00:00.000Z',
    completedAt: undefined,
    status: 'running',
    devicesTotal: 4,
    devicesSuccess: 1,
    devicesFailed: 1,
    devicesSkipped: 0,
    deviceResults: [],
    logs: [],
    ...overrides,
  };
}

describe('AutomationRunHistory — live progress + per-device results (#2023)', () => {
  it('renders a live progress bar for an in-progress run', () => {
    render(
      <AutomationRunHistory runs={[makeRun()]} isOpen onClose={() => {}} />,
    );

    const progress = screen.getByTestId('run-progress');
    // 2 of 4 devices finished (1 success + 1 failed) → 50%.
    expect(progress.textContent).toContain('2 of 4 devices finished');
    expect(progress.textContent).toContain('50%');
  });

  it('does not render a progress bar for a completed run', () => {
    render(
      <AutomationRunHistory
        runs={[makeRun({ status: 'success', completedAt: '2026-07-08T00:01:00.000Z', devicesSuccess: 4, devicesFailed: 0 })]}
        isOpen
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId('run-progress')).toBeNull();
  });

  it('lazily loads per-device results on expand and renders them', async () => {
    const deviceResults: DeviceRunResult[] = [
      { deviceId: 'd-1', deviceName: 'Reception PC', status: 'success', duration: 3000 },
      { deviceId: 'd-2', deviceName: 'HOST-2', status: 'failed', error: 'boom' },
    ];
    const onLoadRunDetail = vi.fn().mockResolvedValue({ deviceResults, logs: [] });

    render(
      <AutomationRunHistory
        runs={[makeRun({ status: 'success', completedAt: '2026-07-08T00:01:00.000Z' })]}
        isOpen
        onClose={() => {}}
        onLoadRunDetail={onLoadRunDetail}
      />,
    );

    // Not fetched until expanded.
    expect(onLoadRunDetail).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(/Manual - 4 devices/).closest('button')!);

    await waitFor(() => expect(onLoadRunDetail).toHaveBeenCalledWith('run-1'));
    await waitFor(() => expect(screen.getByText('Reception PC')).toBeTruthy());
    expect(screen.getByText('HOST-2')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
  });

  it('re-fetches per-device detail when live progress counts change', async () => {
    const onLoadRunDetail = vi.fn().mockResolvedValue({ deviceResults: [], logs: [] });
    const { rerender } = render(
      <AutomationRunHistory
        runs={[makeRun({ devicesSuccess: 1, devicesFailed: 0 })]}
        isOpen
        onClose={() => {}}
        onLoadRunDetail={onLoadRunDetail}
      />,
    );

    fireEvent.click(screen.getByText(/Manual - 4 devices/).closest('button')!);
    await waitFor(() => expect(onLoadRunDetail).toHaveBeenCalledTimes(1));

    // A poll bumps the finished count — the expanded row should refresh detail.
    rerender(
      <AutomationRunHistory
        runs={[makeRun({ devicesSuccess: 2, devicesFailed: 0 })]}
        isOpen
        onClose={() => {}}
        onLoadRunDetail={onLoadRunDetail}
      />,
    );
    await waitFor(() => expect(onLoadRunDetail).toHaveBeenCalledTimes(2));
  });

  it('shows an error state when the per-device detail load fails', async () => {
    const onLoadRunDetail = vi.fn().mockResolvedValue(null);
    render(
      <AutomationRunHistory
        runs={[makeRun({ status: 'success', completedAt: '2026-07-08T00:01:00.000Z' })]}
        isOpen
        onClose={() => {}}
        onLoadRunDetail={onLoadRunDetail}
      />,
    );

    fireEvent.click(screen.getByText(/Manual - 4 devices/).closest('button')!);
    await waitFor(() => expect(screen.getByText(/Couldn't load device results/)).toBeTruthy());
  });

  it('filters runs by status', () => {
    const runs = [
      makeRun({ id: 'r-run', status: 'running' }),
      makeRun({ id: 'r-fail', status: 'failed', completedAt: '2026-07-08T00:01:00.000Z' }),
    ];
    render(<AutomationRunHistory runs={runs} isOpen onClose={() => {}} />);

    fireEvent.change(screen.getByDisplayValue('All Status'), { target: { value: 'failed' } });
    expect(screen.getByText('1 of 2 runs')).toBeTruthy();
  });
});

describe('AutomationRunHistory — script output (#3162)', () => {
  const withScript: DeviceRunResult[] = [
    {
      deviceId: 'd-1',
      deviceName: 'Reception PC',
      status: 'success',
      output: '[info] Queued run_script action',
      scriptResults: [
        {
          executionId: 'exec-1',
          scriptId: 'script-1',
          scriptName: 'Collect logs',
          status: 'completed',
          exitCode: 0,
          stdout: 'hello from the agent',
          stderr: 'a warning',
        },
      ],
    },
    { deviceId: 'd-2', deviceName: 'HOST-2', status: 'success' },
  ];

  async function expandRun(deviceResults: DeviceRunResult[]) {
    const onLoadRunDetail = vi.fn().mockResolvedValue({ deviceResults, logs: [] });
    render(
      <AutomationRunHistory
        runs={[makeRun({ status: 'success', completedAt: '2026-07-08T00:01:00.000Z' })]}
        isOpen
        onClose={() => {}}
        onLoadRunDetail={onLoadRunDetail}
      />,
    );
    fireEvent.click(screen.getByText(/Manual - 4 devices/).closest('button')!);
    await waitFor(() => expect(screen.getByText('Reception PC')).toBeTruthy());
  }

  it('offers a script-output toggle only for devices that ran a script', async () => {
    await expandRun(withScript);
    expect(screen.getAllByTestId('script-output-toggle')).toHaveLength(1);
    // Collapsed by default — stdout is not in the DOM until asked for.
    expect(screen.queryByTestId('script-stdout')).toBeNull();
  });

  it('reveals the real stdout and stderr on expand', async () => {
    await expandRun(withScript);

    fireEvent.click(screen.getByTestId('script-output-toggle'));

    expect(screen.getByTestId('script-stdout').textContent).toContain('hello from the agent');
    expect(screen.getByTestId('script-stderr').textContent).toContain('a warning');
    expect(screen.getByText('Collect logs')).toBeTruthy();
    expect(screen.getByText('Exit code 0')).toBeTruthy();
  });

  it('shows an explicit empty-output placeholder rather than a blank pane', async () => {
    await expandRun([
      {
        deviceId: 'd-1',
        deviceName: 'Reception PC',
        status: 'success',
        scriptResults: [
          { executionId: 'exec-1', scriptId: 'script-1', status: 'completed', exitCode: 0 },
        ],
      },
    ]);

    fireEvent.click(screen.getByTestId('script-output-toggle'));
    expect(screen.getByTestId('script-stdout').textContent).toBe('No output');
    // Falls back to a generic label when the script name didn't resolve
    // (a partner-wide script is invisible under an org-scoped RLS context).
    expect(screen.getByText('Script')).toBeTruthy();
  });

  it('distinguishes "agent has not reported yet" from "script printed nothing"', async () => {
    // Collapsing these two into the same grey placeholder is exactly the
    // ambiguity #3162 was filed about.
    await expandRun([
      {
        deviceId: 'd-1',
        deviceName: 'Reception PC',
        status: 'success',
        scriptResults: [
          { executionId: 'exec-1', scriptId: 'script-1', status: 'running' },
        ],
      },
    ]);

    fireEvent.click(screen.getByTestId('script-output-toggle'));
    expect(screen.getByTestId('script-awaiting')).toBeTruthy();
    expect(screen.queryByTestId('script-stdout')).toBeNull();
  });

  it('flags truncated output so a cut-off log is not mistaken for the whole thing', async () => {
    await expandRun([
      {
        deviceId: 'd-1',
        deviceName: 'Reception PC',
        status: 'success',
        scriptResults: [
          {
            executionId: 'exec-1',
            scriptId: 'script-1',
            status: 'completed',
            exitCode: 0,
            stdout: 'first 16k of output',
            stdoutTruncated: true,
          },
        ],
      },
    ]);

    fireEvent.click(screen.getByTestId('script-output-toggle'));
    expect(screen.getByTestId('script-stdout-truncated')).toBeTruthy();
  });

  it('keeps polling for output after the run itself has finished', async () => {
    // A run goes terminal as soon as its commands are QUEUED; the agent reports
    // stdout seconds later. The parent's run-list poll has already stopped by
    // then, so without this the first view would freeze on "waiting on agent".
    vi.useFakeTimers();
    try {
      const onLoadRunDetail = vi.fn().mockResolvedValue({
        deviceResults: [
          {
            deviceId: 'd-1',
            deviceName: 'Reception PC',
            status: 'success',
            scriptResults: [{ executionId: 'exec-1', scriptId: 'script-1', status: 'queued' }],
          },
        ],
        logs: [],
      });

      render(
        <AutomationRunHistory
          runs={[makeRun({ status: 'success', completedAt: '2026-07-08T00:01:00.000Z' })]}
          isOpen
          onClose={() => {}}
          onLoadRunDetail={onLoadRunDetail}
        />,
      );

      fireEvent.click(screen.getByText(/Manual - 4 devices/).closest('button')!);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(onLoadRunDetail).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(onLoadRunDetail).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling once every execution is terminal', async () => {
    vi.useFakeTimers();
    try {
      const onLoadRunDetail = vi.fn().mockResolvedValue({
        deviceResults: [
          {
            deviceId: 'd-1',
            deviceName: 'Reception PC',
            status: 'success',
            scriptResults: [
              { executionId: 'exec-1', scriptId: 'script-1', status: 'completed', stdout: 'done' },
            ],
          },
        ],
        logs: [],
      });

      render(
        <AutomationRunHistory
          runs={[makeRun({ status: 'success', completedAt: '2026-07-08T00:01:00.000Z' })]}
          isOpen
          onClose={() => {}}
          onLoadRunDetail={onLoadRunDetail}
        />,
      );

      fireEvent.click(screen.getByText(/Manual - 4 devices/).closest('button')!);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(onLoadRunDetail).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(onLoadRunDetail).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders no toggle when the run queued no scripts', async () => {
    await expandRun([{ deviceId: 'd-1', deviceName: 'Reception PC', status: 'success' }]);
    expect(screen.queryByTestId('script-output-toggle')).toBeNull();
  });
});

describe('AutomationRunHistory — execute_command output (#3188)', () => {
  async function expandRun(deviceResults: DeviceRunResult[]) {
    const onLoadRunDetail = vi.fn().mockResolvedValue({ deviceResults, logs: [] });
    render(
      <AutomationRunHistory
        runs={[makeRun({ status: 'success', completedAt: '2026-07-08T00:01:00.000Z' })]}
        isOpen
        onClose={() => {}}
        onLoadRunDetail={onLoadRunDetail}
      />,
    );
    fireEvent.click(screen.getByText(/Manual - 4 devices/).closest('button')!);
    await waitFor(() => expect(screen.getByText('Reception PC')).toBeTruthy());
    return onLoadRunDetail;
  }

  it('offers a command-output toggle only for devices that ran a command, collapsed by default', async () => {
    await expandRun([
      {
        deviceId: 'd-1',
        deviceName: 'Reception PC',
        status: 'success',
        commandResults: [{ actionIndex: 0, status: 'succeeded', output: 'ipconfig says hi' }],
      },
      { deviceId: 'd-2', deviceName: 'HOST-2', status: 'success' },
    ]);
    expect(screen.getAllByTestId('command-output-toggle')).toHaveLength(1);
    expect(screen.queryByTestId('command-stdout')).toBeNull();
  });

  it('reveals the agent-reported stdout and error on expand', async () => {
    await expandRun([
      {
        deviceId: 'd-1',
        deviceName: 'Reception PC',
        status: 'failed',
        commandResults: [
          { actionIndex: 0, status: 'succeeded', output: 'ipconfig says hi' },
          { actionIndex: 1, status: 'failed', output: 'partial', outputTruncated: true, error: 'exit status 1' },
        ],
      },
    ]);

    fireEvent.click(screen.getByTestId('command-output-toggle'));
    const stdout = screen.getAllByTestId('command-stdout');
    expect(stdout).toHaveLength(2);
    expect(stdout[0].textContent).toContain('ipconfig says hi');
    expect(stdout[1].textContent).toContain('partial');
    expect(screen.getByTestId('command-stdout-truncated')).toBeTruthy();
    expect(screen.getByTestId('command-error').textContent).toContain('exit status 1');
  });

  it('distinguishes "agent has not reported yet" from "command printed nothing"', async () => {
    await expandRun([
      {
        deviceId: 'd-1',
        deviceName: 'Reception PC',
        status: 'success',
        commandResults: [
          { actionIndex: 0, status: 'queued', message: 'Queued — device offline' },
          { actionIndex: 1, status: 'succeeded' },
        ],
      },
    ]);

    fireEvent.click(screen.getByTestId('command-output-toggle'));
    expect(screen.getByTestId('command-awaiting').textContent).toContain('Queued — device offline');
    expect(screen.getAllByTestId('command-stdout')).toHaveLength(1);
    expect(screen.getByTestId('command-stdout').textContent).toBe('No output');
  });

  it('keeps polling while a command has not reported yet', async () => {
    vi.useFakeTimers();
    try {
      const onLoadRunDetail = vi.fn().mockResolvedValue({
        deviceResults: [
          {
            deviceId: 'd-1',
            deviceName: 'Reception PC',
            status: 'success',
            commandResults: [{ actionIndex: 0, status: 'delivered' }],
          },
        ],
        logs: [],
      });
      render(
        <AutomationRunHistory
          runs={[makeRun({ status: 'success', completedAt: '2026-07-08T00:01:00.000Z' })]}
          isOpen
          onClose={() => {}}
          onLoadRunDetail={onLoadRunDetail}
        />,
      );
      fireEvent.click(screen.getByText(/Manual - 4 devices/).closest('button')!);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(onLoadRunDetail).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(onLoadRunDetail).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
