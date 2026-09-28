import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import CommunicationIntegrations from './CommunicationIntegrations';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function makeResponse(payload: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

describe('CommunicationIntegrations', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    fetchWithAuthMock.mockResolvedValue(makeResponse({}, 404));
  });

  // #7158: the Slack default channel, Teams tenant/client/secret, and
  // Discord webhook URL inputs each had a sibling <label> that was never
  // linked via htmlFor, so they had no accessible name.
  it('links each channel field label to its input', async () => {
    render(<CommunicationIntegrations />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());

    expect(screen.getByLabelText('Default channel')).toBeInTheDocument();
    expect(screen.getByLabelText('Tenant ID')).toBeInTheDocument();
    expect(screen.getByLabelText('Client ID')).toBeInTheDocument();
    expect(screen.getByLabelText('Client secret')).toBeInTheDocument();
    expect(screen.getByLabelText('Webhook URL')).toBeInTheDocument();
  });
});
