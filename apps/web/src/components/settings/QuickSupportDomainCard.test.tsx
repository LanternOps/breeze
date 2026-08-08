import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
// Pass-through runAction so the request fn (and thus the PATCH via fetchWithAuth)
// actually runs — lets us assert the mutation fired (no silent mutation).
const runAction = vi.fn(async (o: { request: () => Promise<Response> }) => {
  const r = await o.request();
  return r.json().catch(() => null);
});
vi.mock('../../lib/runAction', () => ({
  runAction: (o: { request: () => Promise<Response> }) => runAction(o),
  ActionError: class ActionError extends Error {
    status: number;
    constructor(m: string, s: number) { super(m); this.status = s; }
  },
  handleActionError: vi.fn(),
}));

import QuickSupportDomainCard from './QuickSupportDomainCard';

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function routeFetch(quickSupportDomain: string | null) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/orgs/partners/me') {
      return Promise.resolve(jsonRes({ id: 'partner-1', settings: { quickSupportDomain } }));
    }
    return Promise.resolve(jsonRes({}));
  });
}

function lastPatchBody() {
  const call = [...fetchWithAuth.mock.calls]
    .reverse()
    .find((c) => c[0] === '/orgs/partners/me' && (c[1] as { method?: string })?.method === 'PATCH');
  if (!call) throw new Error('no PATCH call recorded');
  return JSON.parse((call[1] as { body: string }).body);
}

const input = () => screen.getByTestId('quick-support-domain-input') as HTMLInputElement;
const saveButton = () => screen.getByTestId('quick-support-domain-save') as HTMLButtonElement;

describe('QuickSupportDomainCard', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    runAction.mockClear();
  });

  it('loads the currently configured domain', async () => {
    routeFetch('support.acme.com');
    render(<QuickSupportDomainCard />);

    await waitFor(() => expect(input().value).toBe('support.acme.com'));
  });

  it('renders an empty input when no domain is configured', async () => {
    routeFetch(null);
    render(<QuickSupportDomainCard />);

    await waitFor(() => expect(input()).toBeTruthy());
    expect(input().value).toBe('');
  });

  it('saves a trimmed, lowercased hostname', async () => {
    routeFetch(null);
    render(<QuickSupportDomainCard />);
    await waitFor(() => expect(input()).toBeTruthy());

    fireEvent.change(input(), { target: { value: '  Support.ACME.Com  ' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(runAction).toHaveBeenCalled());
    expect(lastPatchBody()).toEqual({ settings: { quickSupportDomain: 'support.acme.com' } });
  });

  it('sends null when the field is cleared', async () => {
    routeFetch('support.acme.com');
    render(<QuickSupportDomainCard />);
    await waitFor(() => expect(input().value).toBe('support.acme.com'));

    fireEvent.change(input(), { target: { value: '' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(runAction).toHaveBeenCalled());
    expect(lastPatchBody()).toEqual({ settings: { quickSupportDomain: null } });
  });

  it.each(['https://support.acme.com', 'support.acme.com/quick', 'support acme.com', 'localhost'])(
    'shows an inline error and blocks the save for %j',
    async (bad) => {
      routeFetch(null);
      render(<QuickSupportDomainCard />);
      await waitFor(() => expect(input()).toBeTruthy());

      fireEvent.change(input(), { target: { value: bad } });

      expect(screen.getByTestId('quick-support-domain-error')).toBeTruthy();
      expect(saveButton().disabled).toBe(true);
      fireEvent.click(saveButton());
      expect(runAction).not.toHaveBeenCalled();
    },
  );

  it('disables saving when the initial load failed, so it cannot overwrite unseen state', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({}, false, 500));
    render(<QuickSupportDomainCard />);

    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });
});
