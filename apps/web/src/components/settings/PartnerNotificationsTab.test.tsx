import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { InheritableNotificationSettings } from '@breeze/shared';
import { i18n } from '../../lib/i18n';

import PartnerNotificationsTab from './PartnerNotificationsTab';

const SAVED_PLACEHOLDER = () => i18n.t('settings:savedSecret.savedPlaceholder');

// Controlled like PartnerSettingsPage: the tab reports every change upward.
function Harness({ initial, onChange }: {
  initial: InheritableNotificationSettings;
  onChange: (d: InheritableNotificationSettings) => void;
}) {
  const [data, setData] = useState(initial);
  return (
    <PartnerNotificationsTab
      data={data}
      onChange={(next) => {
        setData(next);
        onChange(next);
      }}
    />
  );
}

// What GET /orgs/partners/me returns for saved channel secrets.
const saved: InheritableNotificationSettings = {
  slackWebhookUrl: '********',
  slackChannel: '#ops-alerts',
  pushoverAppToken: '********',
  pushoverDefaultUser: '********',
};

describe('PartnerNotificationsTab: saved channel secrets', () => {
  it.each([
    ['partner-notifications-slack-webhook'],
    ['partner-notifications-pushover-token'],
    ['partner-notifications-pushover-user'],
  ])('shows %s as saved without putting the marker in the field', (testId) => {
    render(<Harness initial={saved} onChange={vi.fn()} />);

    const input = screen.getByTestId(testId);
    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('placeholder', SAVED_PLACEHOLDER());
  });

  it('typing replaces the saved Slack URL, and erasing it keeps the saved one', () => {
    const onChange = vi.fn();
    render(<Harness initial={saved} onChange={onChange} />);
    const input = screen.getByTestId('partner-notifications-slack-webhook');

    fireEvent.change(input, { target: { value: 'https://hooks.slack.example/new' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ slackWebhookUrl: 'https://hooks.slack.example/new' }));

    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ slackWebhookUrl: '********' }));
  });

  it('removing the saved application token sends an explicit clear', () => {
    const onChange = vi.fn();
    render(<Harness initial={saved} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('partner-notifications-pushover-token-remove'));

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ pushoverAppToken: '' }));
    expect(screen.getByTestId('partner-notifications-pushover-token')).toHaveAttribute(
      'placeholder',
      i18n.t('settings:savedSecret.removedPlaceholder'),
    );
  });

  it('offers no remove control and the ordinary placeholder when nothing is saved', () => {
    render(<Harness initial={{}} onChange={vi.fn()} />);

    expect(screen.getByTestId('partner-notifications-slack-webhook'))
      .toHaveAttribute('placeholder', i18n.t('settings:partnerNotifications.notSet'));
    expect(screen.queryByTestId('partner-notifications-slack-webhook-remove')).toBeNull();
  });
});
