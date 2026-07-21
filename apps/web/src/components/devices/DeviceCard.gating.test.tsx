import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceCard from './DeviceCard';
import type { Device, DeviceStatus } from './DeviceList';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const baseDevice: Device = {
  id: 'device-1',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 58,
  ramPercent: 71,
  lastSeen: '2026-02-09T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  tags: []
};

function openCardMenu(status: DeviceStatus, onAction = vi.fn()) {
  const device: Device = { ...baseDevice, status };
  render(<DeviceCard device={device} onAction={onAction} />);
  fireEvent.click(screen.getByLabelText(`Actions for ${device.hostname}`));
  return { onAction };
}

const terminalBtn = () => screen.getByRole('button', { name: /remote terminal/i });
const runScriptBtn = () => screen.getByRole('button', { name: /run script/i });
const rebootBtn = () => screen.getByRole('button', { name: /^reboot/i });

// #2488: the grid DeviceCard menu previously had zero gating — Run Script fired
// on decommissioned devices (reproducing #2426 in grid view) and Remote
// Terminal fired doomed requests on offline devices.
describe('DeviceCard action gating (#2488)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ metrics: [] }));
  });

  it('online device: all command actions are enabled', () => {
    openCardMenu('online');
    expect(terminalBtn()).toBeEnabled();
    expect(runScriptBtn()).toBeEnabled();
    expect(rebootBtn()).toBeEnabled();
  });

  it('offline device: Remote Terminal (live session) is disabled; queued commands stay enabled', () => {
    const { onAction } = openCardMenu('offline');

    expect(terminalBtn()).toBeDisabled();
    // Queued commands run on reconnect, so offline devices keep them.
    expect(runScriptBtn()).toBeEnabled();
    expect(rebootBtn()).toBeEnabled();

    // The real failure mode is a disabled gate that still dispatches.
    fireEvent.click(terminalBtn());
    expect(onAction).not.toHaveBeenCalledWith('terminal', expect.anything());
  });

  // Remote Terminal is the one live-session action on this card, so a disabled
  // device must get a tooltip naming its ACTUAL status (not a blanket "not
  // online"). This asserts the wiring to the shared per-status map in
  // bulkActionGating.ts, not just the strings.
  it.each([
    ['offline', 'Device is offline'],
    ['maintenance', 'Device is in maintenance mode'],
    ['decommissioned', 'Device is decommissioned'],
    ['quarantined', 'Device is quarantined'],
    ['updating', 'Device is updating'],
    ['pending', 'Device is pending enrollment'],
  ] as const)(
    'Remote Terminal on a %s device is disabled and names the actual status',
    (status, expectedTitle) => {
      openCardMenu(status);
      // `disabled` and `title` come from independent expressions, so assert
      // both — the tooltip alone does NOT imply the gate is actually applied.
      expect(terminalBtn()).toBeDisabled();
      expect(terminalBtn()).toHaveAttribute('title', expectedTitle);
    },
  );

  // The mirror of the above for QUEUED commands: these must stay ENABLED on
  // every non-decommissioned status. Disabling them is a capability removal
  // (the command would have run on reconnect), which is the regression #2426
  // and #2465 were both about — and it is invisible to a tooltip-only test.
  it.each(['offline', 'maintenance', 'quarantined', 'updating', 'pending'] as const)(
    'Run Script and Reboot stay enabled on a %s device',
    (status) => {
      const { onAction } = openCardMenu(status);

      expect(runScriptBtn()).toBeEnabled();
      expect(rebootBtn()).toBeEnabled();

      fireEvent.click(rebootBtn());
      expect(onAction).toHaveBeenCalledWith('reboot', expect.objectContaining({ status }));
    },
  );

  it('an enabled action carries no tooltip', () => {
    openCardMenu('online');
    for (const btn of [terminalBtn(), runScriptBtn(), rebootBtn()]) {
      expect(btn).not.toHaveAttribute('title');
    }
  });

  it('decommissioned device: queued commands + live session all disabled and do not dispatch', () => {
    const { onAction } = openCardMenu('decommissioned');

    expect(runScriptBtn()).toBeDisabled();
    expect(rebootBtn()).toBeDisabled();
    expect(terminalBtn()).toBeDisabled();

    fireEvent.click(runScriptBtn());
    fireEvent.click(rebootBtn());
    fireEvent.click(terminalBtn());
    expect(onAction).not.toHaveBeenCalled();
  });
});

// #2630: a `title` never renders on touch, and a `disabled` button is removed
// from the tab order — so for a keyboard or screen-reader user the reason was
// literally unreachable. The reason is therefore also visible text, wired to the
// disabled control via aria-describedby (pattern: QuoteActions, #1975).
describe('DeviceCard disabled-action reason is reachable without hover (#2630)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ metrics: [] }));
  });

  const hint = () => screen.queryByTestId(`device-${baseDevice.id}-action-gate-hint`);

  it('online device: no gate, so no hint and no description on any action', () => {
    openCardMenu('online');
    expect(hint()).toBeNull();
    expect(terminalBtn()).not.toHaveAttribute('aria-describedby');
    expect(runScriptBtn()).not.toHaveAttribute('aria-describedby');
  });

  it('offline device: hint names the reason AND scopes it to the live session only', () => {
    openCardMenu('offline');

    const el = hint();
    expect(el).not.toBeNull();
    expect(el).toHaveTextContent('Device is offline');
    // Must not read as though everything is blocked — Run Script and Reboot are
    // still enabled here, and saying otherwise would teach the false premise.
    expect(el).toHaveTextContent(/Remote Terminal needs a connected agent/i);

    expect(terminalBtn()).toHaveAttribute('aria-describedby', el!.id);
    expect(runScriptBtn()).not.toHaveAttribute('aria-describedby');
  });

  it('decommissioned device: hint covers all commands and every disabled action points at it', () => {
    openCardMenu('decommissioned');

    const el = hint();
    expect(el).toHaveTextContent('Device is decommissioned');
    expect(el).toHaveTextContent(/no agent to run commands/i);

    for (const btn of [terminalBtn(), runScriptBtn(), rebootBtn()]) {
      expect(btn).toHaveAttribute('aria-describedby', el!.id);
    }
  });
});
