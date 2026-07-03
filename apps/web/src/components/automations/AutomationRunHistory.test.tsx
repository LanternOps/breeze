import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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
