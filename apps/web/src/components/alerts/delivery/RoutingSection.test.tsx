import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
import { fetchWithAuth } from '../../../stores/auth';
import RoutingSection from './RoutingSection';
import type { RoutingRule, EditableRoutingRule, EscalationPolicy } from './deliveryActions';
import type { NotificationChannel } from '../NotificationChannelList';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: 'x', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const channels = [
  { id: 'ch-org', name: 'Org email', type: 'email', enabled: true, config: {} },
  { id: 'ch-partner', name: 'Partner NOC', type: 'slack', enabled: true, config: {} },
] as unknown as NotificationChannel[];
const policies: EscalationPolicy[] = [{ id: 'ep-1', name: 'On-call', stepCount: 1, inherited: true }];
const rule = (o: Partial<EditableRoutingRule>): EditableRoutingRule => ({ id: 'r', orgId: 'org-1', partnerId: null, name: 'r', priority: 10, conditions: {}, channelIds: ['ch-org'], escalationPolicyId: null, enabled: true, isDefault: false, ...o });

function renderSection(rules: RoutingRule[], opts: { currentOrgId?: string | null; isPartnerScope?: boolean } = {}) {
  const onChanged = vi.fn(async () => {});
  render(
    <RoutingSection
      rules={rules} channels={channels} policies={policies}
      currentOrgId={opts.currentOrgId === undefined ? 'org-1' : opts.currentOrgId}
      isPartnerScope={opts.isPartnerScope ?? false}
      defaultOwnerScope="organization"
      onChanged={onChanged} onUnauthorized={() => {}}
    />
  );
  return { onChanged };
}

beforeEach(() => { vi.clearAllMocks(); fetchMock.mockImplementation(async () => json({ data: [] })); });

describe('RoutingSection (W05b)', () => {
  it('renders non-default rows by priority with org before partner, then the Everything else row last, with no delete button on it', () => {
    renderSection([
      rule({ id: 'd-org', name: 'Everything else', isDefault: true, priority: 1000000, channelIds: [] }),
      rule({ id: 'p5', name: 'Partner 5', orgId: null, partnerId: 'p-1', priority: 5, channelIds: ['ch-partner'] }),
      rule({ id: 'o5', name: 'Org 5', priority: 5 }),
    ]);
    const rows = screen.getAllByTestId(/^routing-row-(o5|p5|default)$/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['routing-row-o5', 'routing-row-p5', 'routing-row-default']);
    const def = screen.getByTestId('routing-row-default');
    expect(within(def).getByText('Inbox only')).toBeInTheDocument();
    expect(within(def).queryByTestId('routing-row-delete')).toBeNull();
    expect(within(screen.getByTestId('routing-row-p5')).getByTestId('routing-rule-partner-wide-badge')).toBeInTheDocument();
  });

  it('org view with only a partner Everything else row: read-only row + Customize creates the org row prefilled from the partner channels', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/alerts/routing-rules/default' && init?.method === 'PUT') return json({ data: { id: 'new' } });
      return json({ data: [] });
    });
    const { onChanged } = renderSection([
      { id: 'd-partner', name: 'Everything else', inherited: true, isDefault: true, enabled: true, conditions: {}, priority: 1000000, channelIds: ['ch-partner'], escalationPolicyId: 'ep-1' },
    ]);
    const def = screen.getByTestId('routing-row-default');
    expect(within(def).getByTestId('routing-rule-partner-wide-badge')).toBeInTheDocument();
    fireEvent.click(within(def).getByTestId('routing-default-customize'));
    const drawer = await screen.findByTestId('routing-rule-drawer');
    expect(within(drawer).getByLabelText('Partner NOC')).toBeChecked();
    fireEvent.click(within(drawer).getByLabelText('Org email'));
    fireEvent.click(within(drawer).getByTestId('routing-rule-drawer-save'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const put = fetchMock.mock.calls.find(([u, i]) => u === '/alerts/routing-rules/default' && (i as RequestInit)?.method === 'PUT')!;
    expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({ channelIds: ['ch-partner', 'ch-org'], escalationPolicyId: 'ep-1' });
  });

  it('never offers default deletion even when both axes have a row', () => {
    renderSection([rule({ id: 'd-org', isDefault: true }),
      rule({ id: 'd-partner', orgId: null, partnerId: 'p-1', isDefault: true })]);
    expect(screen.queryByTestId('routing-default-remove')).toBeNull();
  });

  it('no row anywhere: a synthesized Inbox only row whose Edit opens the default drawer', async () => {
    renderSection([]);
    const def = screen.getByTestId('routing-row-default');
    expect(within(def).getByText('Inbox only')).toBeInTheDocument();
    fireEvent.click(within(def).getByTestId('routing-default-edit'));
    expect(await screen.findByTestId('routing-rule-drawer')).toBeInTheDocument();
  });

  it('renders an exact inherited DTO without edit or delete controls', () => {
    renderSection([{ id: 'inherited', name: 'Partner routing', priority: 5, enabled: true, isDefault: false,
      conditions: { severities: ['high'], monitorKinds: ['cpu'], siteIds: [] }, channelIds: ['ch-partner'],
      escalationPolicyId: null, inherited: true }]);
    const row = screen.getByTestId('routing-row-inherited');
    expect(within(row).getByTestId('routing-rule-partner-wide-badge')).toBeInTheDocument();
    expect(within(row).queryByTestId('routing-row-edit')).toBeNull();
    expect(within(row).queryByTestId('routing-row-delete')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('new rule drawer posts monitorKinds, severities and escalationPolicyId', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/alerts/routing-rules' && init?.method === 'POST') return json({ data: { id: 'new' } });
      return json({ data: [] });
    });
    renderSection([]);
    fireEvent.click(screen.getByTestId('routing-add-rule'));
    const drawer = await screen.findByTestId('routing-rule-drawer');
    fireEvent.change(within(drawer).getByTestId('routing-rule-name'), { target: { value: 'Disk to NOC' } });
    fireEvent.click(within(drawer).getByTestId('routing-rule-severity-high'));
    fireEvent.click(within(drawer).getByTestId('routing-rule-kind-disk'));
    fireEvent.click(within(drawer).getByLabelText('Partner NOC'));
    fireEvent.change(within(drawer).getByTestId('routing-rule-escalation'), { target: { value: 'ep-1' } });
    fireEvent.click(within(drawer).getByTestId('routing-rule-drawer-save'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/alerts/routing-rules', expect.objectContaining({ method: 'POST' })));
    const post = fetchMock.mock.calls.find(([u, i]) => u === '/alerts/routing-rules' && (i as RequestInit)?.method === 'POST')!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toMatchObject({
      name: 'Disk to NOC', conditions: { severities: ['high'], monitorKinds: ['disk'] }, channelIds: ['ch-partner'], escalationPolicyId: 'ep-1', enabled: true,
    });
  });
});
