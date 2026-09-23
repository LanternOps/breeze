import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../../lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotificationChannel } from '../NotificationChannelList';

const runChannelSave = vi.fn();
vi.mock('./deliveryActions', () => ({
  runChannelSave: (...args: unknown[]) => runChannelSave(...args),
  runChannelDelete: vi.fn(),
  runChannelTest: vi.fn(),
}));

import ChannelsSection from './ChannelsSection';

// #4983. The API never returns a stored channel secret. Each secret config key
// (webhook `url`/`authPassword`/`authToken`, every header value, slack/teams
// `webhookUrl`, pagerduty `integrationKey`, pushover `token`/`user`) comes back
// as a redaction marker object. The edit form used to copy those objects into
// its string fields: the inputs showed "[object Object]", zod rejected the
// object on submit so Save silently did nothing, and a header value was
// stringified to a literal "[object Object]" that would overwrite the real one.
// Once a channel had credentials saved, it could no longer be administered.
const redacted = { redacted: true, hasSecret: true, masked: '********' };
const redactedEmpty = { redacted: true, hasSecret: false, masked: '********' };

function channel(overrides: Partial<NotificationChannel>): NotificationChannel {
  return {
    id: 'ch-1',
    name: 'Alert relay',
    type: 'webhook',
    enabled: true,
    config: {},
    createdAt: '2026-08-11T00:00:00Z',
    updatedAt: '2026-08-11T00:00:00Z',
    ...overrides,
  };
}

function renderSection(channels: NotificationChannel[]) {
  return render(
    <ChannelsSection
      channels={channels}
      currentOrgId="org-1"
      isPartnerScope={false}
      defaultOwnerScope="organization"
      onChanged={async () => {}}
      onUnauthorized={() => {}}
    />
  );
}

async function openEditAndSave() {
  fireEvent.click(screen.getByTitle(/edit/i));
  const inputs = Array.from(document.querySelectorAll('input, textarea')) as HTMLInputElement[];
  expect(inputs.map((input) => input.value)).not.toContain('[object Object]');
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
  await waitFor(() => expect(runChannelSave).toHaveBeenCalledTimes(1));
  return runChannelSave.mock.calls[0]![0] as { method: string; payload: { config: Record<string, unknown> } };
}

describe('ChannelsSection — editing a channel whose secrets come back redacted (#4983)', () => {
  beforeEach(() => {
    runChannelSave.mockReset();
    runChannelSave.mockResolvedValue(undefined);
  });

  it('round-trips a basic-auth webhook channel as masked secrets instead of objects', async () => {
    renderSection([
      channel({
        config: {
          url: redacted,
          method: 'POST',
          headers: { 'X-Api-Key': redacted },
          authType: 'basic',
          authUsername: 'relay-user',
          authPassword: redacted,
          authToken: redactedEmpty,
        },
      }),
    ]);

    const call = await openEditAndSave();

    expect(call.method).toBe('PUT');
    expect(call.payload.config).toMatchObject({
      url: '********',
      method: 'POST',
      headers: { 'X-Api-Key': '********' },
      authType: 'basic',
      authUsername: 'relay-user',
      authPassword: '********',
      authToken: '',
    });
  });

  it('round-trips a slack channel whose webhook url is redacted', async () => {
    renderSection([channel({ type: 'slack', config: { webhookUrl: redacted, channel: '#alerts' } })]);
    const call = await openEditAndSave();
    expect(call.payload.config).toMatchObject({ webhookUrl: '********', channel: '#alerts' });
  });

  it('round-trips a pushover channel whose user and token are redacted', async () => {
    renderSection([channel({ type: 'pushover', config: { user: redacted, token: redacted } })]);
    const call = await openEditAndSave();
    expect(call.payload.config).toMatchObject({ user: '********', token: '********' });
  });

  it('still pre-fills plaintext values unchanged', async () => {
    renderSection([
      channel({
        config: {
          url: 'https://hooks.example.com/alerts',
          method: 'PUT',
          headers: { 'X-Trace': 'abc' },
          authType: 'none',
        },
      }),
    ]);
    const call = await openEditAndSave();
    expect(call.payload.config).toMatchObject({
      url: 'https://hooks.example.com/alerts',
      method: 'PUT',
      headers: { 'X-Trace': 'abc' },
    });
  });
});
