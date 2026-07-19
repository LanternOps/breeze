import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OrgSettingsPage, { runOrgNameSave } from './OrgSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: vi.fn()
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn()
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn()
}));

// Stub the heavy child editors — they're unrelated to name editing, and several
// pull in their own fetches/effects; stubbing keeps these tests focused and fast.
vi.mock('./OrgBrandingEditor', () => ({ default: () => <div data-testid="branding-editor" /> }));
vi.mock('./OrgDefaultsEditor', () => ({ default: () => <div data-testid="defaults-editor" /> }));
vi.mock('./OrgNotificationSettings', () => ({ default: () => <div data-testid="notifications" /> }));
vi.mock('./OrgSecuritySettings', () => ({ default: () => <div data-testid="security" /> }));
vi.mock('./OrgEventLogSettings', () => ({ default: () => <div data-testid="event-logs" /> }));
vi.mock('./OrgRemoteAccessSettings', () => ({ default: () => <div data-testid="remote-access" /> }));
vi.mock('./OrgTicketSettingsEditor', () => ({ default: () => <div data-testid="org-ticket-settings" /> }));
vi.mock('../organizations/Pax8OrgTab', () => ({ default: ({ orgId }: { orgId: string }) => <div data-testid="pax8-org-tab">{orgId}</div> }));
vi.mock('../extensions/ExtensionSlotHost', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="extension-slot-host-stub" data-props={JSON.stringify(props)} />
  ),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const useOrgStoreMock = vi.mocked(useOrgStore);
const showToastMock = vi.mocked(showToast);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

describe('runOrgNameSave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends PATCH to /orgs/organizations/:id with the new name', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ id: 'org-1', name: 'New Name' }));

    await runOrgNameSave('org-1', 'New Name', { onUnauthorized: vi.fn() });

    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/orgs/organizations/org-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ name: 'New Name' })
      })
    );
  });

  it('shows a success toast and returns the updated org on 200', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ id: 'org-1', name: 'New Name' }));

    const result = await runOrgNameSave('org-1', 'New Name', { onUnauthorized: vi.fn() });

    expect(result).toMatchObject({ id: 'org-1', name: 'New Name' });
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' })
    );
  });

  it('shows an error toast and throws on non-401 failure', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ error: 'name required' }, false, 422));

    await expect(
      runOrgNameSave('org-1', '', { onUnauthorized: vi.fn() })
    ).rejects.toThrow();

    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('calls onUnauthorized and does not toast on 401', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false, 401));
    const onUnauthorized = vi.fn();

    await expect(
      runOrgNameSave('org-1', 'New Name', { onUnauthorized })
    ).rejects.toThrow();

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(showToastMock).not.toHaveBeenCalled();
  });
});

describe('OrgSettingsPage general tab — name editing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStoreMock.mockReturnValue({ currentOrgId: 'org-1', organizations: [] } as never);
  });

  const orgDetails = {
    id: 'org-1',
    name: 'Acme Systems',
    slug: 'acme',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    settings: {}
  };

  it('renders the organization name in an editable input', async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      if (url.endsWith('/effective-settings')) return Promise.resolve(makeJsonResponse({ locked: [] }));
      return Promise.resolve(makeJsonResponse(orgDetails));
    });

    render(<OrgSettingsPage orgId="org-1" />);

    const input = await screen.findByTestId('org-name-input');
    expect((input as HTMLInputElement).value).toBe('Acme Systems');
  });

  it('PATCHes the new name when the user edits and saves', async () => {
    fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/effective-settings')) return Promise.resolve(makeJsonResponse({ locked: [] }));
      if (init?.method === 'PATCH') return Promise.resolve(makeJsonResponse({ ...orgDetails, name: 'Acme IT' }));
      return Promise.resolve(makeJsonResponse(orgDetails));
    });

    render(<OrgSettingsPage orgId="org-1" />);

    const input = (await screen.findByTestId('org-name-input')) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, 'Acme IT');
    await userEvent.click(screen.getByTestId('org-name-save'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/orgs/organizations/org-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ name: 'Acme IT' })
        })
      );
    });
  });

  it('PATCHes the new organization type when the user edits and saves', async () => {
    fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/effective-settings')) return Promise.resolve(makeJsonResponse({ locked: [] }));
      if (init?.method === 'PATCH') return Promise.resolve(makeJsonResponse({ ...orgDetails, type: 'internal' }));
      return Promise.resolve(makeJsonResponse({ ...orgDetails, type: 'customer' }));
    });

    render(<OrgSettingsPage orgId="org-1" />);

    const select = (await screen.findByTestId('org-type-select')) as HTMLSelectElement;
    await userEvent.selectOptions(select, 'internal');
    await userEvent.click(screen.getByTestId('org-type-save'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/orgs/organizations/org-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ type: 'internal' })
        })
      );
    });
  });

  it('disables save when the name is unchanged, empty, or whitespace-only', async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      if (url.endsWith('/effective-settings')) return Promise.resolve(makeJsonResponse({ locked: [] }));
      return Promise.resolve(makeJsonResponse(orgDetails));
    });

    render(<OrgSettingsPage orgId="org-1" />);

    const input = (await screen.findByTestId('org-name-input')) as HTMLInputElement;
    const save = screen.getByTestId('org-name-save') as HTMLButtonElement;

    // Unchanged → disabled
    expect(save.disabled).toBe(true);

    // Emptied → still disabled
    await userEvent.clear(input);
    expect(save.disabled).toBe(true);

    // Whitespace-only → still disabled
    await userEvent.type(input, '   ');
    expect(save.disabled).toBe(true);

    // Changed to a real value → enabled
    await userEvent.clear(input);
    await userEvent.type(input, 'Acme IT');
    expect(save.disabled).toBe(false);
  });

  it('trims surrounding whitespace before sending the name', async () => {
    fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/effective-settings')) return Promise.resolve(makeJsonResponse({ locked: [] }));
      if (init?.method === 'PATCH') return Promise.resolve(makeJsonResponse({ ...orgDetails, name: 'Acme IT' }));
      return Promise.resolve(makeJsonResponse(orgDetails));
    });

    render(<OrgSettingsPage orgId="org-1" />);

    const input = (await screen.findByTestId('org-name-input')) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, '  Acme IT  ');
    await userEvent.click(screen.getByTestId('org-name-save'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/orgs/organizations/org-1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Acme IT' }) })
      );
    });
  });

  it('re-fetches and reflects the server-returned name after a successful save', async () => {
    // Server normalizes the name; the input should reflect the refetched value.
    fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/effective-settings')) return Promise.resolve(makeJsonResponse({ locked: [] }));
      if (init?.method === 'PATCH') return Promise.resolve(makeJsonResponse({ ...orgDetails, name: 'Acme IT' }));
      // GET (initial + post-save refetch): first call returns original, later returns normalized
      return Promise.resolve(makeJsonResponse({ ...orgDetails, name: 'Acme IT' }));
    });

    render(<OrgSettingsPage orgId="org-1" />);

    const input = (await screen.findByTestId('org-name-input')) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, 'acme it');
    await userEvent.click(screen.getByTestId('org-name-save'));

    // After save the page refetches; the org GET fires a second time and the
    // input reflects the persisted/normalized value.
    await waitFor(() => {
      const orgGets = fetchWithAuthMock.mock.calls.filter(
        ([url, init]) => url === '/orgs/organizations/org-1' && (!init || init.method !== 'PATCH')
      );
      expect(orgGets.length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect((screen.getByTestId('org-name-input') as HTMLInputElement).value).toBe('Acme IT');
    });
  });

  it('submits on Enter when changed, and does nothing on Enter when unchanged', async () => {
    fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/effective-settings')) return Promise.resolve(makeJsonResponse({ locked: [] }));
      if (init?.method === 'PATCH') return Promise.resolve(makeJsonResponse({ ...orgDetails, name: 'Acme IT' }));
      return Promise.resolve(makeJsonResponse(orgDetails));
    });

    render(<OrgSettingsPage orgId="org-1" />);

    const input = (await screen.findByTestId('org-name-input')) as HTMLInputElement;

    // Enter on the unchanged value → no PATCH
    input.focus();
    await userEvent.keyboard('{Enter}');
    expect(fetchWithAuthMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);

    // Change then Enter → PATCH fires
    await userEvent.clear(input);
    await userEvent.type(input, 'Acme IT');
    await userEvent.keyboard('{Enter}');

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/orgs/organizations/org-1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Acme IT' }) })
      );
    });
  });
});

describe('OrgSettingsPage sidebar nav & save-state honesty', () => {
  const orgDetails = {
    id: 'org-1',
    name: 'Acme Systems',
    slug: 'acme',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    settings: {}
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    useOrgStoreMock.mockReturnValue({ currentOrgId: 'org-1', organizations: [] } as never);
    fetchWithAuthMock.mockImplementation((url: string) => {
      if (url.endsWith('/effective-settings')) return Promise.resolve(makeJsonResponse({ locked: [] }));
      return Promise.resolve(makeJsonResponse(orgDetails));
    });
  });

  it('never shows a fabricated "Saved at" timestamp on load', async () => {
    render(<OrgSettingsPage orgId="org-1" />);

    await screen.findByTestId('org-name-input');
    expect(screen.queryByText(/saved at/i)).toBeNull();
    expect(screen.queryByText(/unsaved changes/i)).toBeNull();
  });

  it('renders the sections as grouped links and marks the active one with aria-current', async () => {
    render(<OrgSettingsPage orgId="org-1" />);

    await screen.findByTestId('org-name-input');
    const general = screen.getByRole('link', { name: /^general$/i });
    expect(general.getAttribute('aria-current')).toBe('page');
    // Approval Security no longer shares Security's icon slot — both links exist.
    expect(screen.getByRole('link', { name: /^approval security$/i })).not.toBeNull();

    await userEvent.click(screen.getByRole('link', { name: /^branding$/i }));
    expect(window.location.hash).toBe('#branding');
    expect(screen.getByRole('link', { name: /^branding$/i }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('branding-editor')).not.toBeNull();
  });

  it('deep-links the hash to the right section on mount', async () => {
    window.location.hash = '#remote-access';

    render(<OrgSettingsPage orgId="org-1" />);

    const link = await screen.findByRole('link', { name: /^remote access$/i });
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('remote-access')).not.toBeNull();
  });

  it('keeps a selected Pax8 order deep link active through hashchange and back navigation', async () => {
    window.location.hash = '#pax8/44444444-4444-4444-8444-444444444444';
    render(<OrgSettingsPage orgId="org-1" />);

    const link = await screen.findByRole('link', { name: /^pax8$/i });
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('pax8-org-tab')).toHaveTextContent('org-1');

    act(() => {
      window.location.hash = '#general';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await screen.findByTestId('org-name-input');

    act(() => {
      window.location.hash = '#pax8/55555555-5555-4555-8555-555555555555';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByTestId('pax8-org-tab')).toBeInTheDocument();
  });

  it('renders the Extensions tab with ONLY the documented organization context — no full org object leak', async () => {
    window.location.hash = '#extensions';
    render(<OrgSettingsPage orgId="org-1" />);

    const link = await screen.findByRole('link', { name: /^extensions$/i });
    expect(link.getAttribute('aria-current')).toBe('page');

    const stub = screen.getByTestId('extension-slot-host-stub');
    const props = JSON.parse(stub.dataset.props!);
    expect(props.slot).toBe('organization.settings.sections');
    expect(props.contractVersion).toBe(1);
    // EXACT documented shape — no name/slug/status/settings/etc. leak through.
    expect(props.context).toEqual({ contractVersion: 1, organizationId: 'org-1' });
    expect(Object.keys(props.context).sort()).toEqual(['contractVersion', 'organizationId'].sort());
  });

  it('offers the compact section select for narrow viewports', async () => {
    render(<OrgSettingsPage orgId="org-1" />);

    await screen.findByTestId('org-name-input');
    const select = screen.getByLabelText('Settings section') as HTMLSelectElement;
    expect(select.value).toBe('general');
  });
});
