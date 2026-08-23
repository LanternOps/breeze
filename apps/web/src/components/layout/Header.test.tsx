import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  apiLogout: vi.fn(),
  apiPrepare: vi.fn(),
  localLogout: vi.fn(),
}));
vi.mock('../../stores/auth', () => {
  const useAuthStore = Object.assign(
    () => ({
      user: { id: 'user-1', name: 'User One', email: 'user@example.com', mfaEnabled: false },
      isAuthenticated: true,
    }),
    { getState: () => ({ logout: authState.localLogout, tokens: { accessToken: 'access-old' } }) },
  );
  return {
    useAuthStore,
    apiLogout: authState.apiLogout,
    apiPrepareCfTerminalLogout: authState.apiPrepare,
    fetchWithAuth: vi.fn(),
  };
});

const featureState = vi.hoisted(() => ({ cfEnabled: false, load: vi.fn() }));
vi.mock('../../stores/featuresStore', () => {
  const useFeaturesStore = Object.assign(
    (selector: (state: unknown) => unknown) => selector({ features: {}, load: featureState.load }),
    { getState: () => ({ cfAccessLogin: { enabled: featureState.cfEnabled } }) },
  );
  return { useFeaturesStore };
});

vi.mock('../../stores/aiStore', () => ({ useAiStore: () => ({ isOpen: false, toggle: vi.fn() }) }));
vi.mock('../../stores/helpStore', () => ({ useHelpStore: () => ({ isOpen: false, toggle: vi.fn() }) }));
vi.mock('../../stores/uiStore', () => ({ useUiStore: () => ({ toggleMobileMenu: vi.fn() }) }));
vi.mock('./OrgSwitcher', () => ({ default: () => null }));
vi.mock('./NotificationCenter', () => ({ default: () => null }));
vi.mock('../time/TimerWidget', () => ({ default: () => null }));
vi.mock('./CommandPalette', () => ({ default: () => null }));
vi.mock('../support/SupportModal', () => ({ default: () => null }));
vi.mock('../../lib/avatarBlobCache', () => ({ useAvatarBlobUrl: () => null }));
vi.mock('../../lib/appearance', () => ({
  readDensity: () => 'comfortable',
  readThemePreference: () => 'system',
  subscribeDensity: () => () => undefined,
  subscribeTheme: () => () => undefined,
  writeDensity: vi.fn(),
  writeThemePreference: vi.fn(),
}));
vi.mock('../../lib/userPreferences', () => ({ saveUserPreferences: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const navigationState = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('../../lib/navigation', () => ({ navigateTo: navigationState.navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import Header from './Header';

describe('Header terminal logout UX', () => {
  let assign: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    authState.apiLogout.mockReset();
    authState.apiPrepare.mockReset();
    authState.localLogout.mockReset();
    navigationState.navigate.mockReset();
    featureState.cfEnabled = false;
    assign = vi.fn();
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        origin: 'http://localhost:3000', href: 'http://localhost:3000/',
        pathname: '/', search: '', hash: '', assign,
      },
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  async function signOut() {
    render(<Header />);
    fireEvent.click(screen.getByLabelText('layout.header.accountMenu'));
    fireEvent.click(screen.getByText('layout.header.signOut'));
  }

  it('never navigates to a ticketless GET when Cloudflare preparation fails and offers retry', async () => {
    featureState.cfEnabled = true;
    authState.apiPrepare.mockResolvedValue({ kind: 'partial', message: 'Durable preparation failed.' });

    await signOut();

    expect(await screen.findByTestId('logout-failure')).toHaveTextContent('Durable preparation failed.');
    expect(assign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('logout-retry'));
    await waitFor(() => expect(authState.apiPrepare).toHaveBeenCalledTimes(2));
    expect(assign).not.toHaveBeenCalled();
  });

  it('navigates only to the server-issued validated ticket URL after Cloudflare preparation', async () => {
    featureState.cfEnabled = true;
    authState.apiPrepare.mockResolvedValue({
      kind: 'ready',
      navigationUrl: '/api/v1/auth/cf-access-logout?ticket=signed.ticket',
    });

    await signOut();

    await waitFor(() => expect(assign).toHaveBeenCalledWith(
      '/api/v1/auth/cf-access-logout?ticket=signed.ticket',
    ));
    expect(assign).not.toHaveBeenCalledWith('/api/v1/auth/cf-access-logout');
  });

  it('surfaces ordinary durable failure as partial sign-out instead of claiming completion', async () => {
    authState.apiLogout.mockResolvedValue({ kind: 'partial', message: 'Server sign-out is incomplete.' });

    await signOut();

    expect(await screen.findByTestId('logout-failure')).toHaveTextContent('Server sign-out is incomplete.');
    expect(navigationState.navigate).not.toHaveBeenCalled();
  });
});
