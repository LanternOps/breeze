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

describe('ApiKeyForm — MCP tool domains (#6156)', () => {
  const checkScope = (name: RegExp) => {
    const box = screen.getByText(name).closest('label')!.querySelector('input')!;
    fireEvent.click(box);
  };
  const AI_READ = /^AI: Read$/;
  const DEVICES_READ = /^Devices: Read$/;

  it('picker hidden without ai:* scopes', () => {
    render(<ApiKeyForm isOpen onSubmit={vi.fn()} onCancel={noop} />);
    expect(screen.queryByTestId('mcp-domains-all')).toBeNull();
    checkScope(DEVICES_READ);
    expect(screen.queryByTestId('mcp-domains-all')).toBeNull();
  });

  it('picker shown after checking ai:read', () => {
    render(<ApiKeyForm isOpen onSubmit={vi.fn()} onCancel={noop} />);
    checkScope(AI_READ);
    expect(screen.getByTestId('mcp-domains-all')).toBeTruthy();
    expect(screen.queryByTestId('mcp-domains-reconnect-note')).toBeNull();
  });

  it('submits mcpDomains null by default and the list when selected', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(<ApiKeyForm isOpen onSubmit={onSubmit} onCancel={noop} />);
    fireEvent.change(screen.getByPlaceholderText('My API Key'), { target: { value: 'k1' } });
    checkScope(AI_READ);
    fireEvent.click(screen.getByText('Create Key'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ mcpDomains: null });
    unmount();

    const onSubmit2 = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeyForm isOpen onSubmit={onSubmit2} onCancel={noop} />);
    fireEvent.change(screen.getByPlaceholderText('My API Key'), { target: { value: 'k2' } });
    checkScope(AI_READ);
    fireEvent.click(screen.getByTestId('mcp-domains-selected'));
    // Zero boxes ticked: submit is blocked.
    expect((screen.getByText('Create Key') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('mcp-domain-tickets'));
    fireEvent.click(screen.getByText('Create Key'));
    await waitFor(() => expect(onSubmit2).toHaveBeenCalledTimes(1));
    expect(onSubmit2.mock.calls[0][0]).toMatchObject({ mcpDomains: ['tickets'] });
  });

  it('submits null when a narrowed selection is followed by unchecking every ai:* scope', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeyForm isOpen onSubmit={onSubmit} onCancel={noop} />);
    fireEvent.change(screen.getByPlaceholderText('My API Key'), { target: { value: 'k3' } });
    checkScope(AI_READ);
    checkScope(DEVICES_READ);
    fireEvent.click(screen.getByTestId('mcp-domains-selected'));
    fireEvent.click(screen.getByTestId('mcp-domain-tickets'));
    checkScope(AI_READ);
    expect(screen.queryByTestId('mcp-domains-all')).toBeNull();
    fireEvent.click(screen.getByText('Create Key'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ mcpDomains: null });
  });
});
