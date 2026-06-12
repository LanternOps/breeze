import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OrgPortalSettingsEditor from './OrgPortalSettingsEditor';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';

const SETTINGS = {
  orgId: ORG_ID,
  enableTickets: true,
  enableAssetCheckout: true,
  enableSelfService: false,
  enablePasswordReset: true,
  supportEmail: 'help@msp.example',
  supportPhone: null,
  welcomeMessage: 'Welcome!',
  footerText: null
};

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

function mockApi(settings: unknown = SETTINGS) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `/orgs/organizations/${ORG_ID}/portal-settings` && !init?.method) {
      return makeJsonResponse({ data: settings });
    }
    if (url === `/orgs/organizations/${ORG_ID}/portal-settings` && init?.method === 'PATCH') {
      return makeJsonResponse({ data: settings });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 404);
  });
}

describe('OrgPortalSettingsEditor', () => {
  const onDirty = vi.fn();
  const onSave = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads and renders the fetched settings', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-portal-settings')).toBeInTheDocument());
    expect((screen.getByTestId('org-portal-toggle-enableTickets') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('org-portal-toggle-enableSelfService') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('org-portal-support-email') as HTMLInputElement).value).toBe('help@msp.example');
    expect((screen.getByTestId('org-portal-support-phone') as HTMLInputElement).value).toBe('');
  });

  it('marks dirty when a toggle changes', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-portal-toggle-enableTickets')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('org-portal-toggle-enableTickets'));
    expect(onDirty).toHaveBeenCalled();
  });

  it('saves via PATCH with empty strings normalized to null, then calls onSave', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-portal-save')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('org-portal-toggle-enableTickets'));
    fireEvent.change(screen.getByTestId('org-portal-support-email'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('org-portal-save'));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    const body = JSON.parse(String(patchCall![1]!.body));
    expect(body.enableTickets).toBe(false);
    expect(body.supportEmail).toBeNull();
    expect(body.welcomeMessage).toBe('Welcome!');
  });

  it('shows an error state with retry when the load fails', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-portal-load-error')).toBeInTheDocument());
  });

  it('does not call onSave when the PATCH fails (runAction toasts the error)', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'PATCH') return makeJsonResponse({ error: 'nope' }, false, 500);
      return makeJsonResponse({ data: SETTINGS });
    });
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-portal-save')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('org-portal-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(onSave).not.toHaveBeenCalled();
  });
});
