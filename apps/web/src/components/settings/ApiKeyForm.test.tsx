import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../lib/i18n';
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
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

describe('ApiKeyForm — expiration date (#9654)', () => {
  // The API validates expiresAt with z.string().datetime() (mirrored here; the
  // route schema lives in apps/api). A bare "YYYY-MM-DD" from
  // <input type="date"> fails it, so every dated key used to be rejected.
  const apiExpiresAt = z.string().datetime();

  // A zone west of UTC, so local-day and UTC-day arithmetic disagree (a UTC
  // runner cannot tell them apart). "Now" is 22:30 MDT on 2026-10-18, which is
  // already 2026-10-19 in UTC.
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/Denver';
    // Fail loudly rather than silently run in the runner's zone.
    expect(new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset()).toBe(420);
  });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T04:30:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  function pickExpiry(value: string) {
    fireEvent.click(screen.getByLabelText('Never expires'));
    fireEvent.change(screen.getByTestId('api-key-expires-at'), { target: { value } });
  }

  async function submittedExpiry(onSubmit: ReturnType<typeof vi.fn>) {
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    return onSubmit.mock.calls[0][0].expiresAt as string | null;
  }

  it('submits the picked date as an ISO datetime at the end of that day in the user timezone', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeyForm isOpen onSubmit={onSubmit} onCancel={noop} />);
    fillNameAndScopes();
    pickExpiry('2099-06-30');
    fireEvent.click(screen.getByText('Create Key'));

    const sent = await submittedExpiry(onSubmit);
    expect(apiExpiresAt.safeParse(sent).success).toBe(true);
    // 23:59:59.999 MDT (UTC-6) on the 30th.
    expect(sent).toBe('2099-07-01T05:59:59.999Z');
  });

  it("uses the user's local today for the picker min and accepts it (key lives to end of today)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeyForm isOpen onSubmit={onSubmit} onCancel={noop} />);
    fillNameAndScopes();
    pickExpiry('2026-10-18');
    // Local day, not the UTC day (2026-10-19).
    expect((screen.getByTestId('api-key-expires-at') as HTMLInputElement).min).toBe('2026-10-18');
    fireEvent.click(screen.getByText('Create Key'));

    expect(await submittedExpiry(onSubmit)).toBe('2026-10-19T05:59:59.999Z');
  });

  it('blocks a date in the past instead of posting an already-expired key', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeyForm isOpen onSubmit={onSubmit} onCancel={noop} />);
    fillNameAndScopes();
    pickExpiry('2026-10-17');
    const input = screen.getByTestId('api-key-expires-at') as HTMLInputElement;
    // The picker's native `min` already refuses the submit (jsdom too:
    // rangeUnderflow) ...
    expect(input.validity.rangeUnderflow).toBe(true);
    // ... and validate() is the backstop when native validation is bypassed.
    fireEvent.submit(input.form!);

    await waitFor(() =>
      expect(screen.getByText('Expiration date must be today or later')).toBeTruthy(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('still submits null when "Never expires" stays checked', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeyForm isOpen onSubmit={onSubmit} onCancel={noop} />);
    fillNameAndScopes();
    fireEvent.click(screen.getByText('Create Key'));

    expect(await submittedExpiry(onSubmit)).toBeNull();
  });

  it('submits null when a date was picked and "Never expires" is re-checked', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ApiKeyForm isOpen onSubmit={onSubmit} onCancel={noop} />);
    fillNameAndScopes();
    pickExpiry('2099-06-30');
    fireEvent.click(screen.getByLabelText('Never expires'));
    fireEvent.click(screen.getByText('Create Key'));

    expect(await submittedExpiry(onSubmit)).toBeNull();
  });
});
