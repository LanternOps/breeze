import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  apiLogout: vi.fn(),
  apiPrepare: vi.fn(),
  localLogout: vi.fn(),
  accessToken: 'access-old' as string | null,
}));
vi.mock('../../stores/auth', () => {
  const useAuthStore = Object.assign(
    () => ({
      user: { id: 'user-1', name: 'User One', email: 'user@example.com', mfaEnabled: false },
      isAuthenticated: true,
    }),
    {
      getState: () => ({
        logout: authState.localLogout,
        tokens: authState.accessToken ? { accessToken: authState.accessToken } : null,
      }),
    },
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
    authState.accessToken = 'access-old';
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
    vi.restoreAllMocks();
    vi.useRealTimers();
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  function signOut() {
    const rendered = render(<Header />);
    fireEvent.click(screen.getByLabelText('layout.header.accountMenu'));
    fireEvent.click(screen.getByText('layout.header.signOut'));
    return rendered;
  }

  it('never navigates to a ticketless GET when Cloudflare preparation fails and offers retry', async () => {
    featureState.cfEnabled = true;
    authState.apiPrepare.mockResolvedValue({ kind: 'partial', message: 'Durable preparation failed.' });

    signOut();

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

    signOut();

    await waitFor(() => expect(assign).toHaveBeenCalledWith(
      '/api/v1/auth/cf-access-logout?ticket=signed.ticket',
    ));
    expect(assign).not.toHaveBeenCalledWith('/api/v1/auth/cf-access-logout');
  });

  it('surfaces ordinary durable failure as partial sign-out instead of claiming completion', async () => {
    authState.apiLogout.mockResolvedValue({ kind: 'partial', message: 'Server sign-out is incomplete.' });

    signOut();

    expect(await screen.findByTestId('logout-failure')).toHaveTextContent('Server sign-out is incomplete.');
    expect(navigationState.navigate).not.toHaveBeenCalled();
  });

  it('expires the component-local bearer and routes retry to safe reauthentication', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    featureState.cfEnabled = true;
    authState.apiPrepare.mockImplementation(async () => {
      authState.accessToken = null;
      return { kind: 'partial', message: 'Durable preparation failed.' };
    });

    signOut();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('logout-failure')).toBeInTheDocument();
    expect(setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 30_000)).toHaveLength(1);

    act(() => { vi.advanceTimersByTime(30_000); });
    fireEvent.click(screen.getByTestId('logout-retry'));
    await act(async () => { await Promise.resolve(); });

    expect(authState.apiPrepare).toHaveBeenCalledTimes(1);
    expect(navigationState.navigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('allows at most two terminal attempts before routing to safe reauthentication', async () => {
    featureState.cfEnabled = true;
    authState.apiPrepare.mockImplementation(async () => {
      authState.accessToken = null;
      return { kind: 'partial', message: 'Durable preparation failed.' };
    });

    signOut();
    fireEvent.click(await screen.findByTestId('logout-retry'));

    await waitFor(() => expect(navigationState.navigate).toHaveBeenCalledWith(
      '/login', { replace: true },
    ));
    expect(authState.apiPrepare).toHaveBeenCalledTimes(2);
  });

  it('clears the bearer deadline immediately after terminal preparation succeeds', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    featureState.cfEnabled = true;
    authState.apiPrepare.mockResolvedValue({
      kind: 'ready',
      navigationUrl: '/api/v1/auth/cf-access-logout?ticket=signed.ticket',
    });

    signOut();
    await act(async () => { await Promise.resolve(); });

    expect(assign).toHaveBeenCalled();
    const deadlineCall = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 30_000);
    expect(deadlineCall).toBeGreaterThanOrEqual(0);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(setTimeoutSpy.mock.results[deadlineCall]?.value);
  });

  it('clears the component-local bearer deadline when Header unmounts', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    authState.apiLogout.mockImplementation(async () => {
      authState.accessToken = null;
      return { kind: 'partial', message: 'Server sign-out is incomplete.' };
    });

    const rendered = signOut();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('logout-failure')).toBeInTheDocument();
    const deadlineCall = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 30_000);
    expect(deadlineCall).toBeGreaterThanOrEqual(0);

    rendered.unmount();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(setTimeoutSpy.mock.results[deadlineCall]?.value);
  });
});
