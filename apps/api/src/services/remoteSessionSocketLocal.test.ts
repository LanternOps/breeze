import { beforeEach, describe, expect, it, vi } from 'vitest';

// #4142 W2: the role-safe boundary for terminal/tunnel browser-socket closes.
// A worker-role process must answer false WITHOUT loading either route module
// (each factory below records that it ran, so loading one is observable).

const h = vi.hoisted(() => ({
  role: 'all' as string,
  loaded: [] as string[],
  closeTerminalSession: vi.fn(async (_id: string) => true),
  closeTunnelSession: vi.fn(async (_id: string) => true),
}));

vi.mock('../config/env', () => ({ breezeRole: () => h.role }));
vi.mock('../routes/terminalWs', () => {
  h.loaded.push('terminalWs');
  return { closeTerminalSession: h.closeTerminalSession };
});
vi.mock('../routes/tunnelWs', () => {
  h.loaded.push('tunnelWs');
  return { closeTunnelSession: h.closeTunnelSession };
});

describe('remoteSessionSocketLocal', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    h.loaded = [];
  });

  it('on the worker role both functions return false and never import their route module', async () => {
    h.role = 'worker';
    const { closeLocalTerminalSession, closeLocalTunnelSession } = await import('./remoteSessionSocketLocal');

    await expect(closeLocalTerminalSession('term-1')).resolves.toBe(false);
    await expect(closeLocalTunnelSession('tun-1')).resolves.toBe(false);

    expect(h.loaded).toEqual([]);
    expect(h.closeTerminalSession).not.toHaveBeenCalled();
    expect(h.closeTunnelSession).not.toHaveBeenCalled();
  });

  it.each(['api', 'all'])('on the %s role they delegate to closeTerminalSession / closeTunnelSession', async (role) => {
    h.role = role;
    h.closeTerminalSession.mockResolvedValueOnce(false);
    const { closeLocalTerminalSession, closeLocalTunnelSession } = await import('./remoteSessionSocketLocal');

    await expect(closeLocalTerminalSession('term-1')).resolves.toBe(false);
    await expect(closeLocalTunnelSession('tun-1')).resolves.toBe(true);

    expect(h.closeTerminalSession).toHaveBeenCalledWith('term-1');
    expect(h.closeTunnelSession).toHaveBeenCalledWith('tun-1');
  });

  it('importing the module loads neither route module', async () => {
    h.role = 'all';
    await import('./remoteSessionSocketLocal');
    expect(h.loaded).toEqual([]);
  });
});
