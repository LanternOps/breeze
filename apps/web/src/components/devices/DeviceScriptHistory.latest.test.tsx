import '@/lib/i18n';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));

vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const { default: DeviceScriptHistory } = await import('./DeviceScriptHistory');

const DEVICE_ID = 'device-1';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// API order is newest-first, but the grouping must not depend on it.
const rows = [
  {
    id: 'inv-new', scriptId: 'script-inv', scriptName: 'Collect Inventory', status: 'failed',
    stdout: 'step 1\nstep 2 failed: disk offline', stderr: '', errorMessage: 'boom',
    startedAt: '2026-02-10T00:00:00.000Z', completedAt: '2026-02-10T00:00:05.000Z',
  },
  {
    id: 'onb-1', scriptId: 'script-onb', scriptName: 'Onboarding', status: 'completed',
    stdout: 'all good', startedAt: '2026-02-09T00:00:00.000Z', completedAt: '2026-02-09T00:00:02.000Z',
  },
  {
    id: 'inv-old', scriptId: 'script-inv', scriptName: 'Collect Inventory', status: 'completed',
    stdout: 'old run ok', startedAt: '2026-02-08T00:00:00.000Z', completedAt: '2026-02-08T00:00:03.000Z',
  },
];

function mockHistory(data: Array<Record<string, unknown>> = rows) {
  fetchWithAuthMock.mockImplementation(async (input: string) => {
    if (String(input) === `/devices/${DEVICE_ID}/scripts`) return jsonResponse({ data });
    return jsonResponse({}, 404);
  });
}

async function renderTab(props: { highlightExecutionId?: string } = {}) {
  render(<DeviceScriptHistory deviceId={DEVICE_ID} timezone="UTC" {...props} />);
  await waitFor(() => expect(screen.queryByText(/Loading script history/i)).toBeNull());
}

describe('DeviceScriptHistory per-script latest-result view (#7413)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    mockHistory();
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('defaults to one row per script showing its newest status and output excerpt', async () => {
    await renderTab();

    const inv = screen.getByTestId('device-script-latest-row-script-inv');
    expect(within(inv).getByText('Collect Inventory')).toBeTruthy();
    expect(within(inv).getByTestId('device-script-latest-status-script-inv').textContent).toMatch(/failed/i);
    expect(screen.getByTestId('device-script-latest-excerpt-script-inv').textContent).toBe('step 2 failed: disk offline');

    const onb = screen.getByTestId('device-script-latest-row-script-onb');
    expect(within(onb).getByTestId('device-script-latest-status-script-onb').textContent).toMatch(/completed/i);

    // one row per script, not per execution
    expect(screen.getAllByTestId(/^device-script-latest-row-/)).toHaveLength(2);
    expect(screen.queryByTestId('device-script-history-row-inv-old')).toBeNull();
  });

  it('expands a script into its full run history and opens a run from it', async () => {
    await renderTab();

    fireEvent.click(screen.getByTestId('device-script-latest-toggle-script-inv'));

    expect(screen.getByTestId('device-script-history-row-inv-new')).toBeTruthy();
    expect(screen.getByTestId('device-script-history-row-inv-old')).toBeTruthy();
    expect(screen.queryByTestId('device-script-history-row-onb-1')).toBeNull();

    fireEvent.click(screen.getByTestId('device-script-history-row-inv-old'));
    expect(await screen.findByText('old run ok')).toBeTruthy();

    fireEvent.click(screen.getByTestId('device-script-latest-toggle-script-inv'));
    expect(screen.queryByTestId('device-script-history-row-inv-new')).toBeNull();
  });

  it('keeps the chronological view as a second view, toggled through the hash', async () => {
    await renderTab();

    fireEvent.click(screen.getByTestId('device-scripts-view-all'));

    await waitFor(() => expect(window.location.hash).toBe('#scripts/view=all'));
    expect(screen.queryByTestId(/^device-script-latest-row-/)).toBeNull();
    expect(screen.getByTestId('device-execution-status-inv-new')).toBeTruthy();
    expect(screen.getByTestId('device-execution-status-onb-1')).toBeTruthy();
    expect(screen.getByTestId('device-execution-status-inv-old')).toBeTruthy();

    fireEvent.click(screen.getByTestId('device-scripts-view-latest'));
    await waitFor(() => expect(window.location.hash).toBe('#scripts/view=latest'));
    expect(screen.getAllByTestId(/^device-script-latest-row-/)).toHaveLength(2);
  });

  it('opens straight into the chronological view for #scripts/view=all', async () => {
    window.location.hash = '#scripts/view=all';
    await renderTab();
    expect(screen.queryByTestId(/^device-script-latest-row-/)).toBeNull();
    expect(screen.getByTestId('device-execution-status-inv-old')).toBeTruthy();
  });

  it('shows the chronological view when a post-run redirect highlights an execution', async () => {
    await renderTab({ highlightExecutionId: 'inv-old' });
    expect(screen.getByTestId('device-execution-status-inv-old')).toBeTruthy();
  });

  it('groups runs without a scriptId by script name', async () => {
    mockHistory([
      { id: 'a', scriptName: 'Adhoc', status: 'completed', stdout: 'first', startedAt: '2026-02-01T00:00:00.000Z' },
      { id: 'b', scriptName: 'Adhoc', status: 'completed', stdout: 'second', startedAt: '2026-02-02T00:00:00.000Z' },
    ]);
    await renderTab();
    expect(screen.getAllByTestId(/^device-script-latest-row-/)).toHaveLength(1);
    expect(screen.getByTestId(/^device-script-latest-excerpt-/).textContent).toBe('second');
  });
});
