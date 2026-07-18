import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

// Mutable so individual tests can exercise the no-org (partner-wide) path.
let currentOrgId: string | null = 'org-1';
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId }) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import ReportTemplates from './ReportTemplates';

/** The on-mount template fetch falls back to built-in defaults (no such API yet). */
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

describe('ReportTemplates — Security & Compliance Posture card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentOrgId = 'org-1';
  });

  it('creates a security_compliance_posture report directly instead of opening the downgrading builder', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-9' } }) }));
    render(<ReportTemplates />);

    await clickUseTemplate('Security & Compliance Posture (Insurance)');
    await userEvent.setup().click(screen.getByTestId('posture-options-submit'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith('/reports', expect.objectContaining({ method: 'POST' }));
    });
    const body = postCallBody();
    expect(body.type).toBe('security_compliance_posture');
    expect(body.orgId).toBe('org-1');
    expect(body.schedule).toBe('one_time');
    expect(body.format).toBe('pdf');

    // Must NOT open the freeform builder (which would downgrade to "compliance").
    expect(screen.queryByLabelText(/Report name/i)).not.toBeInTheDocument();
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/reports'));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('surfaces a failure and does not navigate when the create POST fails', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) }));
    render(<ReportTemplates />);

    const card = await clickUseTemplate('Security & Compliance Posture (Insurance)');
    await userEvent.setup().click(screen.getByTestId('posture-options-submit'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(navigateTo).not.toHaveBeenCalledWith('/reports');
    // Button is re-enabled (finally cleared the in-flight id).
    await waitFor(() =>
      expect(within(card).getByRole('button', { name: /use template/i })).not.toBeDisabled()
    );
  });

  it('omits orgId from the POST when no org is selected (partner-wide)', async () => {
    currentOrgId = null;
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-9' } }) }));
    render(<ReportTemplates />);

    await clickUseTemplate('Security & Compliance Posture (Insurance)');
    await userEvent.setup().click(screen.getByTestId('posture-options-submit'));

    await waitFor(() => expect(postCallBody()).toBeDefined());
    expect(postCallBody()).not.toHaveProperty('orgId');
  });

  it('opens posture options and creates backup-optional by default', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-9' } }) }));
    render(<ReportTemplates />);

    await clickUseTemplate('Security & Compliance Posture (Insurance)');
    await userEvent.setup().click(screen.getByTestId('posture-options-submit'));

    expect(postCallBody()).toMatchObject({
      type: 'security_compliance_posture',
      config: { backupRequired: false },
    });
  });

  it('posts backupRequired true when the user opts in', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-9' } }) }));
    render(<ReportTemplates />);

    await clickUseTemplate('Security & Compliance Posture (Insurance)');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('posture-backup-required'));
    await user.click(screen.getByTestId('posture-options-submit'));

    expect(postCallBody()).toMatchObject({
      type: 'security_compliance_posture',
      config: { backupRequired: true },
    });
  });
});

describe('ReportTemplates — builder-representable templates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentOrgId = 'org-1';
  });

  it('opens the freeform builder (no direct POST) for a template the builder round-trips', async () => {
    // "Device Health Report" is type "performance", which survives the builder.
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    render(<ReportTemplates />);

    await clickUseTemplate('Device Health Report');

    // Modal opens with the "Use <name>" heading; no report is created directly.
    expect(await screen.findByText(/Use Device Health Report/i)).toBeInTheDocument();
    expect(postCallBody()).toBeUndefined();
    expect(navigateTo).not.toHaveBeenCalledWith('/reports');
  });
});
