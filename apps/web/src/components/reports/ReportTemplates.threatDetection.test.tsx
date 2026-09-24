import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
// No JWT/user in this fixture (equivalent to a not-yet-resolved session), so
// the #3198 Business group (partner-scope gated) stays hidden and every
// existing assertion here is about the General section only.
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: Object.assign((selector: (s: { tokens?: unknown; user?: unknown }) => unknown) => selector({}), {
    getState: () => ({}),
  }),
}));

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

// The card's NAME and its report-type label are the same string here, so the
// text matches twice; take the match that sits inside a template card.
async function clickUseTemplate(name: string) {
  const matches = await screen.findAllByText(name);
  const card = matches.map((el) => el.closest('div.group')).find(Boolean) as HTMLElement | undefined;
  expect(card).toBeTruthy();
  await userEvent.setup().click(within(card!).getByRole('button', { name: /use template/i }));
  return card!;
}

describe('ReportTemplates — Threat Detection Review card (#5784 W02)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens the options form rather than the freeform builder, and creates with the defaults', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-1' } }) }));
    render(<ReportTemplates />);

    await clickUseTemplate('Threat Detection Review');
    // The curated options form, not the builder — the builder would downgrade
    // this type to a plain devices report.
    expect(screen.queryByLabelText(/Report name/i)).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByTestId('threat-detection-create-report'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith('/reports', expect.objectContaining({ method: 'POST' }));
    });
    expect(postCallBody()).toMatchObject({
      type: 'threat_detection_review',
      orgId: 'org-1',
      format: 'pdf',
      config: { includeCarriedIn: true, topIncidents: 100 },
    });
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/reports'));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('posts the edited cap and toggle', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-1' } }) }));
    render(<ReportTemplates />);
    const user = userEvent.setup();

    await clickUseTemplate('Threat Detection Review');
    const top = screen.getByTestId('threat-detection-top-incidents');
    await user.clear(top);
    await user.type(top, '25');
    await user.click(screen.getByTestId('threat-detection-include-carried-in'));
    await user.click(screen.getByTestId('threat-detection-create-report'));

    await waitFor(() => expect(postCallBody()).toBeDefined());
    expect(postCallBody().config).toMatchObject({ topIncidents: 25, includeCarriedIn: false });
  });

  it('surfaces a failure and does not navigate when the create POST fails', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) }));
    render(<ReportTemplates />);

    await clickUseTemplate('Threat Detection Review');
    await userEvent.setup().click(screen.getByTestId('threat-detection-create-report'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(navigateTo).not.toHaveBeenCalledWith('/reports');
  });
});
