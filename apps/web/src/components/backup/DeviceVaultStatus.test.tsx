import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceVaultStatus from './DeviceVaultStatus';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

// #3531: a failed backup-vault status load or sync used to be swallowed, so a
// broken vault looked "never configured" and a failed sync looked complete.
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

// Mock the Toast singleton: the sync handler goes through runAction, so the
// toast is the sanctioned feedback channel and has to be asserted directly.
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

// Resolving a deferred response is not enough: the continuation runs on a later
// microtask. Without draining it, a `waitFor` whose condition is ALREADY true
// passes before the late work lands, so the guard under test never actually
// runs. Drain, then assert.
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const showToastMock = vi.mocked(showToast);

const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

// The real API contract (toVaultResponse): vaultType + lastSyncStatus, NOT
// type/status, and NO snapshotCount. Using the real shape is what lets these
// tests catch the field-mapping bug the panel had (always showed "Never synced").
const vault = {
  id: 'v1',
  vaultPath: '/srv/vault',
  vaultType: 'local',
  lastSyncStatus: 'completed',
  lastSyncAt: null,
};

describe('DeviceVaultStatus — failures are surfaced (#3531)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows an error (not silent success) when a sync POST fails', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.includes('/sync') && init?.method === 'POST') return json({}, false, 500);
      if (input.includes('/backup/vault')) return json({ data: [vault] });
      return json({}, false, 404);
    });

    render(<DeviceVaultStatus deviceId="dev-1" />);

    // Vault card renders.
    await screen.findByText('Sync Now');
    fireEvent.click(screen.getByRole('button', { name: /Sync Now/i }));

    // The failed sync must be visible, not swallowed: runAction toasts it, and
    // the inline banner persists next to the now-stale Last Sync / Status.
    expect(await screen.findByText("Couldn't start the sync. Please try again.")).toBeTruthy();
    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: "Couldn't start the sync. Please try again." }),
      );
    });
  });

  it('routes the sync through runAction, so a 200 {success:false} body is a failure', async () => {
    // The pre-#3531 handler only checked `response.ok`, so this body read as a
    // completed sync. runAction classifies it as a failure.
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.includes('/sync') && init?.method === 'POST') return json({ success: false, error: 'vault_locked' });
      if (input.includes('/backup/vault')) return json({ data: [vault] });
      return json({}, false, 404);
    });

    render(<DeviceVaultStatus deviceId="dev-1" />);
    await screen.findByText('Sync Now');
    fireEvent.click(screen.getByRole('button', { name: /Sync Now/i }));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
    expect(await screen.findByText("Couldn't start the sync. Please try again.")).toBeTruthy();
  });

  it('does not surface an inline error on a 401 (session expiry redirects instead)', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.includes('/sync') && init?.method === 'POST') return json({}, false, 401);
      if (input.includes('/backup/vault')) return json({ data: [vault] });
      return json({}, false, 404);
    });

    render(<DeviceVaultStatus deviceId="dev-1" />);
    await screen.findByText('Sync Now');
    fireEvent.click(screen.getByRole('button', { name: /Sync Now/i }));

    // runAction stays silent on 401 by design; an inline banner would flash
    // against the login redirect.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Sync Now/i }).hasAttribute('disabled')).toBe(false);
    });
    expect(screen.queryByText("Couldn't start the sync. Please try again.")).toBeNull();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('shows an error state on a failed status load, not "no vault configured"', async () => {
    fetchMock.mockResolvedValue(json({}, false, 500));

    render(<DeviceVaultStatus deviceId="dev-1" />);

    expect(await screen.findByText("Couldn't load vault status.")).toBeTruthy();
    // A load failure must NOT masquerade as the legitimate empty state.
    expect(screen.queryByText('No local vault configured for this device.')).toBeNull();
  });

  it('does not show an error on a successful load', async () => {
    fetchMock.mockResolvedValue(json({ data: [vault] }));

    render(<DeviceVaultStatus deviceId="dev-1" />);

    await screen.findByText('Sync Now');
    await waitFor(() => {
      expect(screen.queryByText("Couldn't load vault status.")).toBeNull();
    });
  });

  it('maps the API lastSyncStatus to the badge (a completed vault is NOT "Never synced")', async () => {
    fetchMock.mockResolvedValue(json({ data: [vault] })); // lastSyncStatus: 'completed'

    render(<DeviceVaultStatus deviceId="dev-1" />);

    // The panel used to read vault.status (undefined) and always render
    // "Never synced". It must reflect the real lastSyncStatus.
    expect(await screen.findByText('Completed')).toBeTruthy();
    expect(screen.queryByText('Never synced')).toBeNull();
    // vaultType (not `type`) must render too.
    expect(screen.getByText('local')).toBeTruthy();
  });

  it('normalizes a failed lastSyncStatus to the Failed badge', async () => {
    fetchMock.mockResolvedValue(json({ data: [{ ...vault, lastSyncStatus: 'failed' }] }));
    render(<DeviceVaultStatus deviceId="dev-1" />);
    expect(await screen.findByText('Failed')).toBeTruthy();
  });

  it('shows Never synced for a null lastSyncStatus (a brand-new vault)', async () => {
    fetchMock.mockResolvedValue(json({ data: [{ ...vault, lastSyncStatus: null }] }));
    render(<DeviceVaultStatus deviceId="dev-1" />);
    expect(await screen.findByText('Never synced')).toBeTruthy();
  });

  it('a late load for a previous device does not overwrite the current device', async () => {
    let resolveA: (r: Response) => void = () => {};
    const aPending = new Promise<Response>((res) => { resolveA = res; });
    fetchMock.mockImplementation(async (input: string) => {
      if (input.includes('deviceId=dev-A')) return aPending;
      if (input.includes('deviceId=dev-B')) return json({ data: [{ ...vault, vaultPath: '/vault-B' }] });
      return json({}, false, 404);
    });

    const { rerender } = render(<DeviceVaultStatus deviceId="dev-A" />);
    // Switch device before A's load resolves.
    rerender(<DeviceVaultStatus deviceId="dev-B" />);
    await screen.findByText('/vault-B');

    // A's stale response arrives now — it must NOT replace device B's vault.
    resolveA(json({ data: [{ ...vault, vaultPath: '/vault-A' }] }));
    await flush();
    expect(screen.getByText('/vault-B')).toBeTruthy();
    expect(screen.queryByText('/vault-A')).toBeNull();
  });

  it('a post-sync refresh for a previous device does not overwrite the current device', async () => {
    // Behavioral regression coverage for the device-switch-during-sync path. (In
    // production the late refresh takes the highest request id, so the live
    // deviceId guard — not the request id — is what rejects it.)
    let resolveSync: (r: Response) => void = () => {};
    const syncPending = new Promise<Response>((res) => { resolveSync = res; });
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.includes('/sync') && init?.method === 'POST') return syncPending; // device A's sync, deferred
      if (input.includes('deviceId=dev-A')) return json({ data: [{ ...vault, id: 'vA', vaultPath: '/vault-A' }] });
      if (input.includes('deviceId=dev-B')) return json({ data: [{ ...vault, id: 'vB', vaultPath: '/vault-B' }] });
      return json({}, false, 404);
    });

    const { rerender } = render(<DeviceVaultStatus deviceId="dev-A" />);
    await screen.findByText('/vault-A');
    // Start a sync on device A, then switch to B while its POST is in flight.
    fireEvent.click(screen.getByRole('button', { name: /Sync Now/i }));
    rerender(<DeviceVaultStatus deviceId="dev-B" />);
    await screen.findByText('/vault-B');

    // Device A's sync completes → its silent refresh must NOT clobber device B.
    resolveSync(json({}));
    await flush();
    expect(screen.getByText('/vault-B')).toBeTruthy();
    expect(screen.queryByText('/vault-A')).toBeNull();
  });

  it('does not leave the previous device’s vault (and its Sync button) on screen when the next device fails to load', async () => {
    // The parent does not key this component per device. Without clearing the
    // old vault, device B rendered device A's card — and Sync Now stayed bound
    // to A's vault.id, so clicking it would queue a sync against the WRONG
    // device. It also masked the error state, since `error && !vault` was false.
    fetchMock.mockImplementation(async (input: string) => {
      if (input.includes('deviceId=dev-A')) return json({ data: [{ ...vault, id: 'vA', vaultPath: '/vault-A' }] });
      if (input.includes('deviceId=dev-B')) return json({}, false, 500);
      return json({}, false, 404);
    });

    const { rerender } = render(<DeviceVaultStatus deviceId="dev-A" />);
    await screen.findByText('/vault-A');

    rerender(<DeviceVaultStatus deviceId="dev-B" />);

    // B's load failed: show B's error, never A's vault or a live Sync button.
    expect(await screen.findByText("Couldn't load vault status.")).toBeTruthy();
    expect(screen.queryByText('/vault-A')).toBeNull();
    expect(screen.queryByRole('button', { name: /Sync Now/i })).toBeNull();
  });

  it('shows the vault’s real lastSyncError instead of a fabricated snapshot count', async () => {
    // The list endpoint (toVaultResponse) returns lastSyncError but NOT
    // snapshotCount, so the old footer read "0 snapshots stored" for every
    // vault while the actual failure reason went unrendered.
    fetchMock.mockResolvedValue(
      json({ data: [{ ...vault, lastSyncStatus: 'failed', lastSyncError: 'vault path is not writable' }] }),
    );

    render(<DeviceVaultStatus deviceId="dev-1" />);

    expect(await screen.findByText('vault path is not writable')).toBeTruthy();
    expect(screen.queryByText(/snapshots? stored/i)).toBeNull();
  });

  it('does not write a late sync failure into the next device’s card', async () => {
    let failSync: (r: Response) => void = () => {};
    const syncPending = new Promise<Response>((res) => { failSync = res; });
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.includes('/sync') && init?.method === 'POST') return syncPending;
      if (input.includes('deviceId=dev-A')) return json({ data: [{ ...vault, id: 'vA', vaultPath: '/vault-A' }] });
      if (input.includes('deviceId=dev-B')) return json({ data: [{ ...vault, id: 'vB', vaultPath: '/vault-B' }] });
      return json({}, false, 404);
    });

    const { rerender } = render(<DeviceVaultStatus deviceId="dev-A" />);
    await screen.findByText('/vault-A');
    fireEvent.click(screen.getByRole('button', { name: /Sync Now/i }));
    rerender(<DeviceVaultStatus deviceId="dev-B" />);
    await screen.findByText('/vault-B');

    failSync(json({}, false, 500)); // device A's sync fails, after the switch
    await flush();

    // B's own Sync button must be usable, not disabled by A's operation...
    expect(screen.getByRole('button', { name: /Sync Now/i }).hasAttribute('disabled')).toBe(false);
    // ...and A's failure must not appear under B.
    expect(screen.queryByText("Couldn't start the sync. Please try again.")).toBeNull();
  });

  it('does not let a sync from a PREVIOUS visit to the same device write into the current one', async () => {
    // A -> B -> A. Guarding on the deviceId string alone is not enough: the id
    // matches again on the second visit, so the first visit's late failure would
    // land in the current card and its `finally` would clear the spinner of a
    // sync that is still running. The guard is a monotonic visit counter.
    let failFirstSync: (r: Response) => void = () => {};
    const firstSync = new Promise<Response>((res) => { failFirstSync = res; });
    let syncCalls = 0;
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.includes('/sync') && init?.method === 'POST') {
        syncCalls += 1;
        return syncCalls === 1 ? firstSync : new Promise<Response>(() => {}); // 2nd stays pending
      }
      if (input.includes('deviceId=dev-A')) return json({ data: [{ ...vault, id: 'vA', vaultPath: '/vault-A' }] });
      if (input.includes('deviceId=dev-B')) return json({ data: [{ ...vault, id: 'vB', vaultPath: '/vault-B' }] });
      return json({}, false, 404);
    });

    const { rerender } = render(<DeviceVaultStatus deviceId="dev-A" />);
    await screen.findByText('/vault-A');
    fireEvent.click(screen.getByRole('button', { name: /Sync Now/i })); // visit 1 sync

    rerender(<DeviceVaultStatus deviceId="dev-B" />);
    await screen.findByText('/vault-B');
    rerender(<DeviceVaultStatus deviceId="dev-A" />); // back to A — a NEW visit
    await screen.findByText('/vault-A');

    fireEvent.click(screen.getByRole('button', { name: /Sync Now/i })); // visit 2 sync, stays in flight
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Sync Now/i }).hasAttribute('disabled')).toBe(true);
    });

    failFirstSync(json({}, false, 500)); // visit 1's sync finally fails
    await flush();

    // The old visit must not clear the current spinner...
    expect(screen.getByRole('button', { name: /Sync Now/i }).hasAttribute('disabled')).toBe(true);
    // ...nor post its error over the live sync.
    expect(screen.queryByText("Couldn't start the sync. Please try again.")).toBeNull();
  });

  it('recovers via Retry after a transient load failure', async () => {
    fetchMock
      .mockResolvedValueOnce(json({}, false, 503)) // first load fails
      .mockResolvedValue(json({ data: [vault] })); // retry succeeds

    render(<DeviceVaultStatus deviceId="dev-1" />);

    const retry = await screen.findByRole('button', { name: /Retry/i });
    retry.click();

    expect(await screen.findByText('Sync Now')).toBeTruthy();
    expect(screen.queryByText("Couldn't load vault status.")).toBeNull();
  });
});
