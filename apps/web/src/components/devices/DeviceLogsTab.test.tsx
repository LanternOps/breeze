import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import DeviceLogsTab from './DeviceLogsTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function makeResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

describe('DeviceLogsTab', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    fetchWithAuthMock.mockResolvedValue(
      makeResponse({ data: [], pagination: { total: 0 } }),
    );
  });

  // #7158: the start/end datetime-local inputs had a sibling <label> that
  // was never linked via htmlFor, so they had no accessible name.
  it('links the start and end date labels to their inputs', async () => {
    render(<DeviceLogsTab deviceId="device-1" />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());

    expect(screen.getByLabelText('Start Date')).toBeInTheDocument();
    expect(screen.getByLabelText('End Date')).toBeInTheDocument();
  });
});
