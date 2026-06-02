import { render, screen, waitFor } from '@testing-library/react';
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

// Stub the heavy child editors — they're unrelated to name editing and pull in
// their own fetches/effects that would only add noise to these tests.
vi.mock('./OrgBrandingEditor', () => ({ default: () => <div data-testid="branding-editor" /> }));
vi.mock('./OrgDefaultsEditor', () => ({ default: () => <div data-testid="defaults-editor" /> }));
vi.mock('./OrgNotificationSettings', () => ({ default: () => <div data-testid="notifications" /> }));
vi.mock('./OrgSecuritySettings', () => ({ default: () => <div data-testid="security" /> }));
vi.mock('./OrgEventLogSettings', () => ({ default: () => <div data-testid="event-logs" /> }));
vi.mock('./OrgRemoteAccessSettings', () => ({ default: () => <div data-testid="remote-access" /> }));

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

  it('disables save when the name is unchanged or empty', async () => {
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

    // Changed to a real value → enabled
    await userEvent.type(input, 'Acme IT');
    expect(save.disabled).toBe(false);
  });
});
