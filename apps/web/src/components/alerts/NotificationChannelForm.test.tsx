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
