import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: Object.assign((selector: (s: { tokens?: unknown; user?: unknown }) => unknown) => selector({}), {
    getState: () => ({}),
  }),
}));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: 'org-1' }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

let granted = new Set<string>();
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({
    permissions: undefined,
    can: (resource: string, action: string) => granted.has(`${resource}:${action}`),
  }),
}));

import ReportTemplates from './ReportTemplates';

function mockFetch() {
  fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/reports' && init?.method === 'POST') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-1' } }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

function postBody() {
  const call = fetchWithAuth.mock.calls.find(
    ([url, init]) => url === '/reports' && (init as { method?: string } | undefined)?.method === 'POST',
  );
  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}

async function openCard() {
  const general = await screen.findByTestId('report-template-group-general');
  const matches = await within(general).findAllByText('SLA performance');
  const card = matches.map((el) => el.closest('div.group')).find(Boolean) as HTMLElement;
  await userEvent.setup().click(within(card).getByRole('button', { name: /use template/i }));
}

describe('ReportTemplates: SLA performance card (#11018)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    granted = new Set(['tickets:read']);
    mockFetch();
  });

  it('card hidden without tickets:read, shown with it', async () => {
    granted = new Set();
    const { unmount } = render(<ReportTemplates />);
    const general = await screen.findByTestId('report-template-group-general');
    expect(within(general).queryByText('SLA performance')).toBeNull();
    unmount();

    granted = new Set(['tickets:read']);
    render(<ReportTemplates />);
    const shown = await screen.findByTestId('report-template-group-general');
    expect(within(shown).getAllByText('SLA performance').length).toBeGreaterThan(0);
  });

  it('sits in General with its customer-ready description, not in Business', async () => {
    render(<ReportTemplates />);
    const general = await screen.findByTestId('report-template-group-general');
    expect(within(general).getByText(/Customer-ready response and resolution times/)).toBeInTheDocument();
    expect(screen.queryByTestId('report-template-group-business')).toBeNull();
  });

  it('creates with no refused selector: the server 400s on a dateRange for this type', async () => {
    render(<ReportTemplates />);
    await openCard();
    expect(screen.getByTestId('template-modal-ticket_sla_performance')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByTestId('sla-performance-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    const body = postBody();
    expect(body).toMatchObject({ type: 'ticket_sla_performance', orgId: 'org-1', format: 'pdf', schedule: 'monthly' });
    expect(body.config).toEqual({});
    expect(body.ownerScope).toBeUndefined();
  });

  it('posts includeSubjects only when opted in', async () => {
    render(<ReportTemplates />);
    await openCard();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('sla-performance-include-subjects'));
    await user.click(screen.getByTestId('sla-performance-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody().config).toEqual({ includeSubjects: true });
  });
});
