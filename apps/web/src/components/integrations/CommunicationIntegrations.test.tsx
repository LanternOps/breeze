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

  // #12054: the test button reported "queued" for a dispatch that never
  // happened, and replaced the API's failure reason with a generic string.
  async function clickDiscordTest() {
    render(<CommunicationIntegrations />);
    await screen.findByLabelText('Webhook URL');
    const enabledToggles = screen.getAllByLabelText('Enabled');
    fireEvent.click(enabledToggles[enabledToggles.length - 1]);
    expect(screen.getByLabelText('Webhook URL')).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Webhook URL'), {
      target: { value: 'https://discord.com/api/webhooks/1/token' },
    });
    const testButtons = screen.getAllByRole('button', { name: 'Test notification' });
    const discordTest = testButtons[testButtons.length - 1];
    expect(discordTest).toBeEnabled();
    fireEvent.click(discordTest);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
  }

  it('reports a delivered Discord test as sent, not queued', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeResponse({}, 404));
    fetchWithAuthMock.mockResolvedValueOnce(
      makeResponse({ success: true, message: 'Discord test notification sent.' }),
    );

    await clickDiscordTest();

    expect(await screen.findByText('Discord test notification sent.')).toBeInTheDocument();
    expect(screen.queryByText(/queued/i)).not.toBeInTheDocument();
    const [endpoint, init] = fetchWithAuthMock.mock.calls[1]!;
    expect(endpoint).toBe('/integrations/discord');
    expect(JSON.parse(String(init?.body))).toMatchObject({ test: true });
  });

  it('shows the API reason when the Discord test fails', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeResponse({}, 404));
    fetchWithAuthMock.mockResolvedValueOnce(
      makeResponse({ success: false, error: 'Discord rejected the webhook (HTTP 404)' }, 400),
    );

    await clickDiscordTest();

    expect(await screen.findByText('Discord rejected the webhook (HTTP 404)')).toBeInTheDocument();
  });
});
