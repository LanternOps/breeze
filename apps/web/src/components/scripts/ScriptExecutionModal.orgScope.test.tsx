import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ScriptExecutionModal, { type Device } from './ScriptExecutionModal';
import type { Script } from './ScriptList';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const baseScript: Script = {
  id: 'sc-1',
  name: 'Flush DNS Cache',
  language: 'powershell',
  category: 'Network',
  osTypes: ['windows'],
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
};

function respond(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const emptyOptions = {
  data: [],
  page: { nextCursor: null, returned: 0, total: 0, hasMore: false, observedAt: '2026-10-28T00:00:00.000Z' },
};

function installFetch() {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/device-groups')) return respond({ data: [] });
    return respond(emptyOptions);
  });
}

function requestedUrls(prefix: string): URL[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.startsWith(prefix))
    .map((url) => new URL(url, 'http://x'));
}

// #9934 — the server denies a device outside an org-owned script's org with
// `script_org_mismatch`; the picker must not offer such devices to begin with.
describe('ScriptExecutionModal script-org scoping (#9934)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFetch();
  });

  it('pins the device picker to an org-owned script\'s org when no orgId prop is passed', async () => {
    render(
      <ScriptExecutionModal
        script={{ ...baseScript, orgId: 'org-a' }}
        isOpen
        onClose={vi.fn()}
        onExecute={vi.fn()}
      />
    );
    await waitFor(() => expect(requestedUrls('/devices/options').length).toBeGreaterThan(0));
    for (const url of requestedUrls('/devices/options')) {
      expect(url.searchParams.get('orgId')).toBe('org-a');
    }
  });

  it('prefers the script\'s org over a caller orgId that disagrees with it', async () => {
    render(
      <ScriptExecutionModal
        script={{ ...baseScript, orgId: 'org-a' }}
        isOpen
        onClose={vi.fn()}
        onExecute={vi.fn()}
        orgId="org-b"
      />
    );
    await waitFor(() => expect(requestedUrls('/devices/options').length).toBeGreaterThan(0));
    for (const url of requestedUrls('/devices/options')) {
      expect(url.searchParams.get('orgId')).toBe('org-a');
    }
  });

  it('pins the device-group picker to the script\'s org', async () => {
    render(
      <ScriptExecutionModal
        script={{ ...baseScript, orgId: 'org-a' }}
        isOpen
        onClose={vi.fn()}
        onExecute={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('run-target-mode-groups'));
    await waitFor(() => expect(requestedUrls('/device-groups').length).toBeGreaterThan(0));
    for (const url of requestedUrls('/device-groups')) {
      expect(url.searchParams.get('orgId')).toBe('org-a');
    }
  });

  it('leaves a partner-wide script (no orgId) unpinned so every accessible org stays available', async () => {
    render(
      <ScriptExecutionModal
        script={{ ...baseScript, orgId: null, partnerId: 'p-1' }}
        isOpen
        onClose={vi.fn()}
        onExecute={vi.fn()}
      />
    );
    await waitFor(() => expect(requestedUrls('/devices/options').length).toBeGreaterThan(0));
    for (const url of requestedUrls('/devices/options')) {
      expect(url.searchParams.has('orgId')).toBe(false);
    }
  });
});

describe('ScriptExecutionModal offline confirm copy (#9934)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFetch();
  });

  function renderWith(devices: Device[]) {
    render(
      <ScriptExecutionModal
        script={baseScript}
        devices={devices}
        isOpen
        onClose={vi.fn()}
        onExecute={vi.fn()}
        initialDeviceIds={devices.map((d) => d.id)}
      />
    );
  }

  it('says an offline target runs when it comes back online, not "immediately"', async () => {
    renderWith([
      { id: 'd-1', hostname: 'clinic-pc-01', os: 'windows', status: 'offline', siteId: 's-1', siteName: 'HQ' },
    ]);
    fireEvent.click(screen.getByText('Execute'));
    const confirm = await screen.findByTestId('device-confirm-text');
    expect(confirm.textContent).not.toMatch(/immediately/i);
    expect(confirm.textContent).toMatch(/1 offline device\(s\) run when they come back online/);
  });

  it('counts only the offline targets in a mixed selection', async () => {
    renderWith([
      { id: 'd-1', hostname: 'ws-01', os: 'windows', status: 'online', siteId: 's-1', siteName: 'HQ' },
      { id: 'd-2', hostname: 'ws-02', os: 'windows', status: 'offline', siteId: 's-1', siteName: 'HQ' },
      { id: 'd-3', hostname: 'ws-03', os: 'windows', status: 'offline', siteId: 's-1', siteName: 'HQ' },
    ]);
    fireEvent.click(screen.getByText('Execute'));
    const confirm = await screen.findByTestId('device-confirm-text');
    expect(confirm.textContent).toContain('3 device(s)');
    expect(confirm.textContent).toMatch(/2 offline device\(s\) run when they come back online/);
  });

  it('says offline group members run when they come back online in group mode', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/device-groups/g-1/devices')) {
        return respond({
          data: [
            { deviceId: 'd-1', hostname: 'ws-01', status: 'online', osType: 'windows' },
            { deviceId: 'd-2', hostname: 'ws-02', status: 'offline', osType: 'windows' },
          ],
          total: 2,
        });
      }
      if (url.startsWith('/device-groups')) {
        return respond({ data: [{ id: 'g-1', name: 'Front desk', type: 'static', filterFieldsUsed: [], deviceCount: 2, siteId: null }] });
      }
      return respond(emptyOptions);
    });
    render(<ScriptExecutionModal script={baseScript} devices={[]} isOpen onClose={vi.fn()} onExecute={vi.fn()} />);
    fireEvent.click(screen.getByTestId('run-target-mode-groups'));
    fireEvent.click(await screen.findByTestId('group-checkbox-g-1'));
    await waitFor(() => expect(screen.getByTestId('group-summary').textContent).toContain('2'));
    fireEvent.click(screen.getByText('Execute'));
    const confirm = await screen.findByTestId('group-confirm-text');
    expect(confirm.textContent).not.toMatch(/immediately/i);
    expect(confirm.textContent).toMatch(/1 offline device\(s\) run when they come back online/);
  });

  it('keeps the immediate-start copy when every target is online', async () => {
    renderWith([
      { id: 'd-1', hostname: 'ws-01', os: 'windows', status: 'online', siteId: 's-1', siteName: 'HQ' },
    ]);
    fireEvent.click(screen.getByText('Execute'));
    const confirm = await screen.findByTestId('device-confirm-text');
    expect(confirm.textContent).toMatch(/begin executing immediately/);
  });
});
