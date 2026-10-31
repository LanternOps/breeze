import '@/lib/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({ fetchWithAuth }));
const showToast = vi.hoisted(() => vi.fn());
vi.mock('../shared/Toast', () => ({ showToast }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import KnownGuestsSettings from './KnownGuestsSettings';

const json = (body: unknown, status = 200) =>
  ({ ok: status < 300, status, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;
const GUEST = { id: 'g-1', macAddress: 'AA:BB:CC:DD:EE:FF', label: 'Tech laptop', notes: null, createdAt: '2026-10-01T00:00:00Z' };

function route(handlers: Record<string, () => Response>) {
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${url}`;
    return handlers[key]?.() ?? json({ data: [GUEST] });
  });
}

async function addGuest(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('MAC Address'), '11:22:33:44:55:66');
  await user.type(screen.getByLabelText('Label'), 'Visitor');
  await user.click(screen.getByRole('button', { name: /add/i }));
}

beforeEach(() => { vi.clearAllMocks(); });

describe('KnownGuestsSettings (list kind; mutations via runAction)', () => {
  it('add guest goes through runAction and toasts on failure', async () => {
    route({ 'POST /partner/known-guests': () => json({ error: 'Duplicate MAC address' }, 500) });
    render(<KnownGuestsSettings />);
    await screen.findByText('Tech laptop');
    await addGuest(userEvent.setup());
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Duplicate MAC address' })));
    // The toast is the feedback: no inline-only copy of the server error.
    expect(screen.queryByText('Duplicate MAC address')).toBeNull();
    // The typed row stays so the user can correct it.
    expect((screen.getByLabelText('MAC Address') as HTMLInputElement).value).toBe('11:22:33:44:55:66');
  });

  it('a successful add toasts, clears the row and reloads the list', async () => {
    route({ 'POST /partner/known-guests': () => json({ data: { ...GUEST, id: 'g-2' } }, 201) });
    render(<KnownGuestsSettings />);
    await screen.findByText('Tech laptop');
    await addGuest(userEvent.setup());
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
    const post = fetchWithAuth.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(post[1].body)).toEqual({ macAddress: '11:22:33:44:55:66', label: 'Visitor' });
    expect((screen.getByLabelText('MAC Address') as HTMLInputElement).value).toBe('');
    expect(fetchWithAuth.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2);
  });

  it('delete guest goes through runAction', async () => {
    route({ 'DELETE /partner/known-guests/g-1': () => json({ error: 'nope' }, 500) });
    render(<KnownGuestsSettings />);
    await screen.findByText('Tech laptop');
    const user = userEvent.setup();
    await user.click(screen.getByTitle('Remove'));
    await user.click(await screen.findByTestId('known-guests-remove-confirm'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(fetchWithAuth).toHaveBeenCalledWith('/partner/known-guests/g-1', expect.objectContaining({ method: 'DELETE' }));
  });

  // #9950: the trash icon deleted immediately, with no confirmation.
  it('remove asks for confirmation first; cancel sends no request', async () => {
    route({});
    render(<KnownGuestsSettings />);
    await screen.findByText('Tech laptop');
    const user = userEvent.setup();
    await user.click(screen.getByTitle('Remove'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Tech laptop');
    expect(dialog.textContent).toContain('AA:BB:CC:DD:EE:FF');
    expect(fetchWithAuth.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetchWithAuth.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('confirmed remove toasts success and reloads the list', async () => {
    route({ 'DELETE /partner/known-guests/g-1': () => json({ success: true }) });
    render(<KnownGuestsSettings />);
    await screen.findByText('Tech laptop');
    const user = userEvent.setup();
    await user.click(screen.getByTitle('Remove'));
    await user.click(await screen.findByTestId('known-guests-remove-confirm'));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Known guest removed' })),
    );
    expect(fetchWithAuth.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('client-side validation still blocks a malformed MAC without a request', async () => {
    route({});
    render(<KnownGuestsSettings />);
    await screen.findByText('Tech laptop');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('MAC Address'), 'nope');
    await user.type(screen.getByLabelText('Label'), 'Visitor');
    await user.click(screen.getByRole('button', { name: /add/i }));
    expect(screen.getByText('Invalid MAC format (XX:XX:XX:XX:XX:XX)')).toBeTruthy();
    expect(fetchWithAuth.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});
