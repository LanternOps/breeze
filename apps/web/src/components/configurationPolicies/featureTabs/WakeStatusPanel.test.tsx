import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

const m = vi.hoisted(() => ({
  fetch: vi.fn(),
  runAction: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => m.fetch(...a) }));
vi.mock('../../shared/Toast', () => ({ showToast: (...a: unknown[]) => m.toast(...a) }));
vi.mock('@/lib/runAction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/runAction')>('@/lib/runAction');
  return {
    ...actual,
    runAction: (opts: { request: () => Promise<Response> }) => {
      m.runAction(opts);
      return opts.request().then((r) => r.json());
    },
  };
});

import WakeStatusPanel from './WakeStatusPanel';

const row = (over: Record<string, unknown> = {}) => ({
  deviceId: 'dev-1', hostname: 'host-1', osType: 'windows', status: 'offline',
  state: 'ready', reasonCodes: [], vendor: 'dell', model: 'OptiPlex 7090',
  lastAttempt: null, consecutiveTimeouts: 0, testWakeAllowed: false, show: true, mode: 'always',
  ...over,
});

const page = (rows: unknown[], over: Record<string, unknown> = {}) => ({
  data: rows, counts: { ready: rows.length }, total: rows.length, page: 1, limit: 25, scanned: rows.length, capped: false, ...over,
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function load(body: unknown) {
  m.fetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return ok({ ok: true });
    return ok(body);
  });
}

describe('WakeStatusPanel', () => {
  beforeEach(() => {
    m.fetch.mockReset();
    m.runAction.mockReset();
    m.toast.mockReset();
  });

  it('logs the error (not a bare catch) when the status load fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.fetch.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    render(<WakeStatusPanel policyId="p1" />);
    await waitFor(() => expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('WakeStatusPanel'), expect.objectContaining({ message: 'status 500' }),
    ));
    consoleError.mockRestore();
  });

  // Observe-first amendment §2: "Observing (vendor)" with interface and code.
  it('shows Observing with the vendor, interface and error code, and no values', async () => {
    load(page([
      row({
        deviceId: 'a', hostname: 'host-a', state: 'unproven', reasonCodes: ['vendor_observe_only'], vendor: 'hp',
        observation: { vendor: 'hp', interface: 'absent', errorCode: '0x8004100E' },
      }),
      row({ deviceId: 'b', hostname: 'host-b', vendor: 'lenovo', observation: { vendor: 'lenovo', interface: 'present', errorCode: null } }),
      row({ deviceId: 'c', hostname: 'host-c', observation: null }),
      row({ deviceId: 'd', hostname: 'host-d' }),
    ]));
    render(<WakeStatusPanel policyId="p1" />);
    await screen.findByText('host-a');
    const a = screen.getByTestId('wake-observing-a').textContent ?? '';
    expect(a).toContain('Observing');
    expect(a).toContain('HP');
    expect(a).toContain('interface not present');
    expect(a).toContain('0x8004100E');
    const b = screen.getByTestId('wake-observing-b').textContent ?? '';
    expect(b).toContain('Lenovo');
    expect(b).toContain('interface present');
    expect(screen.queryByTestId('wake-observing-c')).toBeNull();
    expect(screen.queryByTestId('wake-observing-d')).toBeNull();
    expect(document.body.textContent).toContain('Observing vendor firmware (read only)');
  });

  it('says "came online", never "woke"', async () => {
    load(page([row({ lastAttempt: { outcome: 'came_online', refusalCode: null, at: '2026-11-15T10:00:00.000Z' } })]));
    render(<WakeStatusPanel policyId="p1" />);
    await screen.findByText('host-1');
    const text = document.body.textContent ?? '';
    expect(text.toLowerCase()).toContain('came online');
    expect(text.toLowerCase()).not.toMatch(/\bwoke\b/);
  });

  it('shows test wake only when testWakeAllowed', async () => {
    load(page([
      row({ deviceId: 'a', hostname: 'host-a', state: 'unproven', mode: 'verified', show: false, testWakeAllowed: true }),
      row({ deviceId: 'b', hostname: 'host-b' }),
    ]));
    render(<WakeStatusPanel policyId="p1" />);
    await screen.findByText('host-a');
    expect(screen.getByTestId('wake-test-a')).toBeTruthy();
    expect(screen.queryByTestId('wake-test-b')).toBeNull();
  });

  it('sends the test wake through runAction to the device command route', async () => {
    load(page([row({ deviceId: 'a', hostname: 'host-a', state: 'unproven', mode: 'verified', show: false, testWakeAllowed: true })]));
    render(<WakeStatusPanel policyId="p1" />);
    await screen.findByText('host-a');
    fireEvent.click(screen.getByTestId('wake-test-a'));
    await waitFor(() => expect(m.runAction).toHaveBeenCalledTimes(1));
    const post = m.fetch.mock.calls.find((c) => c[1]?.method === 'POST')!;
    expect(post[0]).toBe('/devices/a/commands');
    expect(JSON.parse(post[1].body)).toEqual({ type: 'wake', payload: { testWake: true } });
  });

  it('offers "allow wake again" only from 3 consecutive timeouts, via runAction', async () => {
    load(page([
      row({ deviceId: 'a', hostname: 'host-a', consecutiveTimeouts: 3 }),
      row({ deviceId: 'b', hostname: 'host-b', consecutiveTimeouts: 2 }),
    ]));
    render(<WakeStatusPanel policyId="p1" />);
    await screen.findByText('host-a');
    expect(screen.queryByTestId('wake-allow-b')).toBeNull();
    fireEvent.click(screen.getByTestId('wake-allow-a'));
    await waitFor(() => expect(m.runAction).toHaveBeenCalledTimes(1));
    const post = m.fetch.mock.calls.find((c) => c[1]?.method === 'POST')!;
    expect(post[0]).toBe('/configuration-policies/p1/wake-status/a/allow');
  });

  it('flags repeated timeouts even under always', async () => {
    load(page([row({ deviceId: 'a', hostname: 'host-a', mode: 'always', show: true, consecutiveTimeouts: 4 })]));
    render(<WakeStatusPanel policyId="p1" />);
    await screen.findByText('host-a');
    expect(screen.getByTestId('wake-flagged-a')).toBeTruthy();
  });

  it('shows the laptop and Modern Standby advisory', async () => {
    load(page([row()]));
    render(<WakeStatusPanel policyId="p1" />);
    await screen.findByText('host-1');
    const advisory = screen.getByTestId('wake-advisory').textContent ?? '';
    expect(advisory).toMatch(/laptop/i);
    expect(advisory).toMatch(/Modern Standby/i);
  });

  it('says so when the scan was capped', async () => {
    load(page([row()], { capped: true, scanned: 5000 }));
    render(<WakeStatusPanel policyId="p1" />);
    await screen.findByText('host-1');
    expect(screen.getByTestId('wake-capped-note').textContent).toContain('5000');
  });

  it('a count chip filters by state', async () => {
    load(page([row()], { counts: { ready: 1, unproven: 2 } }));
    render(<WakeStatusPanel policyId="p1" />);
    await screen.findByText('host-1');
    fireEvent.click(screen.getByTestId('wake-chip-unproven'));
    await waitFor(() => {
      const urls = m.fetch.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes('state=unproven'))).toBe(true);
    });
  });
});
