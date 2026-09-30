import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { i18n } from '../../lib/i18n';

import OrgNotificationSettings from './OrgNotificationSettings';

// What GET /orgs/organizations/:id returns for saved channel secrets.
const savedNotifications = {
  slackWebhookUrl: '********',
  slackChannel: '#ops-alerts',
  webhooks: ['********', '********'],
};

function save() {
  fireEvent.click(screen.getByText(i18n.t('settings:orgNotificationSettings.save')));
}

describe('OrgNotificationSettings: saved channel secrets', () => {
  it('keeps a saved Slack URL out of the field and sends the marker back to keep it', () => {
    const onSave = vi.fn();
    render(<OrgNotificationSettings notifications={savedNotifications} onSave={onSave} />);

    const input = screen.getByTestId('org-notifications-slack-webhook');
    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('placeholder', i18n.t('settings:savedSecret.savedPlaceholder'));

    save();
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ slackWebhookUrl: '********' }));
  });

  it('shows the Slack field as unset once a removal has been saved', () => {
    const onSave = vi.fn();
    const { rerender } = render(<OrgNotificationSettings notifications={savedNotifications} onSave={onSave} />);

    fireEvent.click(screen.getByTestId('org-notifications-slack-webhook-remove'));
    save();
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ slackWebhookUrl: '' }));

    rerender(<OrgNotificationSettings notifications={{ ...savedNotifications, slackWebhookUrl: '' }} onSave={onSave} />);

    const input = screen.getByTestId('org-notifications-slack-webhook');
    expect(input).not.toHaveAttribute('placeholder', i18n.t('settings:savedSecret.removedPlaceholder'));
    expect(input).not.toHaveAttribute('placeholder', i18n.t('settings:savedSecret.savedPlaceholder'));
  });

  it('sends a typed Slack URL in place of the saved one', () => {
    const onSave = vi.fn();
    render(<OrgNotificationSettings notifications={savedNotifications} onSave={onSave} />);

    fireEvent.change(screen.getByTestId('org-notifications-slack-webhook'), {
      target: { value: 'https://hooks.slack.example/new' },
    });
    save();

    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ slackWebhookUrl: 'https://hooks.slack.example/new' }));
  });

  it('lists saved webhooks without their URLs, and removing one keeps the others in place', () => {
    const onSave = vi.fn();
    render(<OrgNotificationSettings notifications={savedNotifications} onSave={onSave} />);

    const rows = screen.getAllByTestId('org-notifications-webhook-saved');
    expect(rows).toHaveLength(2);
    expect(screen.queryByText('********')).toBeNull();

    fireEvent.click(screen.getAllByTestId('org-notifications-webhook-remove')[0]!);
    expect(screen.getAllByTestId('org-notifications-webhook-saved')).toHaveLength(1);

    fireEvent.change(screen.getByTestId('org-notifications-webhook-new'), {
      target: { value: 'https://hooks.example.com/new' },
    });
    fireEvent.click(screen.getByTestId('org-notifications-webhook-add'));
    save();

    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({
      webhooks: ['', '********', 'https://hooks.example.com/new'],
    }));
  });

  it('picks up the saved list after a save, so a second save does not replay removals by stale position', () => {
    const onSave = vi.fn();
    const { rerender } = render(<OrgNotificationSettings notifications={savedNotifications} onSave={onSave} />);

    fireEvent.click(screen.getAllByTestId('org-notifications-webhook-remove')[0]!);
    save();
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ webhooks: ['', '********'] }));

    // The page re-reads the org after saving: one saved webhook remains.
    rerender(<OrgNotificationSettings notifications={{ ...savedNotifications, webhooks: ['********'] }} onSave={onSave} />);
    save();

    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ webhooks: ['********'] }));
    expect(screen.getAllByTestId('org-notifications-webhook-saved')).toHaveLength(1);
  });

  it('removes a webhook added in this session outright', () => {
    const onSave = vi.fn();
    render(<OrgNotificationSettings notifications={{ webhooks: [] }} onSave={onSave} />);

    fireEvent.change(screen.getByTestId('org-notifications-webhook-new'), { target: { value: 'https://a.example' } });
    fireEvent.click(screen.getByTestId('org-notifications-webhook-add'));
    fireEvent.change(screen.getByTestId('org-notifications-webhook-new'), { target: { value: 'https://b.example' } });
    fireEvent.click(screen.getByTestId('org-notifications-webhook-add'));
    fireEvent.click(screen.getAllByTestId('org-notifications-webhook-remove')[0]!);
    save();

    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ webhooks: ['https://b.example'] }));
  });

  it('leaves partner-managed Slack and webhook fields out of the save', () => {
    const onSave = vi.fn();
    render(
      <OrgNotificationSettings
        notifications={savedNotifications}
        onSave={onSave}
        locked={['notifications.slackWebhookUrl', 'notifications.webhooks']}
      />,
    );

    expect(screen.getByTestId('org-notifications-slack-webhook')).toBeDisabled();
    save();

    const payload = onSave.mock.calls.at(-1)![0];
    expect(payload).not.toHaveProperty('slackWebhookUrl');
    expect(payload).not.toHaveProperty('webhooks');
  });
});
