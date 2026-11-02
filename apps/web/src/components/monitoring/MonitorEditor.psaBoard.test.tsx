import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MonitorEditor from './MonitorEditor';
import { fetchWithAuth } from '../../stores/auth';

const authUser: { canManagePartnerWide?: boolean } = {};
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: authUser }),
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null }) => unknown) => selector({ currentOrgId: 'org-1' }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'partner-1' } }),
}));
vi.mock('@/hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({ isPartnerScope: true, defaultOwnerScope: 'organization' }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const MONITOR = {
  id: 'm1',
  name: 'Disk full',
  description: '',
  kind: 'disk',
  enabled: true,
  condition: { operator: 'gt', value: 90, durationMinutes: 5 },
  severity: 'high',
  cooldownMinutes: 5,
  autoResolve: false,
  responses: [],
  deliveryMode: 'inherit',
  deliveryChannelIds: [],
  escalationPolicyId: null,
  recurrenceThreshold: null,
  recurrenceWindowHours: null,
  recurrenceActions: [],
  pauseResponsesOnEscalation: true,
  aiAgentId: null,
  orgId: 'org-1',
  partnerId: null,
  attachments: [],
};

const BOARDS = { data: { boards: { options: [{ id: 5, name: 'Service' }, { id: 6, name: 'Alerts' }], truncated: false } } };

function install(opts: { monitor?: Record<string, unknown>; partner?: Response; options?: Response } = {}) {
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    if (input === '/monitor-definitions/m1' && !init) return json({ data: { ...MONITOR, ...opts.monitor } });
    if (input === '/monitor-definitions/m1' && init?.method === 'PATCH') return json({ data: { id: 'm1' } });
    if (input === '/orgs/partners/me') {
      return opts.partner ?? json({ serviceManagementMode: 'external', serviceManagementPsaConnectionId: 'conn-1' });
    }
    if (input === '/psa/connections/conn-1/alert-ticketing/options') return opts.options ?? json(BOARDS);
    if (input.startsWith('/monitor-definitions/kinds')) {
      return json({ data: [{ kind: 'disk', overridableKeys: ['value'], defaultSeverity: 'high', agentDelivered: false }] });
    }
    if (input.startsWith('/alerts/delivery/rails?rail=channels')) return json({ data: [], inherited: [] });
    return json({ data: [] });
  });
}

async function saveAndGetPatchBody() {
  await waitFor(() => expect(screen.getByTestId('monitor-editor-name')).toHaveValue('Disk full'));
  fireEvent.change(screen.getByTestId('monitor-editor-name'), { target: { value: 'Disk full 2' } });
  fireEvent.click(screen.getByTestId('monitor-editor-save'));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith('/monitor-definitions/m1', expect.objectContaining({ method: 'PATCH' })),
  );
  const call = fetchMock.mock.calls.find(([u, init]) => u === '/monitor-definitions/m1' && (init as RequestInit)?.method === 'PATCH');
  return JSON.parse((call![1] as RequestInit).body as string);
}

describe('MonitorEditor PSA board override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete authUser.canManagePartnerWide;
  });

  it('non-admin: no select, no partners/me call, and psaBoardId is omitted from the payload', async () => {
    authUser.canManagePartnerWide = false;
    install({ monitor: { psaBoardId: 6 } });
    render(<MonitorEditor monitorId="m1" />);
    const body = await saveAndGetPatchBody();
    expect(body).not.toHaveProperty('psaBoardId');
    expect(screen.queryByTestId('monitor-editor-psa-board')).toBeNull();
    expect(screen.getByTestId('monitor-editor-psa-board-readonly')).toHaveTextContent('Alert tickets go to PSA board #6');
    expect(fetchMock.mock.calls.some(([u]) => u === '/orgs/partners/me')).toBe(false);
  });

  it('admin: includes the chosen board id', async () => {
    authUser.canManagePartnerWide = true;
    install();
    render(<MonitorEditor monitorId="m1" />);
    const select = await screen.findByTestId('monitor-editor-psa-board');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Alerts' })).toBeInTheDocument());
    fireEvent.change(select, { target: { value: '6' } });
    const body = await saveAndGetPatchBody();
    expect(body.psaBoardId).toBe(6);
  });

  it('admin: choosing the default option sends null', async () => {
    authUser.canManagePartnerWide = true;
    install({ monitor: { psaBoardId: 5 } });
    render(<MonitorEditor monitorId="m1" />);
    const select = await screen.findByTestId('monitor-editor-psa-board');
    await waitFor(() => expect(select).toHaveValue('5'));
    expect(screen.queryByTestId('monitor-editor-psa-board-readonly')).toBeNull();
    fireEvent.change(select, { target: { value: '' } });
    const body = await saveAndGetPatchBody();
    expect(body).toHaveProperty('psaBoardId', null);
  });

  it('admin with a failing options lookup: hides the select, keeps the read-only line, omits the key', async () => {
    authUser.canManagePartnerWide = true;
    install({ monitor: { psaBoardId: 5 }, options: json({ error: 'PSA down' }, false, 502) });
    render(<MonitorEditor monitorId="m1" />);
    const body = await saveAndGetPatchBody();
    expect(body).not.toHaveProperty('psaBoardId');
    expect(screen.queryByTestId('monitor-editor-psa-board')).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('monitor-editor-psa-board-readonly')).toHaveTextContent('PSA board #5'),
    );
  });

  it('bound partner with a failing options call: shows the unavailable hint, warns once with the status only, omits psaBoardId', async () => {
    authUser.canManagePartnerWide = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    install({ options: json({ error: 'secret upstream body' }, false, 502) });
    render(<MonitorEditor monitorId="m1" />);
    expect(await screen.findByTestId('monitor-editor-psa-board-unavailable')).toHaveTextContent(
      'Could not load PSA boards, so the board override is unavailable right now.',
    );
    const body = await saveAndGetPatchBody();
    expect(body).not.toHaveProperty('psaBoardId');
    expect(screen.queryByTestId('monitor-editor-psa-board')).toBeNull();
    const psaWarns = warn.mock.calls.filter(c => String(c[0]).includes('PSA boards'));
    expect(psaWarns).toHaveLength(1);
    expect(JSON.stringify(psaWarns[0])).toContain('502');
    expect(JSON.stringify(psaWarns[0])).not.toContain('secret upstream body');
    warn.mockRestore();
  });

  it('unbound partner: no unavailable hint', async () => {
    authUser.canManagePartnerWide = true;
    install({ partner: json({ serviceManagementMode: 'native', serviceManagementPsaConnectionId: null }) });
    render(<MonitorEditor monitorId="m1" />);
    await saveAndGetPatchBody();
    expect(screen.queryByTestId('monitor-editor-psa-board-unavailable')).toBeNull();
  });

  it('admin without an external PSA bound: no select', async () => {
    authUser.canManagePartnerWide = true;
    install({ partner: json({ serviceManagementMode: 'native', serviceManagementPsaConnectionId: null }) });
    render(<MonitorEditor monitorId="m1" />);
    const body = await saveAndGetPatchBody();
    expect(body).not.toHaveProperty('psaBoardId');
    expect(screen.queryByTestId('monitor-editor-psa-board')).toBeNull();
  });
});
