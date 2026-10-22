import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import ApiKeyForm, { endOfLocalDayIso } from './ApiKeyForm';

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

describe('ApiKeyForm — expiration date (#9654)', () => {
  // The API validates expiresAt with z.string().datetime(); a bare
  // "YYYY-MM-DD" from <input type="date"> fails it, so every dated key used to
  // be rejected. Parse with the same schema the route uses.
  const apiExpiresAt = z.string().datetime();

  const localDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  function pickExpiry(value: string) {
    fireEvent.click(screen.getByLabelText('Never expires'));
    fireEvent.change(screen.getByTestId('api-key-expires-at'), { target: { value } });
  }

  it('submits the picked date as an ISO datetime at the end of that day in the user timezone', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeyForm isOpen onSubmit={onSubmit} onCancel={noop} />);
    fillNameAndScopes();
    pickExpiry('2099-06-30');
    fireEvent.click(screen.getByText('Create Key'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const sent = onSubmit.mock.calls[0][0].expiresAt as string;
    expect(apiExpiresAt.safeParse(sent).success).toBe(true);
    expect(sent).toBe(new Date(2099, 5, 30, 23, 59, 59, 999).toISOString());
    // Still the picked calendar day for the user, not the day before/after.
    expect(localDate(new Date(sent))).toBe('2099-06-30');
  });

  it("accepts today's date (the key lives until the end of today)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeyForm isOpen onSubmit={onSubmit} onCancel={noop} />);
    fillNameAndScopes();
    pickExpiry(localDate(new Date()));
    fireEvent.click(screen.getByText('Create Key'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const sent = new Date(onSubmit.mock.calls[0][0].expiresAt as string);
    expect(sent.getTime()).toBeGreaterThan(Date.now());
  });

  it('blocks a date in the past instead of posting an already-expired key', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeyForm isOpen onSubmit={onSubmit} onCancel={noop} />);
    fillNameAndScopes();
    pickExpiry('2020-01-01');
    const input = screen.getByTestId('api-key-expires-at') as HTMLInputElement;
    // The picker's native `min` is today, so the browser already refuses the
    // submit (jsdom too: rangeUnderflow) ...
    expect(input.min).toBe(localDate(new Date()));
    expect(input.validity.rangeUnderflow).toBe(true);
    // ... and validate() is the backstop when native validation is bypassed.
    fireEvent.submit(input.form!);

    await waitFor(() =>
      expect(screen.getByText('Expiration date must be today or later')).toBeTruthy(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('endOfLocalDayIso rejects malformed and non-existent dates', () => {
    expect(endOfLocalDayIso('2026-02-31')).toBeNull();
    expect(endOfLocalDayIso('2026-13-01')).toBeNull();
    expect(endOfLocalDayIso('31/12/2026')).toBeNull();
    expect(endOfLocalDayIso('')).toBeNull();
    expect(endOfLocalDayIso('2028-02-29')).toBe(new Date(2028, 1, 29, 23, 59, 59, 999).toISOString());
  });

  it('still submits null when "Never expires" stays checked', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeyForm isOpen onSubmit={onSubmit} onCancel={noop} />);
    fillNameAndScopes();
    fireEvent.click(screen.getByText('Create Key'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ expiresAt: null });
  });
});
