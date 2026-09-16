import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: 'org-1' }) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import ReportTemplates from './ReportTemplates';

function mockTemplatesFetch(onPost: (init?: { method?: string }) => Promise<unknown>) {
  fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/reports/templates') {
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    }
    if (url === '/reports' && init?.method === 'POST') {
      return onPost(init);
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

function postCallBody() {
  const call = fetchWithAuth.mock.calls.find(
    ([url, init]) => url === '/reports' && (init as { method?: string } | undefined)?.method === 'POST'
  );
  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}

async function clickUseTemplate(name: string) {
  const heading = await screen.findByText(name);
  const card = heading.closest('div.group') as HTMLElement;
  expect(card).toBeTruthy();
  await userEvent.setup().click(within(card).getByRole('button', { name: /use template/i }));
  return card;
}

describe('ReportTemplates — Endpoint Management Review card', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates an endpoint_management_review report directly with the default options', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-1' } }) }));
    render(<ReportTemplates />);

    await clickUseTemplate('Intune Endpoint Management Review');
    await userEvent.setup().click(screen.getByTestId('endpoint-management-create-report'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith('/reports', expect.objectContaining({ method: 'POST' }));
    });
    expect(postCallBody()).toMatchObject({
      type: 'endpoint_management_review',
      orgId: 'org-1',
      format: 'pdf',
      config: { staleEnrolmentDays: 14, trendDays: 30, includeLicences: true },
    });
    // Never the downgrading builder.
    expect(screen.queryByLabelText(/Report name/i)).not.toBeInTheDocument();
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/reports'));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('posts the edited thresholds and the licence toggle under their own keys', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-1' } }) }));
    render(<ReportTemplates />);
    const user = userEvent.setup();

    await clickUseTemplate('Intune Endpoint Management Review');
    const stale = screen.getByTestId('endpoint-management-stale-enrolment-days');
    await user.clear(stale);
    await user.type(stale, '30');
    // A distinct value from the field above — proves the two land under their
    // own keys rather than one overwriting the other.
    const trend = screen.getByTestId('endpoint-management-trend-days');
    await user.clear(trend);
    await user.type(trend, '90');
    await user.click(screen.getByTestId('endpoint-management-include-licences'));
    await user.click(screen.getByTestId('endpoint-management-create-report'));

    await waitFor(() => expect(postCallBody()).toBeDefined());
    expect(postCallBody().config).toMatchObject({
      staleEnrolmentDays: 30,
      trendDays: 90,
      includeLicences: false,
    });
  });

  it('surfaces a failure and does not navigate when the create POST fails', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) }));
    render(<ReportTemplates />);

    await clickUseTemplate('Intune Endpoint Management Review');
    await userEvent.setup().click(screen.getByTestId('endpoint-management-create-report'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(navigateTo).not.toHaveBeenCalledWith('/reports');
  });
});
