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

describe('ReportTemplates — Hardware Lifecycle card', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a hardware_lifecycle report directly with the default options', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-1' } }) }));
    render(<ReportTemplates />);

    await clickUseTemplate('Hardware Lifecycle Report');
    await userEvent.setup().click(screen.getByTestId('lifecycle-create-report'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith('/reports', expect.objectContaining({ method: 'POST' }));
    });
    expect(postCallBody()).toMatchObject({
      type: 'hardware_lifecycle',
      orgId: 'org-1',
      schedule: 'monthly',
      format: 'pdf',
      config: { replaceAgeYears: 4, includeManualAssets: true, includeOtherEquipment: true },
    });
    // Never the downgrading builder.
    expect(screen.queryByLabelText(/Report name/i)).not.toBeInTheDocument();
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/reports'));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('posts the edited replacement age and toggles, with the workstation and server ages kept independent', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-1' } }) }));
    render(<ReportTemplates />);
    const user = userEvent.setup();

    await clickUseTemplate('Hardware Lifecycle Report');
    const years = screen.getByTestId('lifecycle-replace-age-years');
    await user.clear(years);
    await user.type(years, '5');
    // A distinct value from the workstation field above — proves the two
    // land under their own keys rather than one overwriting the other.
    const serverYears = screen.getByTestId('lifecycle-server-replace-age-years');
    await user.clear(serverYears);
    await user.type(serverYears, '8');
    await user.click(screen.getByTestId('lifecycle-include-other-equipment'));
    await user.click(screen.getByTestId('lifecycle-create-report'));

    await waitFor(() => expect(postCallBody()).toBeDefined());
    expect(postCallBody().config.replaceAgeYears).toBe(5);
    expect(postCallBody().config.serverReplaceAgeYears).toBe(8);
    expect(postCallBody().config).toMatchObject({
      replaceAgeYears: 5,
      serverReplaceAgeYears: 8,
      includeManualAssets: true,
      includeOtherEquipment: false,
    });
  });

  it('surfaces a failure and does not navigate when the create POST fails', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) }));
    render(<ReportTemplates />);

    await clickUseTemplate('Hardware Lifecycle Report');
    await userEvent.setup().click(screen.getByTestId('lifecycle-create-report'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(navigateTo).not.toHaveBeenCalledWith('/reports');
  });
});
