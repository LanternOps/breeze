import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

import PartnerModulesCard from './PartnerModulesCard';
import { fetchWithAuth, registerOrgIdProvider } from '@/stores/auth';
import { showToast } from '../shared/Toast';
import { useOrgStore } from '@/stores/orgStore';

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
  vi.mocked(registerOrgIdProvider).mockClear();
  useOrgStore.setState({ serviceManagementMode: 'native' });
});

describe('PartnerModulesCard', () => {
  // The card's checked state comes from its own `mode` state, seeded from the
  // prop and republished to the store by its adopt effect — the card never
  // reads the store back. These tests still seed the store to the same value so
  // the pre/post state is unambiguous when a case asserts the store was (or was
  // not) moved, mirroring PartnerSettingsPage, which sources the prop from its
  // own GET /orgs/partners/me.
  it('renders with the native mode checked and off unchecked', () => {
    useOrgStore.setState({ serviceManagementMode: 'native' });
    render(<PartnerModulesCard serviceManagementMode="native" />);
    expect(screen.getByTestId('partner-modules-mode-native')).toBeChecked();
    expect(screen.getByTestId('partner-modules-mode-off')).not.toBeChecked();
    expect(screen.queryByTestId('partner-modules-external-note')).toBeNull();
  });

  it('renders with the off mode checked', () => {
    useOrgStore.setState({ serviceManagementMode: 'off' });
    render(<PartnerModulesCard serviceManagementMode="off" />);
    expect(screen.getByTestId('partner-modules-mode-off')).toBeChecked();
    expect(screen.getByTestId('partner-modules-mode-native')).not.toBeChecked();
  });

  it('leaves neither radio checked for external, and shows the external note', () => {
    useOrgStore.setState({ serviceManagementMode: 'external' });
    render(<PartnerModulesCard serviceManagementMode="external" />);
    expect(screen.getByTestId('partner-modules-mode-native')).not.toBeChecked();
    expect(screen.getByTestId('partner-modules-mode-off')).not.toBeChecked();
    expect(screen.getByTestId('partner-modules-external-note')).toBeTruthy();
  });

  it('choosing Off PATCHes /orgs/partners/me with the parsed mode and adopts it into the store on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ serviceManagementMode: 'off' }));
    render(<PartnerModulesCard serviceManagementMode="native" />);

    fireEvent.click(screen.getByTestId('partner-modules-mode-off'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/orgs/partners/me');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ serviceManagementMode: 'off' });

    await waitFor(() => expect(useOrgStore.getState().serviceManagementMode).toBe('off'));
    expect(screen.getByTestId('partner-modules-mode-off')).toBeChecked();
  });

  it('reverts to the previous mode and leaves the store untouched when the PATCH fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, false, 500));
    render(<PartnerModulesCard serviceManagementMode="native" />);

    fireEvent.click(screen.getByTestId('partner-modules-mode-off'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));

    // The sidebar must not move on a failed save.
    expect(useOrgStore.getState().serviceManagementMode).toBe('native');
    expect(screen.getByTestId('partner-modules-mode-native')).toBeChecked();
    expect(screen.getByTestId('partner-modules-mode-off')).not.toBeChecked();
  });
});
