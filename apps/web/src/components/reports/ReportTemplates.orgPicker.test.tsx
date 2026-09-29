import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
// No JWT/user (a not-yet-resolved session): the Business group stays hidden;
// this suite is about the General templates.
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: Object.assign((selector: (s: { tokens?: unknown; user?: unknown }) => unknown) => selector({}), {
    getState: () => ({}),
  }),
}));

const orgs = [
  { id: 'org-a', partnerId: 'p-1', name: 'Acme Dental', status: 'active', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'org-b', partnerId: 'p-1', name: 'Bravo Law', status: 'active', createdAt: '2026-01-01T00:00:00Z' },
];
let currentOrgId: string | null = null;
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId, organizations: orgs }) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import ReportTemplates from './ReportTemplates';

function mockApi() {
  fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/reports' && init?.method === 'POST') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-9' } }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

const postCalls = () =>
  fetchWithAuth.mock.calls.filter(
    ([url, init]) => url === '/reports' && (init as { method?: string } | undefined)?.method === 'POST',
  );

async function clickUseTemplate(name: string) {
  const heading = await screen.findByText(name);
  const card = heading.closest('div.group') as HTMLElement;
  await userEvent.setup().click(within(card).getByRole('button', { name: /use template/i }));
}

describe('ReportTemplates org picker under All organizations (multi-org series W01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentOrgId = null;
    mockApi();
  });

  it('does not open or post a template until an org is chosen on the page', async () => {
    render(<ReportTemplates />);

    expect(await screen.findByTestId('report-templates-org-picker')).toBeInTheDocument();
    await clickUseTemplate('Security & Compliance Posture (Insurance)');

    expect(await screen.findByText('Choose an organization above before using a template.')).toBeInTheDocument();
    expect(screen.queryByTestId('posture-options-submit')).toBeNull();
    expect(postCalls()).toHaveLength(0);
  });

  it('creates the template report for the org picked on the page', async () => {
    render(<ReportTemplates />);

    await userEvent.setup().selectOptions(await screen.findByTestId('report-templates-org-picker-select'), 'org-b');
    await clickUseTemplate('Security & Compliance Posture (Insurance)');
    await userEvent.setup().click(screen.getByTestId('posture-options-submit'));

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(JSON.parse(String((postCalls()[0]![1] as { body: string }).body))).toMatchObject({
      type: 'security_compliance_posture',
      orgId: 'org-b',
    });
  });

  it('hands the page choice to the builder modal as its preselected org', async () => {
    render(<ReportTemplates />);

    await userEvent.setup().selectOptions(await screen.findByTestId('report-templates-org-picker-select'), 'org-a');
    await userEvent.setup().click(screen.getByRole('button', { name: /create custom template/i }));

    expect(await screen.findByTestId('report-org-picker-select')).toHaveValue('org-a');
  });

  it('shows no picker and uses the focused org when the switcher names one', async () => {
    currentOrgId = 'org-a';
    render(<ReportTemplates />);

    await clickUseTemplate('Security & Compliance Posture (Insurance)');
    await userEvent.setup().click(screen.getByTestId('posture-options-submit'));

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(screen.queryByTestId('report-templates-org-picker')).toBeNull();
    expect(JSON.parse(String((postCalls()[0]![1] as { body: string }).body))).toMatchObject({ orgId: 'org-a' });
  });
});
