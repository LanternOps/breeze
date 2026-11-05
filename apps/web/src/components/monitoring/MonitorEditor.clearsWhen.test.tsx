import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MonitorEditor from './MonitorEditor';
import { fetchWithAuth } from '../../stores/auth';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { canManagePartnerWide: false } }),
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null }) => unknown) => selector({ currentOrgId: ORG_ID }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved', claims: { scope: 'organization', orgId: ORG_ID, partnerId: null } }),
}));
vi.mock('@/hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({ isPartnerScope: false, defaultOwnerScope: 'organization' }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const TRIGGER = {
  category: 'application',
  level: 'warning',
  sourcePattern: 'APCPBEAgent',
  messagePattern: 'On Battery',
  countThreshold: 1,
  windowMinutes: 10,
};
const RECOVERY = {
  category: 'application',
  level: 'info',
  sourcePattern: 'APCPBEAgent',
  messagePattern: 'Power Restored',
  countThreshold: 1,
  windowMinutes: 60,
};
const RAW_LEAF = { type: 'event_log', category: 'system', level: 'info', countThreshold: 2, windowMinutes: 30 };
const MONITOR = {
  id: 'm1',
  name: 'UPS on battery',
  description: '',
  kind: 'event_log',
  enabled: true,
  condition: TRIGGER,
  severity: 'high',
  cooldownMinutes: 30,
  autoResolve: true,
  autoResolveConditions: null,
  rearmMode: null,
  rearmDelayMinutes: null,
  responses: [],
  deliveryMode: 'inherit',
  deliveryChannelIds: [],
  escalationPolicyId: null,
  recurrenceThreshold: null,
  recurrenceWindowHours: null,
  recurrenceActions: [],
  pauseResponsesOnEscalation: true,
  aiAgentId: null,
  orgId: ORG_ID,
  partnerId: null,
  attachments: [],
};
const DISK = { kind: 'disk', condition: { operator: 'gt', value: 90, durationMinutes: 5 } };

const EFFECTIVE = { autoResolve: false, rearmMode: 'new_evidence', rearmDelayMinutes: null, cooldownMinutes: 5 };
const DEFAULTS = {
  partner: EFFECTIVE,
  org: { autoResolve: null, rearmMode: null, rearmDelayMinutes: null, cooldownMinutes: null },
  effective: EFFECTIVE,
  sources: { autoResolve: 'partner', rearmMode: 'partner', rearmDelayMinutes: 'partner', cooldownMinutes: 'partner' },
  monitorOverrideCounts: { autoResolve: 0, rearmMode: 0, rearmDelayMinutes: 0, cooldownMinutes: 0 },
};

function install(opts: { monitor?: Record<string, unknown>; defaults?: () => Response } = {}) {
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    if (input === '/monitor-definitions/m1' && !init) return json({ data: { ...MONITOR, ...opts.monitor } });
    if (input === '/monitor-definitions/m1' && init?.method === 'PATCH') return json({ data: { id: 'm1' } });
    if (input === '/monitor-definitions' && init?.method === 'POST') return json({ data: { id: 'new-1' } });
    if (input.startsWith('/alerts/lifecycle-defaults')) return opts.defaults ? opts.defaults() : json(DEFAULTS);
    return json({ data: [] });
  });
}

const lifecycleCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/alerts/lifecycle-defaults'));

async function renderLoaded() {
  render(<MonitorEditor monitorId="m1" />);
  await waitFor(() => expect(screen.getByTestId('monitor-editor-name')).toHaveValue('UPS on battery'));
  await waitFor(() => expect(lifecycleCalls().length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.getByTestId('monitor-editor-cooldown')).toHaveAttribute('placeholder', '5'));
}

async function saveAndGetBody(method: 'PATCH' | 'POST' = 'PATCH') {
  fireEvent.click(screen.getByTestId('monitor-editor-save'));
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === method)).toBe(true),
  );
  const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === method);
  return JSON.parse((call![1] as RequestInit).body as string);
}

describe('MonitorEditor "Clears when"', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });

  describe('shows Clears when only for event_log with auto-resolve on', () => {
    it('event_log with auto-resolve on', async () => {
      install();
      await renderLoaded();
      expect(screen.getByTestId('monitor-editor-clears-when')).toBeInTheDocument();
    });

    it('event_log with auto-resolve off', async () => {
      install({ monitor: { autoResolve: false } });
      await renderLoaded();
      expect(screen.queryByTestId('monitor-editor-clears-when')).toBeNull();
    });

    it('another kind with auto-resolve on', async () => {
      install({ monitor: DISK });
      await renderLoaded();
      expect(screen.queryByTestId('monitor-editor-clears-when')).toBeNull();
    });

    it('follows the inherited value when the monitor inherits auto-resolve', async () => {
      install({
        monitor: { autoResolve: null },
        defaults: () => json({ ...DEFAULTS, effective: { ...EFFECTIVE, autoResolve: true } }),
      });
      await renderLoaded();
      expect(screen.getByTestId('monitor-editor-clears-when')).toBeInTheDocument();
    });

    it('hidden when the monitor inherits an inherited Off', async () => {
      install({ monitor: { autoResolve: null } });
      await renderLoaded();
      expect(screen.queryByTestId('monitor-editor-clears-when')).toBeNull();
    });

    it('appears when the operator turns auto-resolve on', async () => {
      install({ monitor: { autoResolve: false } });
      await renderLoaded();
      fireEvent.change(screen.getByTestId('monitor-editor-auto-resolve'), { target: { value: 'true' } });
      expect(await screen.findByTestId('monitor-editor-clears-when')).toBeInTheDocument();
    });
  });

  it('prefills category and source from the trigger', async () => {
    install({ monitor: { condition: { ...TRIGGER, category: 'system', sourcePattern: 'Kernel-Power' } } });
    await renderLoaded();

    fireEvent.click(screen.getByTestId('clears-when-add'));

    expect(await screen.findByTestId('clears-when-source')).toHaveValue('Kernel-Power');
    expect(screen.getByTestId('clears-when-category')).toHaveValue('system');
    expect(screen.getByTestId('clears-when-level')).toHaveValue('info');
    expect(screen.getByTestId('clears-when-window')).toHaveValue(60);
    expect(screen.getByTestId('clears-when-message')).toHaveValue('');
    expect(screen.getByTestId('monitor-editor-clears-when')).toHaveTextContent(
      "Clears only on an event logged after the alert's trigger event.",
    );
  });

  it('an authored condition goes on the wire in the kind shape', async () => {
    install();
    await renderLoaded();

    fireEvent.click(screen.getByTestId('clears-when-add'));
    fireEvent.change(await screen.findByTestId('clears-when-message'), { target: { value: 'Power Restored' } });

    expect((await saveAndGetBody()).autoResolveConditions).toEqual(RECOVERY);
  });

  it('opening and saving a monitor with no recovery condition does not add one', async () => {
    // A prefilled condition saved by accident would clear on any Information event
    // from that source, so the prefill only applies once the operator asks for it.
    install();
    await renderLoaded();

    expect(screen.queryByTestId('clears-when-source')).toBeNull();
    expect((await saveAndGetBody()).autoResolveConditions).toBeNull();
  });

  it('round-trips an existing recovery condition', async () => {
    install({ monitor: { autoResolveConditions: RECOVERY } });
    await renderLoaded();

    expect(await screen.findByTestId('clears-when-message')).toHaveValue('Power Restored');
    expect(screen.getByTestId('clears-when-source')).toHaveValue('APCPBEAgent');
    expect((await saveAndGetBody()).autoResolveConditions).toEqual(RECOVERY);
  });

  it('removing the condition sends null', async () => {
    install({ monitor: { autoResolveConditions: RECOVERY } });
    await renderLoaded();

    fireEvent.click(await screen.findByTestId('clears-when-remove'));

    await waitFor(() => expect(screen.queryByTestId('clears-when-source')).toBeNull());
    expect((await saveAndGetBody()).autoResolveConditions).toBeNull();
  });

  it('turning auto-resolve off keeps the condition for when it comes back on', async () => {
    install({ monitor: { autoResolveConditions: RECOVERY } });
    await renderLoaded();

    fireEvent.change(screen.getByTestId('monitor-editor-auto-resolve'), { target: { value: 'false' } });
    await waitFor(() => expect(screen.queryByTestId('monitor-editor-clears-when')).toBeNull());

    const body = await saveAndGetBody();
    expect(body.autoResolve).toBe(false);
    expect(body.autoResolveConditions).toEqual(RECOVERY);
  });

  it('a failed defaults read never loses a stored condition', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    install({
      monitor: { autoResolve: null, autoResolveConditions: RECOVERY },
      defaults: () => json({ error: 'nope' }, false, 500),
    });
    render(<MonitorEditor monitorId="m1" />);
    await screen.findByTestId('monitor-editor-lifecycle-unavailable');

    expect((await saveAndGetBody()).autoResolveConditions).toEqual(RECOVERY);
    warn.mockRestore();
  });

  it('a failed defaults read still shows a stored condition, so it can be seen and removed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    install({
      monitor: { autoResolve: null, autoResolveConditions: RECOVERY },
      defaults: () => json({ error: 'nope' }, false, 500),
    });
    render(<MonitorEditor monitorId="m1" />);

    expect(await screen.findByTestId('clears-when-message')).toHaveValue('Power Restored');
    warn.mockRestore();
  });

  it('a failed defaults read shows no section when there is nothing stored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    install({ monitor: { autoResolve: null }, defaults: () => json({ error: 'nope' }, false, 500) });
    render(<MonitorEditor monitorId="m1" />);

    await screen.findByTestId('monitor-editor-lifecycle-unavailable');
    expect(screen.queryByTestId('monitor-editor-clears-when')).toBeNull();
    warn.mockRestore();
  });

  it('switching to a kind with no recovery schema clears an authored condition', async () => {
    install({ monitor: { autoResolveConditions: RECOVERY } });
    await renderLoaded();
    await screen.findByTestId('clears-when-source');

    fireEvent.change(screen.getByTestId('monitor-editor-kind'), { target: { value: 'offline' } });
    await waitFor(() => expect(screen.queryByTestId('monitor-editor-clears-when')).toBeNull());

    const body = await saveAndGetBody();
    expect(body.kind).toBe('offline');
    expect(body.autoResolveConditions).toBeNull();
  });

  it('an invalid value blocks Save with a visible reason, even once the section is hidden', async () => {
    install({ monitor: { autoResolveConditions: RECOVERY } });
    await renderLoaded();

    fireEvent.change(await screen.findByTestId('clears-when-count'), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('monitor-editor-auto-resolve'), { target: { value: 'false' } });
    await waitFor(() => expect(screen.queryByTestId('monitor-editor-clears-when')).toBeNull());
    // The DOM's own min check goes with the unmounted input, so the schema is what stops this.
    fireEvent.click(screen.getByTestId('monitor-editor-save'));

    expect(await screen.findByTestId('clears-when-error')).toBeInTheDocument();
    expect(screen.getByTestId('monitor-editor-clears-when')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toBe(false);
  });

  it('warns under the recovery fields when that source is not collected at Information', async () => {
    install({ monitor: { autoResolveConditions: { ...RECOVERY, sourcePattern: 'Nothing-Collects-This' } } });
    await renderLoaded();

    expect(await screen.findByTestId('clears-when-collection-warning')).toHaveTextContent('Nothing-Collects-This');
  });

  describe('a raw recovery condition saved through the API', () => {
    it('round-trips an existing raw recovery condition without dropping it', async () => {
      install({ monitor: { autoResolveConditions: RAW_LEAF } });
      await renderLoaded();

      const raw = await screen.findByTestId('clears-when-raw');
      expect(within(raw).getByText('Custom recovery condition (API)')).toBeInTheDocument();
      expect(raw).toHaveTextContent('"countThreshold": 2');
      expect(screen.queryByTestId('clears-when-source')).toBeNull();

      // PATCH omits the key, which is what keeps the stored value byte for byte.
      expect(await saveAndGetBody()).not.toHaveProperty('autoResolveConditions');
    });

    it('a group with logic is shown read-only too', async () => {
      const group = { logic: 'or', conditions: [RAW_LEAF, RAW_LEAF] };
      install({ monitor: { autoResolveConditions: group } });
      await renderLoaded();

      expect(await screen.findByTestId('clears-when-raw')).toHaveTextContent('"logic": "or"');
      expect(await saveAndGetBody()).not.toHaveProperty('autoResolveConditions');
    });

    it('#10935: a stored group with no logic is visible and does not block Save', async () => {
      const broken = { conditions: [RAW_LEAF] };
      install({ monitor: { autoResolveConditions: broken } });
      await renderLoaded();

      expect(await screen.findByTestId('clears-when-raw')).toHaveTextContent('"conditions"');
      expect(screen.getByTestId('clears-when-raw-unusable')).toHaveTextContent("can't be evaluated");
      expect(await saveAndGetBody()).not.toHaveProperty('autoResolveConditions');
    });

    it('a raw condition the engine can evaluate does not say it is unusable', async () => {
      install({ monitor: { autoResolveConditions: RAW_LEAF } });
      await renderLoaded();

      await screen.findByTestId('clears-when-raw');
      expect(screen.queryByTestId('clears-when-raw-unusable')).toBeNull();
    });

    it('changing the kind drops a stored value that could never be evaluated, or the API would refuse the save', async () => {
      install({ monitor: { autoResolveConditions: { conditions: [RAW_LEAF] } } });
      await renderLoaded();
      await screen.findByTestId('clears-when-raw');

      fireEvent.change(screen.getByTestId('monitor-editor-kind'), { target: { value: 'offline' } });

      expect((await saveAndGetBody()).autoResolveConditions).toBeNull();
    });

    it('changing the kind keeps a raw condition the engine can evaluate', async () => {
      install({ monitor: { autoResolveConditions: RAW_LEAF } });
      await renderLoaded();
      await screen.findByTestId('clears-when-raw');

      fireEvent.change(screen.getByTestId('monitor-editor-kind'), { target: { value: 'offline' } });

      expect(await saveAndGetBody()).not.toHaveProperty('autoResolveConditions');
    });

    it('survives on a kind where the section is hidden', async () => {
      install({ monitor: { ...DISK, autoResolveConditions: { type: 'threshold', metric: 'diskPercent', operator: 'lt', value: 50 } } });
      await renderLoaded();

      expect(screen.queryByTestId('clears-when-raw')).toBeNull();
      expect(await saveAndGetBody()).not.toHaveProperty('autoResolveConditions');
    });

    it('survives turning auto-resolve off', async () => {
      install({ monitor: { autoResolveConditions: RAW_LEAF } });
      await renderLoaded();

      fireEvent.change(screen.getByTestId('monitor-editor-auto-resolve'), { target: { value: 'false' } });
      await waitFor(() => expect(screen.queryByTestId('clears-when-raw')).toBeNull());
      expect(await saveAndGetBody()).not.toHaveProperty('autoResolveConditions');
    });

    it('Replace swaps in a prefilled condition, and only Save sends it', async () => {
      install({ monitor: { autoResolveConditions: RAW_LEAF } });
      await renderLoaded();

      fireEvent.click(await screen.findByTestId('clears-when-replace'));

      expect(await screen.findByTestId('clears-when-source')).toHaveValue('APCPBEAgent');
      expect(screen.queryByTestId('clears-when-raw')).toBeNull();
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toBe(false);

      fireEvent.change(screen.getByTestId('clears-when-message'), { target: { value: 'Power Restored' } });
      expect((await saveAndGetBody()).autoResolveConditions).toEqual(RECOVERY);
    });

    it('backing out of Replace keeps the raw condition', async () => {
      install({ monitor: { autoResolveConditions: RAW_LEAF } });
      await renderLoaded();

      fireEvent.click(await screen.findByTestId('clears-when-replace'));
      fireEvent.click(await screen.findByTestId('clears-when-remove'));

      expect(await screen.findByTestId('clears-when-raw')).toBeInTheDocument();
      expect(await saveAndGetBody()).not.toHaveProperty('autoResolveConditions');
    });
  });

  it('a new event_log monitor can author one, and POST carries it', async () => {
    install({ defaults: () => json({ ...DEFAULTS, effective: { ...EFFECTIVE, autoResolve: true } }) });
    render(<MonitorEditor />);
    fireEvent.change(screen.getByTestId('monitor-editor-name'), { target: { value: 'New UPS' } });
    fireEvent.change(screen.getByTestId('monitor-editor-kind'), { target: { value: 'event_log' } });

    fireEvent.click(await screen.findByTestId('clears-when-add'));
    fireEvent.change(await screen.findByTestId('clears-when-message'), { target: { value: 'Power Restored' } });

    const body = await saveAndGetBody('POST');
    expect(body.autoResolveConditions).toMatchObject({ category: 'application', level: 'info', messagePattern: 'Power Restored' });
  });

  it('a new monitor with no recovery condition sends null', async () => {
    install();
    render(<MonitorEditor />);
    fireEvent.change(screen.getByTestId('monitor-editor-name'), { target: { value: 'New one' } });

    expect((await saveAndGetBody('POST')).autoResolveConditions).toBeNull();
  });
});
