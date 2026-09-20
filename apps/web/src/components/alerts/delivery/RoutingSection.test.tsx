import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
import { fetchWithAuth } from '../../../stores/auth';
import RoutingSection from './RoutingSection';
import { showToast } from '../../shared/Toast';
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
  const view = render(
    <RoutingSection
      rules={rules} channels={channels} policies={policies}
      currentOrgId={opts.currentOrgId === undefined ? 'org-1' : opts.currentOrgId}
      isPartnerScope={opts.isPartnerScope ?? false}
      defaultOwnerScope="organization"
      onChanged={onChanged} onUnauthorized={() => {}}
    />
  );
  return { onChanged, ...view };
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

  it('confirms restoring the partner default, deletes the org row through runAction and reloads', async () => {
    const { onChanged } = renderSection([rule({ id: 'd-org', isDefault: true }),
      rule({ id: 'd-partner', orgId: null, partnerId: 'p-1', isDefault: true, channelIds: ['ch-partner'], escalationPolicyId: 'ep-1' })]);
    fireEvent.click(screen.getByTestId('routing-default-use-partner'));
    const dialog = screen.getByTestId('routing-delete-dialog');
    expect(dialog).toHaveTextContent("This organization will return to the partner's Everything else row");
    expect(dialog).toHaveTextContent('Partner NOC');
    expect(dialog).toHaveTextContent('On-call');
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('routing-delete-confirm'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/alerts/routing-rules/d-org', { method: 'DELETE' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('renders the inherited partner row with Customize again after the refreshed org override is gone', async () => {
    const partner: RoutingRule = { id: 'd-partner', name: 'Everything else', inherited: true, isDefault: true,
      enabled: true, conditions: {}, priority: 1000000, channelIds: ['ch-partner'], escalationPolicyId: 'ep-1' };
    const { onChanged, rerender } = renderSection([rule({ id: 'd-org', isDefault: true }), partner]);
    fireEvent.click(screen.getByTestId('routing-default-use-partner'));
    fireEvent.click(screen.getByTestId('routing-delete-confirm'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    rerender(<RoutingSection rules={[partner]} channels={channels} policies={policies} currentOrgId="org-1"
      isPartnerScope={false} defaultOwnerScope="organization" onChanged={onChanged} onUnauthorized={() => {}} />);
    expect(screen.getByTestId('routing-default-customize')).toBeInTheDocument();
    expect(screen.queryByTestId('routing-default-use-partner')).toBeNull();
    expect(screen.queryByTestId('routing-default-edit')).toBeNull();
    expect(screen.getByTestId('routing-row-default')).toHaveTextContent('Partner NOC');
  });

  it('explains inbox-only fallback and surfaces the server governance denial', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Organization-wide governance is required' }, false, 403));
    const { onChanged } = renderSection([rule({ id: 'd-org', isDefault: true })]);
    fireEvent.click(screen.getByTestId('routing-default-use-partner'));
    expect(screen.getByTestId('routing-delete-dialog')).toHaveTextContent('Alerts that match no row will be inbox-only');
    fireEvent.click(screen.getByTestId('routing-delete-confirm'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Organization-wide governance is required' })));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it.each([
    { currentOrgId: null, isPartnerScope: true },
    { currentOrgId: 'org-1', isPartnerScope: false },
  ])('never offers removal on a partner row in scope %j', (opts) => {
    renderSection([rule({ id: 'd-partner', orgId: null, partnerId: 'p-1', isDefault: true })], opts);
    expect(screen.queryByTestId('routing-default-use-partner')).toBeNull();
  });

  it('explains that customizing stops following partner changes and can be removed later', () => {
    renderSection([rule({ id: 'd-partner', orgId: null, partnerId: 'p-1', isDefault: true })]);
    expect(screen.getByTestId('routing-default-customize-hint')).toHaveTextContent("stops following changes to the partner's default");
    expect(screen.getByTestId('routing-default-customize-hint')).toHaveTextContent('removed later');
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
