import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { i18n, loadLocale } from '@/lib/i18n';
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

  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage('en');
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

  it('renders the panel title as an h2 under the page h1', async () => {
    render(<CommunicationIntegrations />);

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Communication integrations' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('explains why Connect workspace is disabled until Slack is turned on', async () => {
    render(<CommunicationIntegrations />);

    const connect = await screen.findByRole('button', { name: /Connect workspace/ });
    expect(connect).toBeDisabled();
    const helper = screen.getByText('Turn on Slack notifications to connect a workspace.');
    expect(helper.id).toBeTruthy();
    expect(connect).toHaveAttribute('aria-describedby', helper.id);

    fireEvent.click(screen.getAllByLabelText('Enabled')[0]);

    expect(connect).toBeEnabled();
    expect(connect).not.toHaveAttribute('aria-describedby');
    expect(
      screen.queryByText('Turn on Slack notifications to connect a workspace.'),
    ).not.toBeInTheDocument();
  });

  it('localizes the unconnected Slack workspace placeholders', async () => {
    await loadLocale('de-DE');
    await i18n.changeLanguage('de-DE');

    render(<CommunicationIntegrations />);

    expect(await screen.findByText('Nicht verbunden')).toBeInTheDocument();
    expect(screen.queryByText('Not connected')).not.toBeInTheDocument();
    expect(screen.queryByText(/Pending connection/)).not.toBeInTheDocument();
  });
});
