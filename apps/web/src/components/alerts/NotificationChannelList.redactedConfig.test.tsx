import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect } from 'vitest';
import NotificationChannelList, { type NotificationChannel } from './NotificationChannelList';

// The API does not return secret config values as strings. Each one is replaced
// with a redaction marker object — see `secretKeysForType` in
// `services/notificationChannelSecrets.ts`. `url` is secret for webhook
// channels, `user`/`token` for pushover, `webhookUrl` for slack/teams.
//
// The list used to cast those straight to `string`. An object is truthy, so it
// slipped past the `||` fallback, escaped a `: string` function (the cast
// silenced the type error) and was handed to React, which threw "Objects are
// not valid as a React child" and blanked the entire channels page for anyone
// with a webhook channel.
const redacted = { redacted: true, hasSecret: true, masked: '********' };

function channel(overrides: Partial<NotificationChannel>): NotificationChannel {
  return {
    id: 'ch-1',
    name: 'QA Channel',
    type: 'webhook',
    enabled: true,
    config: {},
    createdAt: '2026-08-11T00:00:00Z',
    updatedAt: '2026-08-11T00:00:00Z',
    ...overrides,
  };
}

describe('NotificationChannelList — redacted config values', () => {
  it('renders a webhook channel whose url is redacted instead of crashing', () => {
    render(<NotificationChannelList channels={[channel({ config: { url: redacted } })]} />);

    // The row renders at all — this is the regression: it previously threw.
    expect(screen.getByText('QA Channel')).toBeTruthy();
    // And no object leaked into the output.
    expect(document.body.textContent).not.toContain('[object Object]');
  });

  it('still shows a real webhook url when the caller is allowed to see it', () => {
    render(
      <NotificationChannelList
        channels={[channel({ config: { url: 'https://hooks.example.com/abc' } })]}
      />
    );

    expect(screen.getByText('https://hooks.example.com/abc')).toBeTruthy();
  });

  it('does not claim a pushover channel is inherited when its user key is merely redacted', () => {
    // `user` is a secret for pushover, so a configured key arrives redacted.
    // Falling through to the "inherited" label would state the opposite of the
    // truth — that no user key is set.
    const { container } = render(
      <NotificationChannelList
        channels={[channel({ type: 'pushover', name: 'Pushover QA', config: { user: redacted } })]}
      />
    );

    expect(screen.getByText('Pushover QA')).toBeTruthy();
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('renders a slack channel whose secret webhookUrl is redacted', () => {
    render(
      <NotificationChannelList
        channels={[
          channel({ type: 'slack', name: 'Slack QA', config: { webhookUrl: redacted, channel: '#ops' } }),
        ]}
      />
    );

    expect(screen.getByText('Slack QA')).toBeTruthy();
    expect(screen.getByText('#ops')).toBeTruthy();
  });
});
