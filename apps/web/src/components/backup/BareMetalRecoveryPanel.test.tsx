import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import BareMetalRecoveryPanel from './BareMetalRecoveryPanel';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const SNAPSHOT_ID = 'snapshot-1';
const RECOVERY_ID = 'recovery-1';

// Fake timers are required to deterministically test the 10s poll interval,
// which also means testing-library's waitFor (setTimeout-based retries)
// cannot be used — flush() replaces it, matching the pattern already used by
// OrganizationsPage.merge.test.tsx in this codebase.
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BareMetalRecoveryPanel', () => {
  it('creates a recovery and shows the formatted code', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url.startsWith('/backup/snapshots?') && method === 'GET') {
        return makeJsonResponse({ data: [{ id: SNAPSHOT_ID, deviceId: 'device-1', label: 'Nightly Snapshot', createdAt: '2026-03-28T10:00:00Z' }] });
      }
      if (url.startsWith('/backup/bmr/recoveries?') && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }
      if (url.startsWith('/backup/bmr/recoveries?') && method === 'POST') {
        return makeJsonResponse({
          id: RECOVERY_ID, deviceId: 'device-1', snapshotId: SNAPSHOT_ID, identity: 'original',
          status: 'created', overdue: false, codeExpiresAt: '2026-03-28T10:15:00Z', failureReason: null,
          code: 'ABC-DEF-GHJ',
        }, true, 201);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<BareMetalRecoveryPanel />);
    await flush();

    fireEvent.change(screen.getByLabelText('Snapshot'), { target: { value: SNAPSHOT_ID } });
    fireEvent.click(screen.getByText('Create recovery code'));
    await flush();

    expect(screen.getByTestId('bare-metal-recovery-code')).toHaveTextContent('ABC-DEF-GHJ');
  });

  it("renders a refused create's reasons", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url.startsWith('/backup/snapshots?') && method === 'GET') {
        return makeJsonResponse({ data: [{ id: SNAPSHOT_ID, deviceId: 'device-1', label: 'Nightly Snapshot', createdAt: '2026-03-28T10:00:00Z' }] });
      }
      if (url.startsWith('/backup/bmr/recoveries?') && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }
      if (url.startsWith('/backup/bmr/recoveries?') && method === 'POST') {
        return makeJsonResponse({ error: 'snapshot_not_bare_metal_restorable', reasons: ['LVM volumes are not supported'] }, false, 409);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<BareMetalRecoveryPanel />);
    await flush();

    fireEvent.change(screen.getByLabelText('Snapshot'), { target: { value: SNAPSHOT_ID } });
    fireEvent.click(screen.getByText('Create recovery code'));
    await flush();

    expect(screen.getByText('LVM volumes are not supported')).toBeInTheDocument();
  });

  it("timeline reflects status: 'restoring'", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url.startsWith('/backup/snapshots?') && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }
      if (url.startsWith('/backup/bmr/recoveries?') && method === 'GET' && url.includes('limit=20')) {
        return makeJsonResponse({
          data: [{
            id: RECOVERY_ID, deviceId: 'device-1', snapshotId: SNAPSHOT_ID, identity: 'original',
            status: 'restoring', overdue: false, codeExpiresAt: '2026-03-28T10:15:00Z', failureReason: null,
          }],
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<BareMetalRecoveryPanel />);
    await flush();

    expect(screen.getByTestId('bare-metal-recovery-timeline-restoring')).toHaveClass('border-primary');
    expect(screen.getByTestId('bare-metal-recovery-timeline-validated')).not.toHaveClass('border-primary');
  });

  it('overdue: true shows the amber notice', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url.startsWith('/backup/snapshots?') && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }
      if (url.startsWith('/backup/bmr/recoveries?') && method === 'GET' && url.includes('limit=20')) {
        return makeJsonResponse({
          data: [{
            id: RECOVERY_ID, deviceId: 'device-1', snapshotId: SNAPSHOT_ID, identity: 'original',
            status: 'rebooted', overdue: true, codeExpiresAt: '2026-03-28T10:15:00Z', failureReason: null,
          }],
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<BareMetalRecoveryPanel />);
    await flush();

    expect(screen.getByTestId('bare-metal-recovery-overdue-notice')).toBeInTheDocument();
  });

  it('terminal checked_in stops polling', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url.startsWith('/backup/snapshots?') && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }
      if (url.startsWith('/backup/bmr/recoveries?') && method === 'GET' && url.includes('limit=20')) {
        return makeJsonResponse({
          data: [{
            id: RECOVERY_ID, deviceId: 'device-1', snapshotId: SNAPSHOT_ID, identity: 'original',
            status: 'checked_in', overdue: false, codeExpiresAt: '2026-03-28T10:15:00Z', failureReason: null,
          }],
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<BareMetalRecoveryPanel />);
    await flush();
    await flush();
    expect(screen.getByTestId('bare-metal-recovery-status')).toBeInTheDocument();

    const callCountAfterLoad = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock.mock.calls.length).toBe(callCountAfterLoad);
  });
});
