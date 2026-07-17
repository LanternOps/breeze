import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi } from 'vitest';
import ApiKeyForm from './ApiKeyForm';

const noop = () => {};

function fillNameAndScopes() {
  fireEvent.change(screen.getByPlaceholderText('My API Key'), { target: { value: 'CI key' } });
  fireEvent.click(screen.getByText('Select all'));
}

describe('ApiKeyForm — fleet-view org picker', () => {
  it('shows the org selector when organizations are provided (fleet view, no org context)', () => {
    render(
      <ApiKeyForm
        isOpen
        onSubmit={vi.fn()}
        onCancel={noop}
        organizations={[{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Beta' }]}
      />,
    );
    expect(screen.getByTestId('api-key-org-select')).toBeTruthy();
  });

  it('blocks submit with an error when no org is picked, instead of posting an org-less key', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ApiKeyForm
        isOpen
        onSubmit={onSubmit}
        onCancel={noop}
        organizations={[{ id: 'org-1', name: 'Acme' }]}
      />,
    );
    fillNameAndScopes();
    fireEvent.click(screen.getByText('Create Key'));

    await waitFor(() =>
      expect(screen.getByText('Pick the organization this key belongs to')).toBeTruthy(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits with the chosen orgId once an org is selected', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ApiKeyForm
        isOpen
        onSubmit={onSubmit}
        onCancel={noop}
        organizations={[{ id: 'org-1', name: 'Acme' }]}
      />,
    );
    fillNameAndScopes();
    fireEvent.change(screen.getByTestId('api-key-org-select'), { target: { value: 'org-1' } });
    fireEvent.click(screen.getByText('Create Key'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ orgId: 'org-1', name: 'CI key' });
  });

  it('omits the org selector (and orgId) when an org is already in context', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeyForm isOpen onSubmit={onSubmit} onCancel={noop} />);
    expect(screen.queryByTestId('api-key-org-select')).toBeNull();

    fillNameAndScopes();
    fireEvent.click(screen.getByText('Create Key'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('orgId');
  });
});
