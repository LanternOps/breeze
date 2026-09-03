import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

// Deliberately NOT mocking runAction: these tests exercise the real
// no-silent-mutations wrapper so failure toasts carry the API's error text.
import AiKillSwitch from './AiKillSwitch';

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const activeRow = {
  killed: false,
  epoch: 4,
  reason: 'restored after incident 123',
  updatedBy: 'admin-0',
  updatedAt: '2026-08-28T12:00:00.000Z',
};

const killedRow = {
  killed: true,
  epoch: 5,
  reason: 'suspected prompt injection',
  updatedBy: 'admin-1',
  updatedAt: '2026-09-01T09:00:00.000Z',
};

/** Route the mock fetch by method+url; GET / falls through to `initial`. */
function mockApi(initial: unknown, handlers: Record<string, () => Response> = {}) {
  fetchWithAuth.mockImplementation((url: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    const handler = handlers[`${method} ${url}`];
    if (handler) return Promise.resolve(handler());
    if (method === 'GET' && url === '/admin/ai-kill-state') return Promise.resolve(jsonRes({ data: initial }));
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
});

describe('AiKillSwitch', () => {
  it('shows a platform-admin-required panel on a 403', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: 'platform admin access required' }, 403));
    render(<AiKillSwitch />);
    await screen.findByTestId('ai-kill-switch-requires-platform-admin');
  });

  it('renders the active state with epoch and provenance', async () => {
    mockApi(activeRow);
    render(<AiKillSwitch />);
    await waitFor(() => expect(screen.getByTestId('ai-kill-switch-status-badge').textContent).toMatch(/active/i));
    expect(screen.getByTestId('ai-kill-switch-epoch').textContent).toContain('4');
    expect(screen.getByTestId('ai-kill-switch-updated-by').textContent).toContain('admin-0');
    expect(screen.getByTestId('ai-kill-switch-last-reason').textContent).toContain('restored after incident 123');
  });

  it('renders the killed state', async () => {
    mockApi(killedRow);
    render(<AiKillSwitch />);
    await waitFor(() => expect(screen.getByTestId('ai-kill-switch-status-badge').textContent).toMatch(/killed/i));
  });

  it('requires a reason before the confirm button is enabled', async () => {
    mockApi(activeRow);
    render(<AiKillSwitch />);
    await screen.findByTestId('ai-kill-switch-toggle');

    fireEvent.click(screen.getByTestId('ai-kill-switch-toggle'));
    const confirmButton = await screen.findByTestId('ai-kill-switch-confirm-submit');
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('ai-kill-switch-confirm-reason'), { target: { value: 'ab' } });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('ai-kill-switch-confirm-reason'), { target: { value: 'incident 123' } });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('flips the switch via runAction and refetches the row', async () => {
    mockApi(activeRow, {
      'POST /admin/ai-kill-state': () => jsonRes({ data: { killed: true, epoch: 5 } }),
    });
    render(<AiKillSwitch />);
    await screen.findByTestId('ai-kill-switch-toggle');

    fireEvent.click(screen.getByTestId('ai-kill-switch-toggle'));
    fireEvent.change(await screen.findByTestId('ai-kill-switch-confirm-reason'), {
      target: { value: 'incident 123' },
    });

    mockApi(killedRow, {
      'POST /admin/ai-kill-state': () => jsonRes({ data: { killed: true, epoch: 5 } }),
    });
    fireEvent.click(screen.getByTestId('ai-kill-switch-confirm-submit'));

    await waitFor(() => expect(screen.getByTestId('ai-kill-switch-status-badge').textContent).toMatch(/killed/i));

    const call = fetchWithAuth.mock.calls.find(
      ([url, opts]) => url === '/admin/ai-kill-state' && (opts as RequestInit)?.method === 'POST',
    );
    expect(call).toBeTruthy();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body).toEqual({ killed: true, reason: 'incident 123' });
  });

  it('shows a friendly message when MFA is required', async () => {
    mockApi(activeRow, {
      'POST /admin/ai-kill-state': () => jsonRes({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403),
    });
    render(<AiKillSwitch />);
    await screen.findByTestId('ai-kill-switch-toggle');

    fireEvent.click(screen.getByTestId('ai-kill-switch-toggle'));
    fireEvent.change(await screen.findByTestId('ai-kill-switch-confirm-reason'), {
      target: { value: 'incident 123' },
    });
    fireEvent.click(screen.getByTestId('ai-kill-switch-confirm-submit'));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('multi-factor authentication'), type: 'error' }),
      );
    });
  });
});
