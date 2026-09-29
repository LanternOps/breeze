import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
// No JWT/user in this fixture (equivalent to a not-yet-resolved session), so
// the #3198 Business group (partner-scope gated) stays hidden.
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

async function clickUseTemplate(name: string) {
  const heading = await screen.findByText(name);
  const card = heading.closest('div.group') as HTMLElement;
  expect(card).toBeTruthy();
  await userEvent.setup().click(within(card).getByRole('button', { name: /use template/i }));
  return card;
}

describe('ReportTemplates — Backup Status card', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a backup_status report directly with the default options', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-1' } }) }));
    render(<ReportTemplates />);

    await clickUseTemplate('Backup Status Report');
    await userEvent.setup().click(screen.getByTestId('backup-status-create-report'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith('/reports', expect.objectContaining({ method: 'POST' }));
    });
    expect(postCallBody()).toMatchObject({
      type: 'backup_status',
      orgId: 'org-1',
      schedule: 'one_time',
      format: 'pdf',
      config: { includeDevicesWithoutBackup: true, sources: ['breeze', 'provider'] },
    });
    // Never the downgrading builder.
    expect(screen.queryByLabelText(/Report name/i)).not.toBeInTheDocument();
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/reports'));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('posts the edited toggle and source selection', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-1' } }) }));
    render(<ReportTemplates />);
    const user = userEvent.setup();

    await clickUseTemplate('Backup Status Report');
    await user.click(screen.getByTestId('backup-status-include-without-backup'));
    await user.click(screen.getByTestId('backup-status-source-breeze'));
    await user.click(screen.getByTestId('backup-status-create-report'));

    await waitFor(() => expect(postCallBody()).toBeDefined());
    expect(postCallBody().config).toMatchObject({
      includeDevicesWithoutBackup: false,
      sources: ['provider'],
    });
  });

  it('surfaces a failure and does not navigate when the create POST fails', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) }));
    render(<ReportTemplates />);

    await clickUseTemplate('Backup Status Report');
    await userEvent.setup().click(screen.getByTestId('backup-status-create-report'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(navigateTo).not.toHaveBeenCalledWith('/reports');
  });
});
