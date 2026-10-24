import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TicketRoutingRule } from '@breeze/shared';

const fetchWithAuth = vi.fn();
const { scopeState, claimsState, showToast } = vi.hoisted(() => ({
  scopeState: {
    isPartnerScope: true,
    defaultOwnerScope: 'organization' as 'organization' | 'partner',
    canManagePartnerWide: true,
  },
  claimsState: { scope: 'partner' as 'partner' | 'organization', orgId: null as string | null },
  showToast: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { canManagePartnerWide: scopeState.canManagePartnerWide } }),
}));
vi.mock('../../stores/orgStore', () => {
  const state = {
    currentOrgId: 'org-1',
    organizations: [
      { id: 'org-1', name: 'Acme Org' },
      { id: 'org-2', name: 'Globex Org' },
    ],
  };
  return { useOrgStore: (sel: (s: typeof state) => unknown) => sel(state) };
});
vi.mock('../../hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({
    isPartnerScope: scopeState.isPartnerScope,
    defaultOwnerScope: scopeState.defaultOwnerScope,
  }),
}));
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: () => ({ scope: claimsState.scope, orgId: claimsState.orgId, partnerId: 'p-1' }),
  loginPathWithNext: () => '/login',
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import TicketRoutingTab from './TicketRoutingTab';
import { buildInboundPayload } from './inboundEmailConfig';
import { i18n } from '@/lib/i18n';

function res(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function rule(over: Partial<TicketRoutingRule> & { id: string }): TicketRoutingRule {
  return {
    orgId: 'org-1',
    partnerId: null,
    name: `Rule ${over.id}`,
    enabled: true,
    position: 0,
    matchSources: ['email'],
    matchPriorities: null,
    matchCategoryId: null,
    matchSubjectKeywords: null,
    matchRequesterDomains: null,
    setAssigneeUserId: null,
    setPriority: 'high',
    setCategoryId: null,
    setStatusId: null,
    addTags: null,
    orgIds: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const ORG_A = rule({ id: 'a1', position: 0 });
const ORG_B = rule({ id: 'b1', position: 1, matchSources: null, setPriority: 'low' }); // catch-all
const ORG_NOACT = rule({ id: 'n1', position: 2, setPriority: null }); // no actions
const PARTNER_ALL = rule({ id: 'p1', orgId: null, partnerId: 'p-1', position: 0, orgIds: null });
const PARTNER_LIMITED = rule({ id: 'p2', orgId: null, partnerId: 'p-1', position: 1, orgIds: ['org-1'] });

const INBOUND = {
  enabled: true,
  address: 'acme@tickets.example.com',
  addressOverride: null,
  inboundLocalPart: null,
  defaultTriageOrgId: null,
  autoresponderEnabled: true,
  unknownSenderMode: 'quarantine',
  dropUnverifiedSenders: false,
  staffForwardRouting: true,
  defaultAssigneeUserId: 'u-1',
  autoresponseSubject: null,
  autoresponseBody: null,
  fullMessageReply: false,
  slug: 'acme',
  domainConfigured: true,
};

let rules: TicketRoutingRule[];

function route() {
  fetchWithAuth.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (url.startsWith('/ticket-routing-rules')) {
      if (method === 'GET') return Promise.resolve(res({ data: rules }));
      if (url === '/ticket-routing-rules/test')
        return Promise.resolve(
          res({
            data: {
              ruleId: 'a1',
              ruleName: 'Rule a1',
              applied: { priority: 'high', tags: ['vip'] },
              skipped: [{ action: 'set_assignee', reason: 'assignee_ineligible' }],
            },
          }),
        );
      if (url === '/ticket-routing-rules/reorder') return Promise.resolve(res({ data: { updated: 2 } }));
      if (method === 'DELETE') return Promise.resolve(res({ data: { deleted: true } }));
      return Promise.resolve(res({ data: rule({ id: 'new1' }) }, method === 'POST' ? 201 : 200));
    }
    if (url === '/ticket-config') {
      return Promise.resolve(
        res({
          data: {
            statuses: [
              { id: 's-1', name: 'Open', coreStatus: 'open', isActive: true },
              { id: 's-2', name: 'Resolved', coreStatus: 'resolved', isActive: true },
            ],
            inbound: INBOUND,
          },
        }),
      );
    }
    if (url === '/ticket-categories')
      return Promise.resolve(res({ data: [{ id: 'c-1', name: 'Network', isActive: true }] }));
    if (url === '/users')
      return Promise.resolve(res({ data: [{ id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example' }] }));
    if (url === '/orgs/partners/me/default-assignee-candidates')
      return Promise.resolve(res({ data: [{ id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example' }] }));
    if (url === '/orgs/partners/me') return Promise.resolve(res({ id: 'p-1' }));
    if (url.startsWith('/orgs/organizations'))
      return Promise.resolve(res({ data: [{ id: 'org-1', name: 'Acme Org' }, { id: 'org-2', name: 'Globex Org' }] }));
    return Promise.resolve(res({ data: [] }));
  });
}

function callsTo(url: string, method: string) {
  return fetchWithAuth.mock.calls.filter((c) => c[0] === url && (c[1]?.method ?? 'GET') === method);
}
function bodyOf(call: unknown[]) {
  return JSON.parse((call[1] as { body: string }).body);
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  window.location.hash = '#routing';
  fetchWithAuth.mockReset();
  showToast.mockReset();
  scopeState.isPartnerScope = true;
  scopeState.defaultOwnerScope = 'organization';
  scopeState.canManagePartnerWide = true;
  claimsState.scope = 'partner';
  claimsState.orgId = null;
  rules = [ORG_A, ORG_B, ORG_NOACT, PARTNER_ALL, PARTNER_LIMITED];
  route();
});

afterEach(() => {
  window.location.hash = '';
});

describe('TicketRoutingTab — list', () => {
  it('says so when a picker lookup fails, instead of showing silently empty pickers', async () => {
    const base = fetchWithAuth.getMockImplementation()!;
    fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) =>
      url === '/users' ? Promise.resolve(res({ error: 'boom' }, 500)) : base(url, init));
    render(<TicketRoutingTab />);
    expect(await screen.findByTestId('routing-lookups-error')).toBeInTheDocument();
  });

  it('shows no lookup warning when every lookup loads', async () => {
    render(<TicketRoutingTab />);
    await screen.findByTestId('routing-rule-row-a1');
    await waitFor(() => expect(callsTo('/ticket-config', 'GET').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('routing-lookups-error')).not.toBeInTheDocument();
  });

  it('renders org rules then partner-wide rules with badges and warnings', async () => {
    render(<TicketRoutingTab />);
    await screen.findByTestId('routing-rule-row-a1');
    for (const id of ['a1', 'b1', 'n1', 'p1', 'p2']) {
      expect(screen.getByTestId(`routing-rule-row-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`routing-rule-drag-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`routing-rule-enabled-${id}`)).toBeInTheDocument();
    }
    // "All orgs" only on a partner-wide rule with orgIds === null
    expect(screen.getByTestId('routing-rule-all-orgs-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('routing-rule-all-orgs-p2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('routing-rule-all-orgs-a1')).not.toBeInTheDocument();
    // catch-all warning: a rule with no conditions
    expect(screen.getByTestId('routing-rule-catch-all-b1')).toBeInTheDocument();
    expect(screen.queryByTestId('routing-rule-catch-all-a1')).not.toBeInTheDocument();
    // no-actions warning
    expect(screen.getByTestId('routing-rule-no-actions-n1')).toBeInTheDocument();
    expect(screen.queryByTestId('routing-rule-no-actions-a1')).not.toBeInTheDocument();
    // org group renders before the partner-wide group
    const rows = screen.getAllByTestId(/^routing-rule-row-/).map((r) => r.getAttribute('data-testid'));
    expect(rows).toEqual([
      'routing-rule-row-a1',
      'routing-rule-row-b1',
      'routing-rule-row-n1',
      'routing-rule-row-p1',
      'routing-rule-row-p2',
    ]);
  });

  it('the enable toggle autosaves with PATCH {enabled} and a toast', async () => {
    render(<TicketRoutingTab />);
    await screen.findByTestId('routing-rule-row-a1');
    fireEvent.click(screen.getByTestId('routing-rule-enabled-a1'));
    await waitFor(() => expect(callsTo('/ticket-routing-rules/a1', 'PATCH')).toHaveLength(1));
    expect(bodyOf(callsTo('/ticket-routing-rules/a1', 'PATCH')[0])).toEqual({ enabled: false });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  });

  it('reorders within ONE owner group and POSTs only that group ids', async () => {
    render(<TicketRoutingTab />);
    await screen.findByTestId('routing-rule-row-a1');
    fireEvent.keyDown(screen.getByTestId('routing-rule-drag-a1'), { key: 'ArrowDown' });
    await waitFor(() => expect(callsTo('/ticket-routing-rules/reorder', 'POST')).toHaveLength(1));
    expect(bodyOf(callsTo('/ticket-routing-rules/reorder', 'POST')[0])).toEqual({ ids: ['b1', 'a1', 'n1'] });
  });

  it('drag and drop of one row onto another in the same group reorders', async () => {
    render(<TicketRoutingTab />);
    await screen.findByTestId('routing-rule-row-a1');
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(screen.getByTestId('routing-rule-row-n1'), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('routing-rule-row-a1'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('routing-rule-row-a1'), { dataTransfer });
    await waitFor(() => expect(callsTo('/ticket-routing-rules/reorder', 'POST')).toHaveLength(1));
    expect(bodyOf(callsTo('/ticket-routing-rules/reorder', 'POST')[0])).toEqual({ ids: ['n1', 'a1', 'b1'] });
  });

  it('does not cross groups: moving the last org rule down is a no-op', async () => {
    render(<TicketRoutingTab />);
    await screen.findByTestId('routing-rule-row-a1');
    fireEvent.keyDown(screen.getByTestId('routing-rule-drag-n1'), { key: 'ArrowDown' });
    await new Promise((r) => setTimeout(r, 20));
    expect(callsTo('/ticket-routing-rules/reorder', 'POST')).toHaveLength(0);
  });
});

describe('TicketRoutingTab — hash selection', () => {
  it('selecting a row writes #routing/<id> and opens the drawer; closing clears the detail', async () => {
    render(<TicketRoutingTab />);
    await screen.findByTestId('routing-rule-row-a1');
    fireEvent.click(screen.getByTestId('routing-rule-open-a1'));
    expect(window.location.hash).toBe('#routing/a1');
    const drawer = await screen.findByTestId('routing-rule-drawer');
    expect((within(drawer).getByTestId('routing-rule-name') as HTMLInputElement).value).toBe('Rule a1');
    fireEvent.click(screen.getByTestId('routing-rule-close'));
    expect(window.location.hash).toBe('#routing');
    await waitFor(() => expect(screen.queryByTestId('routing-rule-drawer')).not.toBeInTheDocument());
  });

  it('opens the drawer from a #routing/<id> deep link', async () => {
    window.location.hash = '#routing/b1';
    render(<TicketRoutingTab />);
    const drawer = await screen.findByTestId('routing-rule-drawer');
    expect((within(drawer).getByTestId('routing-rule-name') as HTMLInputElement).value).toBe('Rule b1');
  });
});

describe('TicketRoutingTab — drawer', () => {
  it('partner scope sees the owner selector at create; choosing partner-wide shows the org-links picker', async () => {
    render(<TicketRoutingTab />);
    await screen.findByTestId('routing-rule-row-a1');
    fireEvent.click(screen.getByTestId('routing-rule-create'));
    expect(window.location.hash).toBe('#routing/new');
    const drawer = await screen.findByTestId('routing-rule-drawer');
    expect(within(drawer).getByTestId('routing-rule-owner-scope')).toBeInTheDocument();
    expect(within(drawer).queryByTestId('routing-rule-org-links')).not.toBeInTheDocument();
    fireEvent.click(within(drawer).getByTestId('routing-rule-owner-partner'));
    expect(within(drawer).getByTestId('routing-rule-org-links')).toBeInTheDocument();
    expect(within(drawer).queryByTestId('routing-rule-delete')).not.toBeInTheDocument();
  });

  it('creates a partner-wide rule limited to selected orgs with the full body', async () => {
    render(<TicketRoutingTab />);
    await screen.findByTestId('routing-rule-row-a1');
    fireEvent.click(screen.getByTestId('routing-rule-create'));
    const drawer = await screen.findByTestId('routing-rule-drawer');
    fireEvent.click(within(drawer).getByTestId('routing-rule-owner-partner'));
    fireEvent.change(within(drawer).getByTestId('routing-rule-name'), { target: { value: 'VIP email' } });
    fireEvent.click(within(drawer).getByTestId('routing-rule-match-sources-email'));
    fireEvent.change(within(drawer).getByTestId('routing-rule-set-priority'), { target: { value: 'urgent' } });
    fireEvent.change(within(drawer).getByTestId('routing-rule-set-status'), { target: { value: 's-1' } });
    fireEvent.click(within(drawer).getByTestId('routing-rule-org-links-selected'));
    fireEvent.click(within(drawer).getByTestId('routing-rule-org-link-org-2'));
    const kw = within(drawer).getByTestId('routing-rule-match-keywords-input');
    fireEvent.change(kw, { target: { value: ' Outage ' } });
    fireEvent.keyDown(kw, { key: 'Enter' });
    const dom = within(drawer).getByTestId('routing-rule-match-domains-input');
    fireEvent.change(dom, { target: { value: '*.Example.com' } });
    fireEvent.keyDown(dom, { key: 'Enter' });
    fireEvent.click(within(drawer).getByTestId('routing-rule-save'));
    await waitFor(() => expect(callsTo('/ticket-routing-rules', 'POST')).toHaveLength(1));
    const body = bodyOf(callsTo('/ticket-routing-rules', 'POST')[0]);
    expect(body).toMatchObject({
      ownerScope: 'partner',
      name: 'VIP email',
      matchSources: ['email'],
      matchSubjectKeywords: ['outage'],
      matchRequesterDomains: ['*.example.com'],
      setPriority: 'urgent',
      setStatusId: 's-1',
      orgIds: ['org-2'],
    });
    expect(body.orgId).toBeUndefined();
  });

  it('creates an org rule for the selected org with ownerScope organization and no orgIds', async () => {
    render(<TicketRoutingTab />);
    await screen.findByTestId('routing-rule-row-a1');
    fireEvent.click(screen.getByTestId('routing-rule-create'));
    const drawer = await screen.findByTestId('routing-rule-drawer');
    fireEvent.change(within(drawer).getByTestId('routing-rule-name'), { target: { value: 'Org rule' } });
    fireEvent.change(within(drawer).getByTestId('routing-rule-set-priority'), { target: { value: 'low' } });
    fireEvent.click(within(drawer).getByTestId('routing-rule-save'));
    await waitFor(() => expect(callsTo('/ticket-routing-rules', 'POST')).toHaveLength(1));
    const body = bodyOf(callsTo('/ticket-routing-rules', 'POST')[0]);
    expect(body).toMatchObject({ ownerScope: 'organization', orgId: 'org-1', name: 'Org rule' });
    expect('orgIds' in body).toBe(false);
  });

  it('edits with PATCH and never sends ownership fields', async () => {
    window.location.hash = '#routing/a1';
    render(<TicketRoutingTab />);
    const drawer = await screen.findByTestId('routing-rule-drawer');
    fireEvent.change(within(drawer).getByTestId('routing-rule-name'), { target: { value: 'Renamed' } });
    fireEvent.click(within(drawer).getByTestId('routing-rule-save'));
    await waitFor(() => expect(callsTo('/ticket-routing-rules/a1', 'PATCH')).toHaveLength(1));
    const body = bodyOf(callsTo('/ticket-routing-rules/a1', 'PATCH')[0]);
    expect(body.name).toBe('Renamed');
    expect('ownerScope' in body).toBe(false);
    expect('orgId' in body).toBe(false);
    expect(within(drawer).queryByTestId('routing-rule-owner-scope')).not.toBeInTheDocument();
  });

  it('shows the server message inline on a 400 (no action)', async () => {
    const base = fetchWithAuth.getMockImplementation()!;
    fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === '/ticket-routing-rules' && init?.method === 'POST')
        return Promise.resolve(res({ error: 'A rule must set at least one action', code: 'ROUTING_RULE_NO_ACTION' }, 400));
      return base(url, init);
    });
    render(<TicketRoutingTab />);
    await screen.findByTestId('routing-rule-row-a1');
    fireEvent.click(screen.getByTestId('routing-rule-create'));
    const drawer = await screen.findByTestId('routing-rule-drawer');
    fireEvent.change(within(drawer).getByTestId('routing-rule-name'), { target: { value: 'Empty' } });
    fireEvent.click(within(drawer).getByTestId('routing-rule-save'));
    expect(await within(drawer).findByTestId('routing-rule-error')).toHaveTextContent(
      'A rule must set at least one action',
    );
  });

  it('rejects keywords shorter than 2 chars and more than 20 keywords', async () => {
    render(<TicketRoutingTab />);
    await screen.findByTestId('routing-rule-row-a1');
    fireEvent.click(screen.getByTestId('routing-rule-create'));
    const drawer = await screen.findByTestId('routing-rule-drawer');
    const kw = within(drawer).getByTestId('routing-rule-match-keywords-input');
    fireEvent.change(kw, { target: { value: 'x' } });
    fireEvent.keyDown(kw, { key: 'Enter' });
    expect(within(drawer).getByTestId('routing-rule-match-keywords-error')).toBeInTheDocument();
    expect(within(drawer).queryByTestId('routing-rule-match-keywords-chip-x')).not.toBeInTheDocument();
    for (let i = 0; i < 20; i++) {
      fireEvent.change(kw, { target: { value: `word${i}` } });
      fireEvent.keyDown(kw, { key: 'Enter' });
    }
    expect(within(drawer).getAllByTestId(/^routing-rule-match-keywords-chip-/)).toHaveLength(20);
    fireEvent.change(kw, { target: { value: 'onetoomany' } });
    fireEvent.keyDown(kw, { key: 'Enter' });
    expect(within(drawer).getAllByTestId(/^routing-rule-match-keywords-chip-/)).toHaveLength(20);
  });

  it('rejects a malformed domain', async () => {
    render(<TicketRoutingTab />);
    await screen.findByTestId('routing-rule-row-a1');
    fireEvent.click(screen.getByTestId('routing-rule-create'));
    const drawer = await screen.findByTestId('routing-rule-drawer');
    const dom = within(drawer).getByTestId('routing-rule-match-domains-input');
    fireEvent.change(dom, { target: { value: 'not a domain' } });
    fireEvent.keyDown(dom, { key: 'Enter' });
    expect(within(drawer).getByTestId('routing-rule-match-domains-error')).toBeInTheDocument();
    expect(within(drawer).queryAllByTestId(/^routing-rule-match-domains-chip-/)).toHaveLength(0);
  });

  it('deletes a rule after confirmation', async () => {
    window.location.hash = '#routing/a1';
    render(<TicketRoutingTab />);
    const drawer = await screen.findByTestId('routing-rule-drawer');
    fireEvent.click(within(drawer).getByTestId('routing-rule-delete'));
    await userEvent.click(await screen.findByTestId('routing-rule-delete-confirm'));
    await waitFor(() => expect(callsTo('/ticket-routing-rules/a1', 'DELETE')).toHaveLength(1));
    await waitFor(() => expect(window.location.hash).toBe('#routing'));
  });
});

describe('TicketRoutingTab — scope gating', () => {
  it('partner scope shows the fallback assignee editor', async () => {
    render(<TicketRoutingTab />);
    expect(await screen.findByTestId('routing-fallback-assignee')).toBeInTheDocument();
  });


  it('org scope: read-only list, no create/owner selector/fallback editor, test panel stays', async () => {
    scopeState.isPartnerScope = false;
    claimsState.scope = 'organization';
    claimsState.orgId = 'org-1';
    rules = [ORG_A, PARTNER_ALL];
    render(<TicketRoutingTab />);
    await screen.findByTestId('routing-rule-row-a1');
    expect(screen.queryByTestId('routing-fallback-assignee')).not.toBeInTheDocument();
    expect(screen.queryByTestId('routing-rule-create')).not.toBeInTheDocument();
    expect(screen.getByTestId('routing-rule-enabled-p1')).toBeDisabled();
    expect(screen.getByTestId('routing-rule-enabled-a1')).toBeDisabled();
    expect(screen.getByTestId('routing-rule-drag-a1')).toBeDisabled();
    expect(screen.getByTestId('routing-test-panel')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('routing-rule-open-a1'));
    const drawer = await screen.findByTestId('routing-rule-drawer');
    expect(within(drawer).queryByTestId('routing-rule-owner-scope')).not.toBeInTheDocument();
    expect(within(drawer).queryByTestId('routing-rule-save')).not.toBeInTheDocument();
    expect(within(drawer).queryByTestId('routing-rule-delete')).not.toBeInTheDocument();
  });

  it('partner without canManagePartnerWide: no owner selector, org rules editable, partner-wide rows read-only', async () => {
    scopeState.canManagePartnerWide = false;
    rules = [ORG_A, PARTNER_ALL];
    render(<TicketRoutingTab />);
    await screen.findByTestId('routing-rule-row-a1');
    expect(screen.getByTestId('routing-rule-enabled-a1')).not.toBeDisabled();
    expect(screen.getByTestId('routing-rule-enabled-p1')).toBeDisabled();
    fireEvent.click(screen.getByTestId('routing-rule-create'));
    const drawer = await screen.findByTestId('routing-rule-drawer');
    expect(within(drawer).queryByTestId('routing-rule-owner-scope')).not.toBeInTheDocument();
    fireEvent.change(within(drawer).getByTestId('routing-rule-name'), { target: { value: 'Mine' } });
    fireEvent.change(within(drawer).getByTestId('routing-rule-set-priority'), { target: { value: 'low' } });
    fireEvent.click(within(drawer).getByTestId('routing-rule-save'));
    await waitFor(() => expect(callsTo('/ticket-routing-rules', 'POST')).toHaveLength(1));
    expect(bodyOf(callsTo('/ticket-routing-rules', 'POST')[0])).toMatchObject({
      ownerScope: 'organization',
      orgId: 'org-1',
    });
  });

  it('org scope opening a partner-wide rule is read-only (no save, no delete)', async () => {
    scopeState.isPartnerScope = false;
    claimsState.scope = 'organization';
    claimsState.orgId = 'org-1';
    rules = [PARTNER_ALL];
    window.location.hash = '#routing/p1';
    render(<TicketRoutingTab />);
    const drawer = await screen.findByTestId('routing-rule-drawer');
    expect(within(drawer).queryByTestId('routing-rule-save')).not.toBeInTheDocument();
    expect(within(drawer).queryByTestId('routing-rule-delete')).not.toBeInTheDocument();
    expect(within(drawer).getByTestId('routing-rule-name')).toBeDisabled();
  });
});

describe('TicketRoutingTab — test a ticket', () => {
  it('runs the dry run and renders the matched rule, applied actions and skipped reasons', async () => {
    render(<TicketRoutingTab />);
    const panel = await screen.findByTestId('routing-test-panel');
    fireEvent.change(within(panel).getByTestId('routing-test-source'), { target: { value: 'email' } });
    fireEvent.change(within(panel).getByTestId('routing-test-subject'), { target: { value: 'Server down' } });
    fireEvent.change(within(panel).getByTestId('routing-test-email'), { target: { value: 'a@example.com' } });
    fireEvent.click(within(panel).getByTestId('routing-test-run'));
    const result = await within(panel).findByTestId('routing-test-result');
    expect(result).toHaveTextContent('Rule a1');
    expect(within(result).getByTestId('routing-test-applied')).toHaveTextContent(/high/i);
    expect(within(result).getByTestId('routing-test-skipped')).toHaveTextContent(/assignee/i);
    const call = callsTo('/ticket-routing-rules/test', 'POST')[0];
    expect(bodyOf(call)).toEqual({
      orgId: 'org-1',
      source: 'email',
      subject: 'Server down',
      requesterEmail: 'a@example.com',
    });
  });

  it('says No rule matched and sends a null email when blank', async () => {
    const base = fetchWithAuth.getMockImplementation()!;
    fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === '/ticket-routing-rules/test')
        return Promise.resolve(res({ data: { ruleId: null, ruleName: null, applied: {}, skipped: [] } }));
      return base(url, init);
    });
    render(<TicketRoutingTab />);
    const panel = await screen.findByTestId('routing-test-panel');
    fireEvent.change(within(panel).getByTestId('routing-test-subject'), { target: { value: 'Hello' } });
    fireEvent.click(within(panel).getByTestId('routing-test-run'));
    expect(await within(panel).findByTestId('routing-test-result')).toHaveTextContent('No rule matched');
    expect(bodyOf(callsTo('/ticket-routing-rules/test', 'POST')[0]).requesterEmail).toBeNull();
  });
});

describe('InboundFallbackAssigneeEditor', () => {
  it('saves the COMPLETE inbound object with the new default assignee', async () => {
    render(<TicketRoutingTab />);
    const editor = await screen.findByTestId('routing-fallback-assignee');
    const select = (await within(editor).findByTestId('routing-fallback-assignee-select')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('u-1'));
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(within(editor).getByTestId('routing-fallback-assignee-save'));
    await waitFor(() => expect(callsTo('/orgs/partners/me', 'PATCH')).toHaveLength(1));
    const inbound = bodyOf(callsTo('/orgs/partners/me', 'PATCH')[0]).settings.ticketing.inbound;
    expect(inbound.defaultAssigneeUserId).toBeNull();
    // whole object rides along
    expect(inbound).toMatchObject({
      enabled: true,
      unknownSenderMode: 'quarantine',
      staffForwardRouting: true,
      autoresponderEnabled: true,
    });
  });

  it('builds the PATCH from a FRESH read, so a change saved elsewhere since mount is not reverted', async () => {
    render(<TicketRoutingTab />);
    const editor = await screen.findByTestId('routing-fallback-assignee');
    const select = (await within(editor).findByTestId('routing-fallback-assignee-select')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('u-1'));
    // The Inbound email card saved a new autoresponse + full-message mode meanwhile.
    const base = fetchWithAuth.getMockImplementation()!;
    fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) =>
      url === '/ticket-config' && (init?.method ?? 'GET') === 'GET'
        ? Promise.resolve(res({ data: { statuses: [], inbound: { ...INBOUND, autoresponseSubject: 'Got it', fullMessageReply: true } } }))
        : base(url, init));
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(within(editor).getByTestId('routing-fallback-assignee-save'));
    await waitFor(() => expect(callsTo('/orgs/partners/me', 'PATCH')).toHaveLength(1));
    const inbound = bodyOf(callsTo('/orgs/partners/me', 'PATCH')[0]).settings.ticketing.inbound;
    expect(inbound).toMatchObject({ defaultAssigneeUserId: null, autoresponseSubject: 'Got it', fullMessageReply: true });
  });
});

describe('buildInboundPayload (the one serializer of ticketing.inbound)', () => {
  it('carries every inbound field with its value, plus a real self-hosted address override', () => {
    const full = {
      ...INBOUND,
      addressOverride: 'help@self.example.com',
      defaultTriageOrgId: 'org-1',
      dropUnverifiedSenders: true,
      unknownSenderMode: 'triage' as const,
      autoresponseSubject: 'Subject',
      autoresponseBody: 'Body',
      fullMessageReply: true,
    };
    expect(buildInboundPayload(full)).toEqual({
      enabled: true,
      defaultTriageOrgId: 'org-1',
      autoresponderEnabled: true,
      unknownSenderMode: 'triage',
      dropUnverifiedSenders: true,
      staffForwardRouting: true,
      defaultAssigneeUserId: 'u-1',
      autoresponseSubject: 'Subject',
      autoresponseBody: 'Body',
      fullMessageReply: true,
      address: 'help@self.example.com',
    });
  });
});
