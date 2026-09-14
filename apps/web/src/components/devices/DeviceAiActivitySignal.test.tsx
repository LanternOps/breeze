import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceAiActivitySignal from './DeviceAiActivitySignal';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const ISO = '2026-09-07T00:00:00.000Z';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

function mockAiActivity(data: { dispatchedActions: number; windowDays: number; since: string }) {
  fetchWithAuthMock.mockResolvedValue(jsonResponse({ data }));
}

function mockAiActivityError() {
  fetchWithAuthMock.mockResolvedValue(jsonResponse({}, false));
}

describe('DeviceAiActivitySignal (#5022 W02, spec OD-10 A)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the dispatched count with the window', async () => {
    mockAiActivity({ dispatchedActions: 3, windowDays: 7, since: ISO });
    render(<DeviceAiActivitySignal deviceId="dev-1" />);
    expect(await screen.findByTestId('device-ai-activity-signal')).toHaveTextContent('3');
    expect(screen.getByTestId('device-ai-activity-signal')).toHaveTextContent('7');
  });

  it('renders nothing when there is no recorded AI activity', async () => {
    mockAiActivity({ dispatchedActions: 0, windowDays: 7, since: ISO });
    render(<DeviceAiActivitySignal deviceId="dev-1" />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(screen.queryByTestId('device-ai-activity-signal')).toBeNull();
  });

  it('says "dispatched", never "completed", and never claims completeness', async () => {
    mockAiActivity({ dispatchedActions: 2, windowDays: 7, since: ISO });
    render(<DeviceAiActivitySignal deviceId="dev-1" />);
    const text = (await screen.findByTestId('device-ai-activity-signal')).textContent!;
    expect(text.toLowerCase()).toContain('dispatched');
    expect(text.toLowerCase()).not.toContain('completed');
    expect(text.toLowerCase()).not.toMatch(/\ball\b/);
  });

  it('renders nothing when the request fails — a signal is not worth a broken rail', async () => {
    mockAiActivityError();
    render(<DeviceAiActivitySignal deviceId="dev-1" />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(screen.queryByTestId('device-ai-activity-signal')).toBeNull();
  });
});
