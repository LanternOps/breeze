import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
// Pass-through runAction so the request fn (and thus the PUT via fetchWithAuth)
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

import LoginBrandingCard from './LoginBrandingCard';

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

type Branding = { logoUrl: string | null; accentColor: string | null; headline: string | null };

function routeFetch(data: Branding | null) {
  fetchWithAuth.mockImplementation((url: string, opts?: { method?: string }) => {
    if (url === '/partners/me/login-branding' && (!opts || !opts.method || opts.method === 'GET')) {
      return Promise.resolve(jsonRes({ data }));
    }
    if (url === '/partners/me/login-branding' && opts?.method === 'PUT') {
      return Promise.resolve(jsonRes({ data }));
    }
    return Promise.resolve(jsonRes({ data: null }));
  });
}

function lastPut() {
  const call = [...fetchWithAuth.mock.calls].reverse().find(
    (c) => c[0] === '/partners/me/login-branding' && (c[1] as { method?: string })?.method === 'PUT'
  );
  if (!call) throw new Error('no PUT call recorded');
  return JSON.parse((call[1] as { body: string }).body);
}

describe('LoginBrandingCard', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    runAction.mockClear();
  });

  it('loads current branding values from GET', async () => {
    routeFetch({ logoUrl: 'https://cdn.example.com/logo.png', accentColor: '#112233', headline: 'Welcome back' });
    render(<LoginBrandingCard />);

    await waitFor(() => {
      expect((screen.getByTestId('login-branding-logo-url') as HTMLInputElement).value).toBe(
        'https://cdn.example.com/logo.png'
      );
    });
    expect((screen.getByTestId('login-branding-headline') as HTMLInputElement).value).toBe('Welcome back');
    expect((screen.getByTestId('login-branding-accent-hex') as HTMLInputElement).value).toBe('#112233');
  });

  it('renders three inputs and a headline capped at 120 chars', async () => {
    routeFetch(null);
    render(<LoginBrandingCard />);
    await waitFor(() => expect(screen.getByTestId('login-branding-logo-url')).toBeTruthy());
    expect(screen.getByTestId('login-branding-accent-color')).toBeTruthy();
    expect(screen.getByTestId('login-branding-headline').getAttribute('maxLength')).toBe('120');
  });

  it('preview background reflects the entered accent color', async () => {
    routeFetch(null);
    render(<LoginBrandingCard />);
    await waitFor(() => expect(screen.getByTestId('login-branding-accent-hex')).toBeTruthy());

    fireEvent.change(screen.getByTestId('login-branding-accent-hex'), { target: { value: '#ff0000' } });
    const preview = screen.getByTestId('login-branding-preview') as HTMLElement;
    expect(preview.style.backgroundColor).toBe('rgb(255, 0, 0)');
  });

  it('saves via runAction sending ALL THREE fields (full-replace)', async () => {
    routeFetch({ logoUrl: 'https://cdn.example.com/logo.png', accentColor: '#112233', headline: 'Old headline' });
    render(<LoginBrandingCard />);
    await waitFor(() =>
      expect((screen.getByTestId('login-branding-headline') as HTMLInputElement).value).toBe('Old headline')
    );

    // Clear the headline; logo + accent stay set.
    fireEvent.change(screen.getByTestId('login-branding-headline'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('login-branding-save'));

    await waitFor(() => expect(runAction).toHaveBeenCalled());
    const body = lastPut();
    // Full-replace: every field present, cleared one sent as null (not omitted).
    expect(Object.keys(body).sort()).toEqual(['accentColor', 'headline', 'logoUrl']);
    expect(body.logoUrl).toBe('https://cdn.example.com/logo.png');
    expect(body.accentColor).toBe('#112233');
    expect(body.headline).toBeNull();
  });
});
