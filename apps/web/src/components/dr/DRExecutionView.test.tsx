import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DRExecutionView from './DRExecutionView';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
}));

vi.mock('../shared/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('DRExecutionView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders halt reason and per-device failure detail', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/dr/executions/execution-1') {
        return makeJsonResponse({
          data: {
            id: 'execution-1',
            executionType: 'failover',
            status: 'failed',
            startedAt: '2026-03-31T10:00:00.000Z',
            completedAt: '2026-03-31T10:10:00.000Z',
            initiatedBy: 'user-1',
            createdAt: '2026-03-31T10:00:00.000Z',
            plan: { id: 'plan-1', name: 'Primary Site Failover' },
            groups: [
              { id: 'group-1', name: 'Tier 1', sequence: 0, devices: ['device-1'], estimatedDurationMinutes: 10 },
            ],
            results: {
              haltReason: 'Group Tier 1 failed',
              groupResults: [
                {
                  groupId: 'group-1',
                  status: 'failed',
                  devices: [{ deviceId: 'device-1', status: 'failed', error: 'VM restore target is offline' }],
                },
              ],
            },
          },
        });
      }
      if (url.startsWith('/devices/options?')) {
        return makeJsonResponse({
          data: [{ id: 'device-1', hostname: 'srv-01', displayName: null, osType: 'windows', status: 'online', siteId: null, siteName: null }],
          page: { nextCursor: null, returned: 1, total: 1, hasMore: false, observedAt: '2026-08-24T00:00:00.000Z' },
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<DRExecutionView open executionId="execution-1" onClose={() => {}} />);

    expect(await screen.findByText('Group Tier 1 failed')).toBeTruthy();
    expect(screen.getByText('VM restore target is offline')).toBeTruthy();
    expect(await screen.findByText('srv-01')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => /^\/devices(?:\?|$)/.test(String(input)))).toBe(false);
  });
});

describe('DRExecutionView bare-metal recoveries', () => {
  const makeExecution = (device: Record<string, unknown>, status = 'running') => ({
    data: {
      id: 'execution-2',
      executionType: 'failover',
      status,
      startedAt: '2026-03-31T10:00:00.000Z',
      completedAt: null,
      initiatedBy: 'user-1',
      createdAt: '2026-03-31T10:00:00.000Z',
      plan: { id: 'plan-1', name: 'Primary Site Failover' },
      groups: [
        { id: 'group-1', name: 'Tier 1', sequence: 0, devices: ['device-1'], estimatedDurationMinutes: 10 },
      ],
      results: {
        groupResults: [
          { groupId: 'group-1', status: 'running', devices: [{ deviceId: 'device-1', status: 'running', ...device }] },
        ],
      },
    },
  });

  const devicesPayload = {
    data: [{ id: 'device-1', hostname: 'srv-01', displayName: null, osType: 'linux', status: 'online', siteId: null, siteName: null }],
    page: { nextCursor: null, returned: 1, total: 1, hasMore: false, observedAt: '2026-08-24T00:00:00.000Z' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('shows the recovery status chip and reissues a code once through the reissue endpoint', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url === '/dr/executions/execution-2') return makeJsonResponse(makeExecution({ recoveryId: 'rec-1', recoveryStatus: 'media_booted' }));
      if (url.startsWith('/devices/options?')) return makeJsonResponse(devicesPayload);
      if (url === '/backup/bmr/recoveries/rec-1/reissue-code' && method === 'POST') {
        return makeJsonResponse({ id: 'rec-1', status: 'media_booted', code: 'ABC-DEF-GHJ' });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<DRExecutionView open executionId="execution-2" onClose={() => {}} />);

    const chip = await screen.findByTestId('dr-device-recovery-status');
    expect(chip.textContent).toContain('Media booted');
    expect(screen.queryByTestId('dr-device-recovery-code')).toBeNull();

    fireEvent.click(screen.getByTestId('dr-device-reissue-code'));

    const code = await screen.findByTestId('dr-device-recovery-code');
    expect(code.textContent).toContain('ABC-DEF-GHJ');
    const reissueCall = fetchMock.mock.calls.find(([url]) => String(url) === '/backup/bmr/recoveries/rec-1/reissue-code');
    expect((reissueCall![1] as RequestInit).method).toBe('POST');

    fireEvent.click(screen.getByTestId('dr-device-recovery-code-copy'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('ABC-DEF-GHJ'));
    expect(screen.getByTestId('dr-device-cancel-recovery')).toBeInTheDocument();
  });

  it('shows no reissue or cancel button once the device has checked in', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/dr/executions/execution-2') return makeJsonResponse(makeExecution({ recoveryId: 'rec-1', recoveryStatus: 'checked_in' }));
      if (url.startsWith('/devices/options?')) return makeJsonResponse(devicesPayload);
      return makeJsonResponse({}, false, 404);
    });

    render(<DRExecutionView open executionId="execution-2" onClose={() => {}} />);

    const chip = await screen.findByTestId('dr-device-recovery-status');
    expect(chip.textContent).toContain('Checked in');
    expect(screen.queryByTestId('dr-device-reissue-code')).toBeNull();
    // checked_in is terminal on the server (BARE_METAL_RECOVERY_TERMINAL): nothing left to cancel.
    expect(screen.queryByTestId('dr-device-cancel-recovery')).toBeNull();
  });

  it('shows neither reissue nor cancel for terminal recoveries and surfaces the reason', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/dr/executions/execution-2') {
        return makeJsonResponse(makeExecution({ recoveryId: 'rec-1', recoveryStatus: 'failed', reason: 'timeout' }, 'failed'));
      }
      if (url.startsWith('/devices/options?')) return makeJsonResponse(devicesPayload);
      return makeJsonResponse({}, false, 404);
    });

    render(<DRExecutionView open executionId="execution-2" onClose={() => {}} />);

    await screen.findByTestId('dr-device-recovery-status');
    expect(screen.queryByTestId('dr-device-reissue-code')).toBeNull();
    expect(screen.queryByTestId('dr-device-cancel-recovery')).toBeNull();
    expect(screen.getByText('timeout')).toBeInTheDocument();
  });

  it('cancels a non-terminal recovery through the cancel endpoint and refreshes', async () => {
    let cancelled = false;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url === '/dr/executions/execution-2') {
        return makeJsonResponse(makeExecution(cancelled ? { recoveryId: 'rec-1', recoveryStatus: 'failed' } : { recoveryId: 'rec-1', recoveryStatus: 'created' }));
      }
      if (url.startsWith('/devices/options?')) return makeJsonResponse(devicesPayload);
      if (url === '/backup/bmr/recoveries/rec-1/cancel' && method === 'POST') {
        cancelled = true;
        return makeJsonResponse({ id: 'rec-1', status: 'failed' });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<DRExecutionView open executionId="execution-2" onClose={() => {}} />);

    fireEvent.click(await screen.findByTestId('dr-device-cancel-recovery'));
    await waitFor(() => expect(screen.queryByTestId('dr-device-cancel-recovery')).toBeNull());
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/backup/bmr/recoveries/rec-1/cancel')).toBe(true);
  });
});
