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

const INHERIT_ALL = { cooldownMinutes: null, autoResolve: null, rearmMode: null, rearmDelayMinutes: null };
const MONITOR = {
  id: 'm1',
  name: 'Disk full',
  description: '',
  kind: 'disk',
  enabled: true,
  condition: { operator: 'gt', value: 90, durationMinutes: 5 },
  severity: 'high',
  ...INHERIT_ALL,
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
const EVENT_LOG_CONDITION = { category: 'application', level: 'error', countThreshold: 1, windowMinutes: 10 };

const EFFECTIVE = { autoResolve: false, rearmMode: 'new_evidence', rearmDelayMinutes: null, cooldownMinutes: 15 };
const DEFAULTS = {
  partner: { autoResolve: false, rearmMode: 'new_evidence', rearmDelayMinutes: null, cooldownMinutes: 5 },
  org: { autoResolve: null, rearmMode: null, rearmDelayMinutes: null, cooldownMinutes: 15 },
  effective: EFFECTIVE,
  sources: { autoResolve: 'partner', rearmMode: 'partner', rearmDelayMinutes: 'partner', cooldownMinutes: 'org' },
  monitorOverrideCounts: { autoResolve: 0, rearmMode: 0, rearmDelayMinutes: 0, cooldownMinutes: 0 },
};

function install(opts: { monitor?: Record<string, unknown>; defaults?: () => Response } = {}) {
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    if (input === '/monitor-definitions/m1' && !init) return json({ data: { ...MONITOR, ...opts.monitor } });
    if (input === '/monitor-definitions/m1' && init?.method === 'PATCH') return json({ data: { id: 'm1' } });
    if (input === '/monitor-definitions' && init?.method === 'POST') return json({ data: { id: 'new-1' } });
    if (input.startsWith('/alerts/lifecycle-defaults')) return opts.defaults ? opts.defaults() : json(DEFAULTS);
    if (input.startsWith('/monitor-definitions/kinds')) return json({ data: [] });
    if (input.startsWith('/alerts/delivery/rails?rail=channels')) return json({ data: [], inherited: [] });
    return json({ data: [] });
  });
}

const lifecycleCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/alerts/lifecycle-defaults'));

async function renderLoaded() {
  render(<MonitorEditor monitorId="m1" />);
  await waitFor(() => expect(screen.getByTestId('monitor-editor-name')).toHaveValue('Disk full'));
  await waitFor(() => expect(lifecycleCalls().length).toBeGreaterThan(0));
}

async function saveAndGetBody(method: 'PATCH' | 'POST' = 'PATCH') {
  fireEvent.click(screen.getByTestId('monitor-editor-save'));
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === method)).toBe(true),
  );
  const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === method);
  return JSON.parse((call![1] as RequestInit).body as string);
}

describe('MonitorEditor alert lifecycle section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });

  it('renames the noise block to Alert lifecycle', async () => {
    install();
    await renderLoaded();
    expect(screen.getByRole('heading', { name: 'Alert lifecycle' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Severity & noise' })).toBeNull();
  });

  it('Inherit sends null', async () => {
    install({ monitor: { cooldownMinutes: 30, autoResolve: true, rearmMode: 'after_delay', rearmDelayMinutes: 45 } });
    await renderLoaded();
    await waitFor(() => expect(screen.getByTestId('monitor-editor-cooldown')).toHaveValue(30));

    fireEvent.change(screen.getByTestId('monitor-editor-auto-resolve'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('monitor-editor-rearm-mode'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('monitor-editor-cooldown'), { target: { value: '' } });

    const body = await saveAndGetBody();
    expect(body).toMatchObject(INHERIT_ALL);
    // Explicit null on the wire: omitting a key on PATCH would leave the old value.
    for (const key of Object.keys(INHERIT_ALL)) expect(body).toHaveProperty(key, null);
  });

  it('On and Off send booleans', async () => {
    install();
    await renderLoaded();

    fireEvent.change(screen.getByTestId('monitor-editor-auto-resolve'), { target: { value: 'false' } });
    expect((await saveAndGetBody()).autoResolve).toBe(false);

    fetchMock.mockClear();
    fireEvent.change(screen.getByTestId('monitor-editor-auto-resolve'), { target: { value: 'true' } });
    expect((await saveAndGetBody()).autoResolve).toBe(true);
  });

  it('after_delay shows minutes and sends both', async () => {
    install();
    await renderLoaded();

    expect(screen.queryByTestId('monitor-editor-rearm-delay')).toBeNull();
    fireEvent.change(screen.getByTestId('monitor-editor-rearm-mode'), { target: { value: 'after_delay' } });
    fireEvent.change(await screen.findByTestId('monitor-editor-rearm-delay'), { target: { value: '30' } });

    const body = await saveAndGetBody();
    expect(body.rearmMode).toBe('after_delay');
    expect(body.rearmDelayMinutes).toBe(30);
  });

  it('after_delay without minutes blocks Save with a visible reason', async () => {
    install();
    await renderLoaded();

    fireEvent.change(screen.getByTestId('monitor-editor-rearm-mode'), { target: { value: 'after_delay' } });
    fireEvent.click(screen.getByTestId('monitor-editor-save'));

    await waitFor(() =>
      expect(screen.getByTestId('monitor-editor-rearm-delay-error')).toHaveTextContent(
        'Enter a whole number of minutes from 1 to 1440.',
      ),
    );
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toBe(false);
  });

  it('leaving after_delay clears the minutes, including an invalid value', async () => {
    install();
    await renderLoaded();

    fireEvent.change(screen.getByTestId('monitor-editor-rearm-mode'), { target: { value: 'after_delay' } });
    fireEvent.change(await screen.findByTestId('monitor-editor-rearm-delay'), { target: { value: '99999' } });
    fireEvent.change(screen.getByTestId('monitor-editor-rearm-mode'), { target: { value: 'new_evidence' } });
    expect(screen.queryByTestId('monitor-editor-rearm-delay')).toBeNull();

    const body = await saveAndGetBody();
    expect(body.rearmMode).toBe('new_evidence');
    expect(body.rearmDelayMinutes).toBeNull();
  });

  it('opening and saving a monitor with overrides changes nothing', async () => {
    const overrides = { cooldownMinutes: 30, autoResolve: true, rearmMode: 'after_delay', rearmDelayMinutes: 45 };
    install({ monitor: overrides });
    await renderLoaded();

    expect(await screen.findByTestId('monitor-editor-rearm-delay')).toHaveValue(45);
    expect(screen.getByTestId('monitor-editor-rearm-mode')).toHaveValue('after_delay');
    expect(screen.getByTestId('monitor-editor-auto-resolve')).toHaveValue('true');
    expect(screen.getByTestId('monitor-editor-cooldown')).toHaveValue(30);

    expect(await saveAndGetBody()).toMatchObject(overrides);
  });

  it('a stored delay with no after_delay mode cannot silently block Save', async () => {
    install({ monitor: { rearmMode: null, rearmDelayMinutes: 30 } });
    await renderLoaded();

    const body = await saveAndGetBody();
    expect(body.rearmMode).toBeNull();
    expect(body.rearmDelayMinutes).toBeNull();
  });

  it('shows the override disclosure when set', async () => {
    install({ monitor: { cooldownMinutes: 30, autoResolve: true, rearmMode: 'after_delay', rearmDelayMinutes: 45 } });
    await renderLoaded();

    await waitFor(() =>
      expect(screen.getByTestId('monitor-editor-lifecycle-override-cooldown')).toHaveTextContent(
        'This monitor overrides the org default (15)',
      ),
    );
    expect(screen.getByTestId('monitor-editor-lifecycle-override-auto-resolve')).toHaveTextContent(
      'This monitor overrides the partner default (Off)',
    );
    expect(screen.getByTestId('monitor-editor-lifecycle-override-rearm')).toHaveTextContent(
      'This monitor overrides the partner default (New evidence)',
    );
  });

  it('does not show the disclosure on an inheriting field', async () => {
    install();
    await renderLoaded();
    await waitFor(() => expect(screen.getByTestId('monitor-editor-cooldown')).toHaveAttribute('placeholder', '15'));

    expect(screen.queryByTestId('monitor-editor-lifecycle-override-cooldown')).toBeNull();
    expect(screen.queryByTestId('monitor-editor-lifecycle-override-auto-resolve')).toBeNull();
    expect(screen.queryByTestId('monitor-editor-lifecycle-override-rearm')).toBeNull();
  });

  it('warns when window is shorter than cooldown', async () => {
    install({ monitor: { kind: 'event_log', condition: EVENT_LOG_CONDITION } });
    await renderLoaded();

    const warning = await screen.findByTestId('monitor-editor-lifecycle-window-warning');
    expect(warning).toHaveTextContent('10');
    expect(warning).toHaveTextContent('15');

    // Non-blocking: Save still goes through.
    const body = await saveAndGetBody();
    expect(body.cooldownMinutes).toBeNull();
  });

  it('uses the monitor\'s own cooldown for the window warning', async () => {
    install({ monitor: { kind: 'event_log', condition: EVENT_LOG_CONDITION } });
    await renderLoaded();

    await screen.findByTestId('monitor-editor-lifecycle-window-warning');
    fireEvent.change(screen.getByTestId('monitor-editor-cooldown'), { target: { value: '10' } });
    await waitFor(() => expect(screen.queryByTestId('monitor-editor-lifecycle-window-warning')).toBeNull());
    fireEvent.change(screen.getByTestId('monitor-editor-cooldown'), { target: { value: '11' } });
    await screen.findByTestId('monitor-editor-lifecycle-window-warning');
  });

  it('no window warning for other kinds', async () => {
    install({ monitor: { condition: { ...MONITOR.condition, windowMinutes: 1 } } });
    await renderLoaded();
    await waitFor(() => expect(screen.getByTestId('monitor-editor-cooldown')).toHaveAttribute('placeholder', '15'));
    expect(screen.queryByTestId('monitor-editor-lifecycle-window-warning')).toBeNull();
  });

  it('existing monitor with null cooldown shows the inherited placeholder', async () => {
    install();
    await renderLoaded();

    const cooldown = screen.getByTestId('monitor-editor-cooldown');
    await waitFor(() => expect(cooldown).toHaveAttribute('placeholder', '15'));
    expect(cooldown).toHaveValue(null);
    expect(screen.getByText('Inherits from Org default')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('monitor-editor-auto-resolve')).getByRole('option', { name: 'Inherit (Off, Partner default)' }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('monitor-editor-rearm-mode')).getByRole('option', { name: 'Inherit (New evidence, Partner default)' }),
    ).toBeInTheDocument();
  });

  it('0 is a real cooldown, not inherit', async () => {
    install({ monitor: { cooldownMinutes: 0 } });
    await renderLoaded();

    await waitFor(() => expect(screen.getByTestId('monitor-editor-cooldown')).toHaveValue(0));
    await screen.findByTestId('monitor-editor-lifecycle-override-cooldown');
    expect((await saveAndGetBody()).cooldownMinutes).toBe(0);
  });

  it('an out-of-range cooldown is stopped by the input\'s own range check', async () => {
    install();
    await renderLoaded();

    const cooldown = screen.getByTestId('monitor-editor-cooldown') as HTMLInputElement;
    fireEvent.change(cooldown, { target: { value: '5000' } });
    expect(cooldown.validity.rangeOverflow).toBe(true);
    fireEvent.click(screen.getByTestId('monitor-editor-save'));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toBe(false);
  });

  it('a new monitor inherits everything by default', async () => {
    install();
    render(<MonitorEditor />);

    expect(screen.getByTestId('monitor-editor-auto-resolve')).toHaveValue('');
    expect(screen.getByTestId('monitor-editor-rearm-mode')).toHaveValue('');
    expect(screen.getByTestId('monitor-editor-cooldown')).toHaveValue(null);

    fireEvent.change(screen.getByTestId('monitor-editor-name'), { target: { value: 'New one' } });
    const body = await saveAndGetBody('POST');
    expect(body).toMatchObject(INHERIT_ALL);
  });

  it('reads the defaults for the monitor\'s own org', async () => {
    install();
    await renderLoaded();
    await waitFor(() =>
      expect(lifecycleCalls().at(-1)![0]).toBe(`/alerts/lifecycle-defaults?orgId=${ORG_ID}`),
    );
    expect(lifecycleCalls()).toHaveLength(1);
  });

  it('a partner-wide monitor reads the partner default and says orgs may differ', async () => {
    install({
      monitor: { orgId: null, partnerId: 'partner-1' },
      defaults: () => json({ ...DEFAULTS, org: null, effective: DEFAULTS.partner, sources: { autoResolve: 'partner', rearmMode: 'partner', rearmDelayMinutes: 'partner', cooldownMinutes: 'partner' } }),
    });
    await renderLoaded();

    await waitFor(() => expect(lifecycleCalls().at(-1)![0]).toBe('/alerts/lifecycle-defaults'));
    expect(lifecycleCalls().at(-1)![1]).toMatchObject({ skipOrgIdInjection: true });
    await waitFor(() => expect(screen.getByTestId('monitor-editor-cooldown')).toHaveAttribute('placeholder', '5'));
    expect(screen.getByText('An organization with its own default uses that instead of the inherited value shown here.')).toBeInTheDocument();
  });

  it('a failed defaults read says so, and still saves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    install({ monitor: { cooldownMinutes: 30 }, defaults: () => json({ error: 'nope' }, false, 500) });
    await renderLoaded();

    await screen.findByTestId('monitor-editor-lifecycle-unavailable');
    expect(screen.getByTestId('monitor-editor-cooldown')).not.toHaveAttribute('placeholder');
    expect(
      within(screen.getByTestId('monitor-editor-auto-resolve')).getByRole('option', { name: 'Inherit' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('monitor-editor-lifecycle-override-cooldown')).toHaveTextContent(
      'This monitor overrides the inherited default.',
    );

    const body = await saveAndGetBody();
    expect(body.cooldownMinutes).toBe(30);
    warn.mockRestore();
  });
});
