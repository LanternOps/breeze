import '@/lib/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchMock }));

import DeviceVendorUpdatesSection from './DeviceVendorUpdatesSection';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const CLOSED = { bios: 'closed', firmware: 'closed', driver: 'closed', application: 'closed' };

const ok = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

function lastRun(over: Record<string, unknown> = {}) {
  return {
    lane: 'dell',
    applicability: 'applicable',
    toolVersion: '5.7.2',
    lastOutcome: 'success_reboot_required',
    lastErrorCode: null,
    lastAttemptAt: '2026-11-05T01:00:00.000Z',
    lastSuccessAt: '2026-11-05T01:30:00.000Z',
    installedCount: 2,
    failedCount: 1,
    rebootRequired: true,
    rebootPendingSince: '2026-11-05T01:30:00.000Z',
    biosVersionBefore: '1.20.0',
    biosVersionAfter: null,
    bitlockerAfter: null,
    verifiedAt: null,
    ...over,
  };
}

function run(id: string, over: Record<string, unknown> = {}) {
  return {
    commandId: id,
    trigger: 'on_demand',
    status: 'completed',
    outcome: 'success_reboot_required',
    errorCode: null,
    toolVersion: '5.7.2',
    rebootRequired: true,
    rebootControlled: true,
    items: [
      { title: 'BIOS update', category: 'bios', version: '1.21.0', result: 'installed' },
      { title: 'Dock firmware', category: 'firmware', version: '3.0', result: 'failed' },
    ],
    skippedCategories: [],
    createdAt: '2026-11-05T01:00:00.000Z',
    completedAt: '2026-11-05T01:30:00.000Z',
    actor: { id: 'u-1', name: 'A Tech', email: 'tech@example.com' },
    ...over,
  };
}

function answer(status: Record<string, unknown>, history: { runs: unknown[]; total: number } = { runs: [], total: 0 }) {
  fetchMock.mockImplementation(async (path: string) =>
    path.includes('/oem-updates/status') ? ok(status) : ok(history));
}

const statusBody = (over: Record<string, unknown> = {}) => ({
  displayState: 'waiting_for_reboot',
  lane: 'dell',
  status: lastRun(),
  gates: CLOSED,
  ...over,
});

const section = () => screen.findByTestId('device-vendor-updates');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DeviceVendorUpdatesSection', () => {
  it('renders last run, outcome, tool version, installed items, reboot state', async () => {
    answer(statusBody(), { runs: [run('run-1')], total: 1 });
    render(<DeviceVendorUpdatesSection deviceId={DEVICE_ID} />);
    const root = await section();
    const last = within(root).getByTestId('vendor-updates-last-run');
    expect(last).toHaveTextContent(/Success, restart needed/i);
    expect(last).toHaveTextContent('5.7.2');
    expect(within(root).getByTestId('vendor-updates-installed-count')).toHaveTextContent('2');
    expect(within(root).getByTestId('vendor-updates-failed-count')).toHaveTextContent('1');
    expect(within(root).getByTestId('vendor-updates-reboot-state')).toHaveTextContent(/restart/i);
    const row = await within(root).findByTestId('vendor-updates-run-run-1');
    expect(row).toHaveTextContent('BIOS update');
    expect(row).toHaveTextContent('1.21.0');
    expect(row).toHaveTextContent('Dock firmware');
    expect(row).toHaveTextContent('A Tech');
  });

  it('each display state has its own copy', async () => {
    const seen = new Map<string, string>();
    for (const displayState of ['up_to_date', 'overdue', 'failing', 'not_supported', 'not_managed', 'waiting_for_reboot', 'reboot_overdue']) {
      answer(statusBody({ displayState }));
      const { unmount } = render(<DeviceVendorUpdatesSection deviceId={DEVICE_ID} />);
      const state = within(await section()).getByTestId('vendor-updates-state');
      expect(state.getAttribute('data-state')).toBe(displayState);
      const text = state.textContent ?? '';
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/vendorUpdates\./);
      seen.set(displayState, text);
      unmount();
    }
    expect(new Set(seen.values()).size).toBe(7);
  });

  it('blocked_no_recovery_key names the fix', async () => {
    answer(statusBody({ displayState: 'failing', status: lastRun({ lastOutcome: 'blocked_no_recovery_key', rebootRequired: false, rebootPendingSince: null }) }));
    render(<DeviceVendorUpdatesSection deviceId={DEVICE_ID} />);
    const help = within(await section()).getByTestId('vendor-updates-outcome-help');
    expect(help).toHaveTextContent(/BitLocker recovery key/i);
    expect(help).toHaveTextContent(/run vendor updates again/i);
  });

  it.each([
    ['blocked_on_battery', /AC power/i],
    ['blocked_reboot_pending', /restart/i],
    ['tool_unavailable', /tool/i],
    ['not_supported', /model/i],
    ['interrupted', /stopped before/i],
    ['retry_later', /try again/i],
    ['failed', /did not finish/i],
    ['partial', /some updates/i],
  ])('%s says what to do', async (lastOutcome, help) => {
    answer(statusBody({ displayState: 'failing', status: lastRun({ lastOutcome }) }));
    render(<DeviceVendorUpdatesSection deviceId={DEVICE_ID} />);
    expect(within(await section()).getByTestId('vendor-updates-outcome-help')).toHaveTextContent(help);
  });

  it('a clean outcome adds no help text', async () => {
    answer(statusBody({ displayState: 'not_managed', status: lastRun({ lastOutcome: 'success', rebootRequired: false, rebootPendingSince: null }) }));
    render(<DeviceVendorUpdatesSection deviceId={DEVICE_ID} />);
    expect(within(await section()).queryByTestId('vendor-updates-outcome-help')).toBeNull();
  });

  it('shows the error code when the run reported one', async () => {
    answer(statusBody({ displayState: 'failing', status: lastRun({ lastOutcome: 'failed', lastErrorCode: 'result_unparseable' }) }));
    render(<DeviceVendorUpdatesSection deviceId={DEVICE_ID} />);
    expect(within(await section()).getByTestId('vendor-updates-last-run')).toHaveTextContent('result_unparseable');
  });

  it('unsupported category shows why it is closed', async () => {
    answer(statusBody({ gates: { ...CLOSED, driver: 'open' } }));
    render(<DeviceVendorUpdatesSection deviceId={DEVICE_ID} />);
    const root = await section();
    const bios = within(root).getByTestId('vendor-updates-category-bios');
    expect(bios.getAttribute('data-gate')).toBe('closed');
    expect(bios).toHaveTextContent(/not available yet/i);
    expect(bios).toHaveTextContent(/Dell/);
    const driver = within(root).getByTestId('vendor-updates-category-driver');
    expect(driver.getAttribute('data-gate')).toBe('open');
    expect(driver).not.toHaveTextContent(/not available yet/i);
  });

  it('empty state without a status row', async () => {
    answer(statusBody({ displayState: 'not_managed', status: null }));
    render(<DeviceVendorUpdatesSection deviceId={DEVICE_ID} />);
    const root = await section();
    expect(within(root).getByTestId('vendor-updates-empty')).toBeInTheDocument();
    expect(within(root).queryByTestId('vendor-updates-last-run')).toBeNull();
    expect(within(root).queryByTestId('vendor-updates-history')).toBeNull();
  });

  it('renders nothing when no lane applies and nothing has run: the feature stays out of sight', async () => {
    answer(statusBody({ displayState: 'not_managed', lane: null, status: null }));
    const { container } = render(<DeviceVendorUpdatesSection deviceId={DEVICE_ID} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('vendor-updates-loading')).toBeNull());
    expect(container).toBeEmptyDOMElement();
  });

  it('still shows a past run after the feature is turned off, without the gate list', async () => {
    answer(statusBody({ lane: null }), { runs: [run('run-1')], total: 1 });
    render(<DeviceVendorUpdatesSection deviceId={DEVICE_ID} />);
    const root = await section();
    expect(within(root).getByTestId('vendor-updates-last-run')).toBeInTheDocument();
    expect(within(root).queryByTestId('vendor-updates-category-bios')).toBeNull();
  });

  it('does not offer a run on demand when no lane can run one', async () => {
    answer(statusBody({ displayState: 'not_managed', lane: null }));
    render(<DeviceVendorUpdatesSection deviceId={DEVICE_ID} />);
    const state = within(await section()).getByTestId('vendor-updates-state');
    expect(state).not.toHaveTextContent(/on demand/i);
    expect(state).toHaveTextContent(/not available/i);
  });

  it('history paginates', async () => {
    fetchMock.mockImplementation(async (path: string) => {
      if (path.includes('/oem-updates/status')) return ok(statusBody());
      return path.includes('offset=5')
        ? ok({ runs: [run('run-6')], total: 6 })
        : ok({ runs: ['run-1', 'run-2', 'run-3', 'run-4', 'run-5'].map((id) => run(id)), total: 6 });
    });
    render(<DeviceVendorUpdatesSection deviceId={DEVICE_ID} />);
    const root = await section();
    await within(root).findByTestId('vendor-updates-run-run-1');
    const previous = within(root).getByTestId('vendor-updates-history-previous');
    const next = within(root).getByTestId('vendor-updates-history-next');
    expect(previous).toBeDisabled();
    expect(next).toBeEnabled();

    await userEvent.click(next);
    await within(root).findByTestId('vendor-updates-run-run-6');
    expect(within(root).queryByTestId('vendor-updates-run-run-1')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(`/devices/${DEVICE_ID}/oem-updates/history?limit=5&offset=5`);
    expect(within(root).getByTestId('vendor-updates-history-next')).toBeDisabled();

    await userEvent.click(within(root).getByTestId('vendor-updates-history-previous'));
    await within(root).findByTestId('vendor-updates-run-run-1');
  });

  it('no pager when one page holds everything', async () => {
    answer(statusBody(), { runs: [run('run-1')], total: 1 });
    render(<DeviceVendorUpdatesSection deviceId={DEVICE_ID} />);
    const root = await section();
    await within(root).findByTestId('vendor-updates-run-run-1');
    expect(within(root).queryByTestId('vendor-updates-history-next')).toBeNull();
  });

  it('a run with no readable result, no actor and a schedule says so', async () => {
    answer(statusBody(), {
      runs: [run('run-1', { outcome: null, items: [], actor: null, trigger: 'scheduled', toolVersion: null })],
      total: 1,
    });
    render(<DeviceVendorUpdatesSection deviceId={DEVICE_ID} />);
    const row = await within(await section()).findByTestId('vendor-updates-run-run-1');
    expect(row).toHaveTextContent(/no readable result/i);
    expect(row).toHaveTextContent(/schedule/i);
  });

  it('a failed status read says so and can retry', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response);
    fetchMock.mockImplementation(async (path: string) =>
      path.includes('/oem-updates/status') ? ok(statusBody()) : ok({ runs: [], total: 0 }));
    render(<DeviceVendorUpdatesSection deviceId={DEVICE_ID} />);
    const error = await screen.findByTestId('vendor-updates-error');
    await userEvent.click(within(error).getByTestId('vendor-updates-retry'));
    expect(await section()).toBeInTheDocument();
  });

  it.each([403, 404])('a %i renders nothing: not this user\'s to see', async (status) => {
    fetchMock.mockResolvedValue({ ok: false, status, json: async () => ({}) } as Response);
    const { container } = render(<DeviceVendorUpdatesSection deviceId={DEVICE_ID} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('vendor-updates-loading')).toBeNull());
    expect(container).toBeEmptyDOMElement();
  });

  it('a failed history read leaves the last run on screen and says so', async () => {
    fetchMock.mockImplementation(async (path: string) =>
      path.includes('/oem-updates/status')
        ? ok(statusBody())
        : ({ ok: false, status: 500, json: async () => ({}) } as Response));
    render(<DeviceVendorUpdatesSection deviceId={DEVICE_ID} />);
    const root = await section();
    expect(within(root).getByTestId('vendor-updates-last-run')).toBeInTheDocument();
    expect(await within(root).findByTestId('vendor-updates-history-error')).toBeInTheDocument();
  });

  it('refresh reads the state again', async () => {
    answer(statusBody({ displayState: 'waiting_for_reboot' }), { runs: [], total: 0 });
    render(<DeviceVendorUpdatesSection deviceId={DEVICE_ID} />);
    const root = await section();
    answer(statusBody({ displayState: 'reboot_overdue' }), { runs: [], total: 0 });
    await userEvent.click(within(root).getByTestId('vendor-updates-refresh'));
    await waitFor(() =>
      expect(within(root).getByTestId('vendor-updates-state').getAttribute('data-state')).toBe('reboot_overdue'));
  });
});
