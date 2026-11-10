import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConnectDesktopButton, { type RemoteToolOption } from './ConnectDesktopButton';
import { fetchWithAuth } from '../../stores/auth';
import { showToast, _resetToastQueueForTests } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Toast', async () => {
  const actual = await vi.importActual<typeof import('../shared/Toast')>('../shared/Toast');
  return { ...actual, showToast: vi.fn() };
});

// The RDS session picker fetches the host's sessions; stand it in with a
// button that picks WTS session 3, so the test can drive onSelect directly.
vi.mock('./SessionPickerModal', () => ({
  default: ({ isOpen, onSelect }: { isOpen: boolean; onSelect: (id: number) => void }) =>
    isOpen ? <button type="button" onClick={() => onSelect(3)}>pick session 3</button> : null,
}));

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const res = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  }) as unknown as Response;

// #10922: the tenant has three tools usable on this device; RustDesk is the
// default the primary click launches.
const PROVIDERS: RemoteToolOption[] = [
  { id: 'rustdesk', label: 'RustDesk', kind: 'protocol' },
  { id: 'anydesk', label: 'AnyDesk', kind: 'protocol' },
  { id: 'sc', label: 'ScreenConnect', kind: 'web' },
];

const MENU_NAME = /choose how to connect/i;

function launchCalls() {
  return fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/remote-access-launch'));
}

/** Route every request the connect flow makes; record nothing else. */
function routeFetches(launch: () => Response = () => res({ launchUrl: 'anydesk:7300418', scheme: 'anydesk', providerId: 'anydesk' })) {
  fetchMock.mockImplementation((path: string) => {
    if (path.endsWith('/remote-access-launch')) return Promise.resolve(launch());
    if (path.startsWith('/devices/')) {
      return Promise.resolve(res({ desktopAccess: null, hasRemoteAccessLauncher: true, remoteAccessLaunchSkipReason: null }));
    }
    if (path === '/remote/sessions') return Promise.resolve(res({ id: 'sess-1' }));
    if (path.includes('/desktop-connect-code')) return Promise.resolve(res({ code: 'code-1' }));
    return Promise.resolve(res({ status: 'pending' }));
  });
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: MENU_NAME }));
  return screen.getByRole('menu', { name: MENU_NAME });
}

describe('ConnectDesktopButton — choose a remote tool (#10922)', () => {
  let anchorClicks: string[];
  let openSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetToastQueueForTests();
    fetchMock.mockReset();
    toastMock.mockReset();
    anchorClicks = [];
    // tryDeepLink hands the URL to the OS by clicking a hidden anchor.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchorClicks.push(this.getAttribute('href') ?? '');
    });
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders no menu when the device has no third-party tool', () => {
    render(<ConnectDesktopButton deviceId="dev-1" remoteAccessProviders={[]} remoteAccessDefaultProviderId={null} />);

    expect(screen.queryByRole('button', { name: MENU_NAME })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect desktop/i })).toBeInTheDocument();
  });

  it('renders no menu when the providers prop is absent', () => {
    render(<ConnectDesktopButton deviceId="dev-1" />);

    expect(screen.queryByRole('button', { name: MENU_NAME })).not.toBeInTheDocument();
  });

  it('lists the other tools plus the built-in viewer, not the one the primary click launches', () => {
    render(<ConnectDesktopButton deviceId="dev-1" remoteAccessProviders={PROVIDERS} remoteAccessDefaultProviderId="rustdesk" />);

    const trigger = screen.getByRole('button', { name: MENU_NAME });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    const menu = openMenu();
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'AnyDesk',
      expect.stringContaining('ScreenConnect'),
      'Built-in viewer',
    ]);
  });

  it('lists every returned tool when none of them is the primary click', () => {
    render(<ConnectDesktopButton deviceId="dev-1" remoteAccessProviders={PROVIDERS} remoteAccessDefaultProviderId={null} />);

    const items = within(openMenu()).getAllByRole('menuitem');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('RustDesk');
    expect(items[3]).toHaveTextContent('Built-in viewer');
  });

  it('names the default tool on the primary button', () => {
    render(<ConnectDesktopButton deviceId="dev-1" remoteAccessProviders={PROVIDERS} remoteAccessDefaultProviderId="rustdesk" />);

    expect(screen.getByRole('button', { name: /connect desktop/i })).toHaveAttribute('title', 'Connect with RustDesk');
  });

  it('keeps the primary click unchanged: default launch, no providerId in the body', async () => {
    routeFetches(() => res({ launchUrl: 'rustdesk://111', scheme: 'rustdesk', providerId: 'rustdesk' }));
    render(<ConnectDesktopButton deviceId="dev-1" remoteAccessProviders={PROVIDERS} remoteAccessDefaultProviderId="rustdesk" />);

    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => expect(anchorClicks).toContain('rustdesk://111'));
    expect(fetchMock.mock.calls[0]![0]).toBe('/devices/dev-1');
    expect(launchCalls()).toHaveLength(1);
    expect(launchCalls()[0]![1]).toEqual({ method: 'POST' });
  });

  it('launches the picked protocol tool with its id', async () => {
    routeFetches();
    render(<ConnectDesktopButton deviceId="dev-1" remoteAccessProviders={PROVIDERS} remoteAccessDefaultProviderId="rustdesk" />);

    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'AnyDesk' }));

    await waitFor(() => expect(anchorClicks).toContain('anydesk:7300418'));
    expect(launchCalls()).toHaveLength(1);
    const [path, init] = launchCalls()[0]!;
    expect(path).toBe('/devices/dev-1/remote-access-launch');
    expect(init).toEqual(expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ providerId: 'anydesk' });
    // The built-in viewer was not started behind the chosen tool.
    expect(fetchMock.mock.calls.some(([p]) => p === '/remote/sessions')).toBe(false);
  });

  it('opens a picked web tool in a new tab', async () => {
    routeFetches(() => res({ launchUrl: 'https://acme.example/Host#Access///333/Join', scheme: 'https', providerId: 'sc' }));
    render(<ConnectDesktopButton deviceId="dev-1" remoteAccessProviders={PROVIDERS} remoteAccessDefaultProviderId="rustdesk" />);

    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: /ScreenConnect/ }));

    await waitFor(() => expect(openSpy).toHaveBeenCalledWith(
      'https://acme.example/Host#Access///333/Join', '_blank', 'noopener,noreferrer',
    ));
    expect(JSON.parse(String((launchCalls()[0]![1] as RequestInit).body))).toEqual({ providerId: 'sc' });
  });

  it('starts the built-in viewer when picked, even though a default tool exists', async () => {
    routeFetches();
    render(<ConnectDesktopButton deviceId="dev-1" remoteAccessProviders={PROVIDERS} remoteAccessDefaultProviderId="rustdesk" />);

    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Built-in viewer' }));

    await waitFor(() => expect(anchorClicks.some((href) => href.startsWith('breeze://connect?session=sess-1'))).toBe(true));
    expect(launchCalls()).toHaveLength(0);
  });

  it('does not toast the default tool\'s skip reason when the built-in viewer is picked', async () => {
    fetchMock.mockImplementation((path: string) => {
      if (path.startsWith('/devices/')) {
        return Promise.resolve(res({ desktopAccess: null, hasRemoteAccessLauncher: false, remoteAccessLaunchSkipReason: 'missing_device_identifier' }));
      }
      if (path === '/remote/sessions') return Promise.resolve(res({ id: 'sess-1' }));
      if (path.includes('/desktop-connect-code')) return Promise.resolve(res({ code: 'code-1' }));
      return Promise.resolve(res({ status: 'pending' }));
    });
    render(<ConnectDesktopButton deviceId="dev-1" remoteAccessProviders={[PROVIDERS[1]!]} remoteAccessDefaultProviderId={null} />);

    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Built-in viewer' }));

    await waitFor(() => expect(anchorClicks.some((href) => href.startsWith('breeze://connect'))).toBe(true));
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('says the tool is no longer available when the server refuses the choice', async () => {
    routeFetches(() => res({ error: 'No remote-access launcher available for this device', code: 'provider_not_available' }, 404));
    render(<ConnectDesktopButton deviceId="dev-1" remoteAccessProviders={PROVIDERS} remoteAccessDefaultProviderId="rustdesk" />);

    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'AnyDesk' }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: expect.stringMatching(/no longer available/i),
    })));
    expect(anchorClicks).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([p]) => p === '/remote/sessions')).toBe(false);
  });

  it('says the device changed, not the tool, when the device itself is gone', async () => {
    routeFetches(() => res({ error: 'Device not found' }, 404));
    render(<ConnectDesktopButton deviceId="dev-1" remoteAccessProviders={PROVIDERS} remoteAccessDefaultProviderId="rustdesk" />);

    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'AnyDesk' }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: expect.stringMatching(/device record changed/i),
    })));
  });

  it('says the tool is unavailable when this device lacks the picked tool\'s identifier', async () => {
    routeFetches(() => res({ error: 'No remote-access launcher available for this device', code: 'missing_device_identifier' }, 404));
    render(<ConnectDesktopButton deviceId="dev-1" remoteAccessProviders={PROVIDERS} remoteAccessDefaultProviderId="rustdesk" />);

    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'AnyDesk' }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringMatching(/no longer available/i),
    })));
  });

  it('hides the menu while the device is offline', () => {
    render(
      <ConnectDesktopButton
        deviceId="dev-1"
        disabled
        disabledTitle="Device is offline"
        remoteAccessProviders={PROVIDERS}
        remoteAccessDefaultProviderId="rustdesk"
      />,
    );

    expect(screen.queryByRole('button', { name: MENU_NAME })).not.toBeInTheDocument();
  });

  it('offers no menu in the compact and icon-only variants', () => {
    const { unmount } = render(
      <ConnectDesktopButton deviceId="dev-1" compact remoteAccessProviders={PROVIDERS} remoteAccessDefaultProviderId="rustdesk" />,
    );
    expect(screen.queryByRole('button', { name: MENU_NAME })).not.toBeInTheDocument();
    unmount();
    render(<ConnectDesktopButton deviceId="dev-1" iconOnly remoteAccessProviders={PROVIDERS} remoteAccessDefaultProviderId="rustdesk" />);
    expect(screen.queryByRole('button', { name: MENU_NAME })).not.toBeInTheDocument();
  });

  it('is keyboard operable: focus lands on the first item and Escape returns to the trigger', () => {
    render(<ConnectDesktopButton deviceId="dev-1" remoteAccessProviders={PROVIDERS} remoteAccessDefaultProviderId="rustdesk" />);

    const trigger = screen.getByRole('button', { name: MENU_NAME });
    const menu = openMenu();
    const items = within(menu).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  const renderRdsHost = () =>
    render(
      <ConnectDesktopButton
        deviceId="dev-1"
        helperLifecycleMode="on-demand"
        remoteAccessProviders={PROVIDERS}
        remoteAccessDefaultProviderId="rustdesk"
      />,
    );

  it('on an RDS host, a picked tool launches directly without the session picker', async () => {
    routeFetches();
    renderRdsHost();

    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'AnyDesk' }));

    await waitFor(() => expect(anchorClicks).toContain('anydesk:7300418'));
    expect(screen.queryByRole('button', { name: 'pick session 3' })).not.toBeInTheDocument();
  });

  it('on an RDS host, the built-in viewer goes through the session picker and never the launcher', async () => {
    routeFetches();
    renderRdsHost();

    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Built-in viewer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'pick session 3' }));

    await waitFor(() => expect(anchorClicks.some((href) => href.includes('targetSessionId=3'))).toBe(true));
    expect(launchCalls()).toHaveLength(0);
  });

  it('disables the menu items while a launch is in flight', async () => {
    routeFetches();
    render(<ConnectDesktopButton deviceId="dev-1" remoteAccessProviders={PROVIDERS} remoteAccessDefaultProviderId="rustdesk" />);

    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'AnyDesk' }));
    await waitFor(() => expect(anchorClicks).toContain('anydesk:7300418'));

    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: /ScreenConnect/ }));
    await new Promise((r) => setTimeout(r, 20));
    expect(launchCalls()).toHaveLength(1);
  });
});
