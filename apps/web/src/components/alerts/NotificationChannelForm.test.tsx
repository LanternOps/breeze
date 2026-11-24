import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../../lib/i18n';
import { describe, it, expect, vi } from 'vitest';
import NotificationChannelForm from './NotificationChannelForm';

async function fillNameAndSubmit(user: ReturnType<typeof userEvent.setup>, name = 'On-call email') {
  await user.type(screen.getByLabelText(/channel name/i), name);
  await user.click(screen.getByRole('button', { name: 'Save' }));
}

// #12148 — a new Email channel with only the blank recipient row used to save
// as "Active · No recipients" and could never deliver. Same rule as SMS.
describe('NotificationChannelForm — email recipients (#12148)', () => {
  it('shows a field error and does not submit when the only recipient row is blank', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<NotificationChannelForm onSubmit={onSubmit} submitLabel="Save" />);

    await fillNameAndSubmit(user);

    expect(await screen.findByText(/at least one email recipient is required/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('treats whitespace-only rows as blank', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<NotificationChannelForm onSubmit={onSubmit} submitLabel="Save" />);

    await user.type(screen.getByPlaceholderText('email@example.com'), '   ');
    await fillNameAndSubmit(user);

    expect(await screen.findByText(/at least one email recipient is required/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows a field error and does not submit when a recipient is not a valid address', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<NotificationChannelForm onSubmit={onSubmit} submitLabel="Save" />);

    await user.type(screen.getByPlaceholderText('email@example.com'), 'not-an-address');
    await fillNameAndSubmit(user);

    expect(await screen.findByText(/must be valid email addresses/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits when at least one valid address is present, ignoring an extra blank row', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<NotificationChannelForm onSubmit={onSubmit} submitLabel="Save" />);

    await user.click(screen.getByRole('button', { name: /add recipient/i }));
    await user.type(screen.getAllByPlaceholderText('email@example.com')[0], 'ops@example.com');
    await fillNameAndSubmit(user);

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/at least one email recipient is required/i)).not.toBeInTheDocument();
  });

  it('does not apply the email rule to other channel types', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <NotificationChannelForm
        onSubmit={onSubmit}
        submitLabel="Save"
        defaultValues={{ type: 'slack' }}
      />
    );

    await fillNameAndSubmit(user);

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/at least one email recipient is required/i)).not.toBeInTheDocument();
  });
});

// #12549: the SMS error is filed on the array, which react-hook-form keeps under
// `.root`, so the form used to block the save without saying why.
describe('NotificationChannelForm: SMS phone numbers (#12549)', () => {
  function renderSms(onSubmit = vi.fn()) {
    render(<NotificationChannelForm onSubmit={onSubmit} submitLabel="Save" defaultValues={{ type: 'sms' }} />);
    return onSubmit;
  }

  it('shows an error and does not submit when the only phone number row is blank', async () => {
    const user = userEvent.setup();
    const onSubmit = renderSms();

    await fillNameAndSubmit(user, 'On-call SMS');

    expect(await screen.findByText(/at least one phone number is required/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows an error and does not submit when a phone number is not E.164', async () => {
    const user = userEvent.setup();
    const onSubmit = renderSms();

    await user.type(screen.getAllByPlaceholderText('+1234567890')[0], '12345');
    await fillNameAndSubmit(user, 'On-call SMS');

    expect(await screen.findByText(/all sms phone numbers must use e\.164 format/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits when the phone number is valid', async () => {
    const user = userEvent.setup();
    const onSubmit = renderSms();

    await user.type(screen.getAllByPlaceholderText('+1234567890')[0], '+15555550100');
    await fillNameAndSubmit(user, 'On-call SMS');

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });
});
