/**
 * #11621: a user whose role lacks `remote:access` (the built-in Partner/Org
 * Viewer, or a custom role) can open a device, but every /remote/* route
 * refuses them. Every Connect entry point renders this component, so it must
 * show the connect control as unavailable and name the missing permission,
 * rather than offer a click that ends in "Connection failed".
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ConnectDesktopButton from './ConnectDesktopButton';
import { fetchWithAuth } from '../../stores/auth';
import { showToast, _resetToastQueueForTests } from '../shared/Toast';

const perms = vi.hoisted(() => ({
  list: undefined as undefined | { resource: string; action: string }[],
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({
    permissions: perms.list,
    can: (r: string, a: string) =>
      (perms.list ?? []).some(
        (p) => (p.resource === r || p.resource === '*') && (p.action === a || p.action === '*'),
      ),
  }),
}));

vi.mock('../shared/Toast', async () => {
  const actual = await vi.importActual<typeof import('../shared/Toast')>('../shared/Toast');
  return { ...actual, showToast: vi.fn() };
});

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const res = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers({ 'content-type': 'application/json' }),
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    clone() { return this; },
  }) as unknown as Response;

const VIEWER = [
  { resource: 'devices', action: 'read' },
  { resource: 'scripts', action: 'read' },
  { resource: 'alerts', action: 'read' },
];
const TECH = [...VIEWER, { resource: 'remote', action: 'access' }];
const PERMISSION_REASON = /remote:access/;

describe('ConnectDesktopButton — remote:access gating (#11621)', () => {
  beforeEach(() => {
    _resetToastQueueForTests();
    fetchMock.mockReset();
    toastMock.mockReset();
    perms.list = undefined;
  });

  it('full-size: shows the control as unavailable and names remote:access when the role lacks it', () => {
    perms.list = VIEWER;
    render(<ConnectDesktopButton deviceId="dev-1" />);

    const btn = screen.getByRole('button', { name: /connect desktop/i });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('title', expect.stringMatching(PERMISSION_REASON));
    expect(btn).toHaveAccessibleDescription(PERMISSION_REASON);

    fireEvent.click(btn);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('full-size: hides the third-party tool menu when the role lacks remote:access', () => {
    perms.list = VIEWER;
    render(
      <ConnectDesktopButton
        deviceId="dev-1"
        remoteAccessProviders={[{ id: 'rustdesk', label: 'RustDesk', kind: 'protocol' }]}
      />,
    );
    expect(screen.queryByRole('button', { name: /choose how to connect/i })).toBeNull();
  });

  it('icon-only (device list): disabled with the permission named in its title', () => {
    perms.list = VIEWER;
    render(<ConnectDesktopButton deviceId="dev-1" iconOnly />);

    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', expect.stringMatching(PERMISSION_REASON));
  });

  it('compact (actions menu): disabled with the permission named in its title', () => {
    perms.list = VIEWER;
    render(<ConnectDesktopButton deviceId="dev-1" compact />);

    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', expect.stringMatching(PERMISSION_REASON));
  });

  it('the permission reason wins over a device-side unavailable reason', () => {
    perms.list = VIEWER;
    render(<ConnectDesktopButton deviceId="dev-1" iconOnly isHeadless />);
    expect(screen.getByRole('button')).toHaveAttribute('title', expect.stringMatching(PERMISSION_REASON));
  });

  it('a role holding remote:access gets the normal, enabled connect control', () => {
    perms.list = TECH;
    render(<ConnectDesktopButton deviceId="dev-1" />);

    const btn = screen.getByRole('button', { name: /connect desktop/i });
    expect(btn).not.toHaveAttribute('aria-disabled');
    expect(btn.getAttribute('title') ?? '').not.toMatch(PERMISSION_REASON);
  });

  it('the *:* admin grant counts as remote:access', () => {
    perms.list = [{ resource: '*', action: '*' }];
    render(<ConnectDesktopButton deviceId="dev-1" />);
    expect(screen.getByRole('button', { name: /connect desktop/i })).not.toHaveAttribute('aria-disabled');
  });

  it('while grants are still loading it does not claim the permission is missing', () => {
    perms.list = undefined;
    render(<ConnectDesktopButton deviceId="dev-1" />);

    const btn = screen.getByRole('button', { name: /connect desktop/i });
    expect(btn).not.toHaveAttribute('aria-disabled');
    expect(btn.getAttribute('title') ?? '').not.toMatch(PERMISSION_REASON);
  });

  function routeLauncher(launch: Response) {
    fetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/remote-access-launch')) return Promise.resolve(launch);
      if (path.startsWith('/devices/')) {
        return Promise.resolve(res({ desktopAccess: null, hasRemoteAccessLauncher: true, remoteAccessLaunchSkipReason: null }));
      }
      return Promise.resolve(res({}));
    });
  }

  it('third-party launcher: a 403 with the remote-access code names the permission and disables the control', async () => {
    perms.list = TECH;
    routeLauncher(res({ error: 'x', code: 'REMOTE_ACCESS_PERMISSION_REQUIRED' }, 403));

    render(<ConnectDesktopButton deviceId="dev-1" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /connect desktop/i })).toHaveAttribute('aria-disabled', 'true');
    });
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: expect.stringMatching(PERMISSION_REASON),
    }));
    expect(fetchMock.mock.calls.some(([p]) => p === '/remote/sessions')).toBe(false);
    expect(screen.queryByText(/connection failed/i)).toBeNull();
  });

  it('third-party launcher: a 403 without that code keeps the generic failure path', async () => {
    perms.list = TECH;
    routeLauncher(res({ error: 'Access to this site denied' }, 403));

    render(<ConnectDesktopButton deviceId="dev-1" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      expect(screen.getByText(/connection failed/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /connection failed/i })).not.toHaveAttribute('aria-disabled');
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringMatching(PERMISSION_REASON),
    }));
  });

  it('a server refusal does not outlive a refreshed grant list (e.g. an admin adds remote:access)', async () => {
    perms.list = TECH;
    routeLauncher(res({ error: 'x', code: 'REMOTE_ACCESS_PERMISSION_REQUIRED' }, 403));

    const { rerender } = render(<ConnectDesktopButton deviceId="dev-1" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /connect desktop/i })).toHaveAttribute('aria-disabled', 'true');
    });

    // /users/me refreshed: a new grant list that holds remote:access.
    perms.list = [...TECH];
    rerender(<ConnectDesktopButton deviceId="dev-1" />);

    expect(screen.getByRole('button', { name: /connect desktop/i })).not.toHaveAttribute('aria-disabled');
  });

  it('a server refusal with the remote-access code (stale client grants) shows the permission, not "Connection failed"', async () => {
    perms.list = TECH;
    fetchMock.mockImplementation((path: string) => {
      if (path.startsWith('/devices/')) {
        return Promise.resolve(res({ desktopAccess: null, hasRemoteAccessLauncher: false, remoteAccessLaunchSkipReason: null }));
      }
      if (path === '/remote/sessions') {
        const message = 'Remote access requires the remote:access permission, which your role does not include. Ask an administrator to add it to your role.';
        return Promise.resolve(res({ error: message, message, code: 'REMOTE_ACCESS_PERMISSION_REQUIRED' }, 403));
      }
      return Promise.resolve(res({}));
    });

    render(<ConnectDesktopButton deviceId="dev-1" />);
    fireEvent.click(screen.getByRole('button', { name: /connect desktop/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /connect desktop/i })).toHaveAttribute('aria-disabled', 'true');
    });
    expect(screen.queryByText(/connection failed/i)).toBeNull();
    const btn = screen.getByRole('button', { name: /connect desktop/i });
    expect(btn).toHaveAccessibleDescription(PERMISSION_REASON);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: expect.stringMatching(PERMISSION_REASON),
    }));
  });
});
