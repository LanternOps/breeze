import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PamRulesTab from './PamRulesTab';
import { fetchWithAuth } from '../../stores/auth';
import type { PamRule } from './types';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

const signedRule: PamRule = {
  id: 'rule-1',
  orgId: 'org-1',
  name: 'Allow signed Microsoft installers',
  enabled: true,
  priority: 10,
  matchSigner: 'Microsoft Corporation',
  verdict: 'auto_approve',
  createdAt: '2026-06-10T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
};

/**
 * URL-routed fetch mock. The tab and modal now fetch /orgs/sites and
 * /orgs/organizations alongside /pam/rules, so order-based Once-chains are
 * brittle; route by URL+method instead.
 */
function installFetchRoutes({
  rules = [] as PamRule[],
  sites = [] as Array<{ id: string; name: string }>,
  orgs = [{ id: 'org-1', name: 'Acme' }],
}: {
  rules?: PamRule[];
  sites?: Array<{ id: string; name: string }>;
  orgs?: Array<{ id: string; name: string }>;
} = {}) {
  fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.startsWith('/orgs/organizations')) return makeJsonResponse({ data: orgs });
    if (url.startsWith('/orgs/sites')) return makeJsonResponse({ data: sites });
    if (url === '/pam/rules' && method === 'POST') {
      return makeJsonResponse({ success: true, rule: rules[0] ?? signedRule }, true, 201);
    }
    if (url.startsWith('/pam/rules/') && method !== 'GET') {
      return makeJsonResponse({ success: true, rule: rules[0] ?? signedRule });
    }
    return makeJsonResponse({ success: true, rules });
  });
}

function findMutationCall(url: string, method: string) {
  return fetchWithAuthMock.mock.calls.find(
    (c) => c[0] === url && (c[1] as RequestInit | undefined)?.method === method,
  );
}

function bodyOf(call: ReturnType<typeof findMutationCall>): Record<string, unknown> {
  return JSON.parse((call?.[1] as RequestInit).body as string);
}

async function openCreateModal() {
  await waitFor(() => screen.getByTestId('pam-add-rule-btn'));
  fireEvent.click(screen.getByTestId('pam-add-rule-btn'));
}

describe('PamRulesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the empty state when no rules exist', async () => {
    installFetchRoutes({ rules: [] });
    render(<PamRulesTab />);
    await waitFor(() => {
      expect(screen.getByText('No PAM rules yet')).toBeInTheDocument();
    });
  });

  it('renders rules sorted by priority with a criteria summary', async () => {
    const catchAll: PamRule = {
      ...signedRule,
      id: 'rule-2',
      name: 'Catch-all deny',
      priority: 500,
      matchSigner: null,
      matchPathGlob: '**',
      verdict: 'auto_deny',
    };
    installFetchRoutes({ rules: [catchAll, signedRule] });
    render(<PamRulesTab />);
    await waitFor(() => {
      expect(screen.getByTestId('pam-rule-row-rule-1')).toBeInTheDocument();
    });
    const rows = screen.getAllByTestId(/^pam-rule-row-/);
    // priority 10 sorts before priority 500
    expect(rows[0]).toHaveAttribute('data-testid', 'pam-rule-row-rule-1');
    expect(screen.getByText('signer=Microsoft Corporation')).toBeInTheDocument();
  });

  it('renders a scope cell: Org-wide or the resolved site name', async () => {
    const siteScoped: PamRule = {
      ...signedRule,
      id: 'rule-3',
      name: 'HQ only',
      siteId: 'site-1',
    };
    installFetchRoutes({
      rules: [signedRule, siteScoped],
      sites: [{ id: 'site-1', name: 'HQ' }],
    });
    render(<PamRulesTab />);
    await waitFor(() => {
      expect(screen.getByTestId('pam-rule-scope-rule-1')).toHaveTextContent('Org-wide');
    });
    await waitFor(() => {
      expect(screen.getByTestId('pam-rule-scope-rule-3')).toHaveTextContent('HQ');
    });
  });

  it('toggles a rule enabled state via PATCH', async () => {
    installFetchRoutes({ rules: [signedRule] });
    render(<PamRulesTab />);
    await waitFor(() => screen.getByTestId('pam-rule-toggle-rule-1'));
    fireEvent.click(screen.getByTestId('pam-rule-toggle-rule-1'));
    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/pam/rules/rule-1',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
    expect(bodyOf(findMutationCall('/pam/rules/rule-1', 'PATCH'))).toEqual({ enabled: false });
  });

  it('gates rule deletion behind a confirm dialog', async () => {
    installFetchRoutes({ rules: [signedRule] });
    render(<PamRulesTab />);
    await waitFor(() => screen.getByTestId('pam-rule-delete-rule-1'));

    // First click opens the confirm dialog — no DELETE goes out yet.
    fireEvent.click(screen.getByTestId('pam-rule-delete-rule-1'));
    await waitFor(() => screen.getByTestId('pam-rule-delete-confirm'));
    expect(findMutationCall('/pam/rules/rule-1', 'DELETE')).toBeUndefined();

    // Confirming fires the DELETE.
    fireEvent.click(screen.getByTestId('pam-rule-delete-confirm'));
    await waitFor(() => {
      expect(findMutationCall('/pam/rules/rule-1', 'DELETE')).toBeDefined();
    });
  });

  it('does not DELETE when the confirm dialog is cancelled', async () => {
    installFetchRoutes({ rules: [signedRule] });
    render(<PamRulesTab />);
    await waitFor(() => screen.getByTestId('pam-rule-delete-rule-1'));

    fireEvent.click(screen.getByTestId('pam-rule-delete-rule-1'));
    await waitFor(() => screen.getByTestId('pam-rule-delete-confirm'));
    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('pam-rule-delete-confirm')).toBeNull();
    });
    expect(findMutationCall('/pam/rules/rule-1', 'DELETE')).toBeUndefined();
  });

  it('creates a rule through the modal, sending a clean executable-shaped payload', async () => {
    installFetchRoutes({ rules: [] });
    render(<PamRulesTab />);
    await openCreateModal();

    fireEvent.change(screen.getByTestId('pam-rule-name'), {
      target: { value: 'Allow signed Microsoft installers' },
    });
    fireEvent.change(screen.getByTestId('pam-rule-signer'), {
      target: { value: 'Microsoft Corporation' },
    });
    fireEvent.click(screen.getByTestId('pam-rule-submit'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/pam/rules',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    const payload = bodyOf(findMutationCall('/pam/rules', 'POST'));
    expect(payload).toMatchObject({
      name: 'Allow signed Microsoft installers',
      matchSigner: 'Microsoft Corporation',
      matchToolName: null,
      matchRiskTier: null,
      verdict: 'require_approval',
      enabled: true,
      siteId: null,
    });
    // Single accessible org: the server resolves it — no orgId in the body.
    expect('orgId' in payload).toBe(false);
  });

  it('blocks submission client-side when no criterion is provided', async () => {
    installFetchRoutes({ rules: [] });
    render(<PamRulesTab />);
    await openCreateModal();

    fireEvent.change(screen.getByTestId('pam-rule-name'), { target: { value: 'No criteria' } });
    fireEvent.click(screen.getByTestId('pam-rule-submit'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('At least one match criterion');
    });
    // No POST went out
    expect(findMutationCall('/pam/rules', 'POST')).toBeUndefined();
  });

  it('blocks the ignore verdict for tool-action rules client-side', async () => {
    installFetchRoutes({ rules: [] });
    render(<PamRulesTab />);
    await openCreateModal();

    fireEvent.change(screen.getByTestId('pam-rule-name'), { target: { value: 'Tool rule' } });
    fireEvent.click(screen.getByTestId('pam-rule-shape-tool'));
    fireEvent.change(screen.getByTestId('pam-rule-toolname'), { target: { value: 'run_script' } });
    // The ignore option is disabled in the select for tool shape; force the state
    // by asserting the option is disabled instead.
    const verdictSelect = screen.getByTestId('pam-rule-verdict') as HTMLSelectElement;
    const ignoreOption = Array.from(verdictSelect.options).find((o) => o.value === 'ignore');
    expect(ignoreOption?.disabled).toBe(true);
  });

  describe('time window', () => {
    const windowedRule: PamRule = {
      ...signedRule,
      id: 'rule-w',
      name: 'Business hours',
      timeWindow: { start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5], timezone: 'Europe/Berlin' },
    };

    it('preserves days and timezone when editing only the name', async () => {
      installFetchRoutes({ rules: [windowedRule] });
      render(<PamRulesTab />);
      await waitFor(() => screen.getByTestId('pam-rule-edit-rule-w'));
      fireEvent.click(screen.getByTestId('pam-rule-edit-rule-w'));

      fireEvent.change(screen.getByTestId('pam-rule-name'), {
        target: { value: 'Business hours v2' },
      });
      fireEvent.click(screen.getByTestId('pam-rule-submit'));

      await waitFor(() => {
        expect(findMutationCall('/pam/rules/rule-w', 'PATCH')).toBeDefined();
      });
      const payload = bodyOf(findMutationCall('/pam/rules/rule-w', 'PATCH'));
      expect(payload.timeWindow).toEqual({
        start: '08:00',
        end: '18:00',
        days: [1, 2, 3, 4, 5],
        timezone: 'Europe/Berlin',
      });
    });

    it('round-trips days and timezone inputs into the create payload', async () => {
      installFetchRoutes({ rules: [] });
      render(<PamRulesTab />);
      await openCreateModal();

      // Days/timezone inputs only appear once the window section is active.
      expect(screen.queryByTestId('pam-rule-window-day-1')).toBeNull();

      fireEvent.change(screen.getByTestId('pam-rule-name'), { target: { value: 'Windowed' } });
      fireEvent.change(screen.getByTestId('pam-rule-signer'), { target: { value: 'Acme Corp' } });
      fireEvent.change(screen.getByTestId('pam-rule-window-start'), { target: { value: '08:00' } });
      fireEvent.change(screen.getByTestId('pam-rule-window-end'), { target: { value: '18:00' } });
      fireEvent.click(screen.getByTestId('pam-rule-window-day-1'));
      fireEvent.click(screen.getByTestId('pam-rule-window-day-2'));
      fireEvent.change(screen.getByTestId('pam-rule-window-timezone'), {
        target: { value: 'Europe/Berlin' },
      });
      fireEvent.click(screen.getByTestId('pam-rule-submit'));

      await waitFor(() => {
        expect(findMutationCall('/pam/rules', 'POST')).toBeDefined();
      });
      const payload = bodyOf(findMutationCall('/pam/rules', 'POST'));
      expect(payload.timeWindow).toEqual({
        start: '08:00',
        end: '18:00',
        days: [1, 2],
        timezone: 'Europe/Berlin',
      });
    });

    it('omits days when none are selected and timezone when empty', async () => {
      installFetchRoutes({ rules: [] });
      render(<PamRulesTab />);
      await openCreateModal();

      fireEvent.change(screen.getByTestId('pam-rule-name'), { target: { value: 'Windowed' } });
      fireEvent.change(screen.getByTestId('pam-rule-signer'), { target: { value: 'Acme Corp' } });
      fireEvent.change(screen.getByTestId('pam-rule-window-start'), { target: { value: '08:00' } });
      fireEvent.change(screen.getByTestId('pam-rule-window-end'), { target: { value: '18:00' } });
      fireEvent.click(screen.getByTestId('pam-rule-submit'));

      await waitFor(() => {
        expect(findMutationCall('/pam/rules', 'POST')).toBeDefined();
      });
      const payload = bodyOf(findMutationCall('/pam/rules', 'POST'));
      expect(payload.timeWindow).toEqual({ start: '08:00', end: '18:00' });
    });

    it('blocks submit with an inline error when start is set without end', async () => {
      installFetchRoutes({ rules: [] });
      render(<PamRulesTab />);
      await openCreateModal();

      fireEvent.change(screen.getByTestId('pam-rule-name'), { target: { value: 'Half window' } });
      fireEvent.change(screen.getByTestId('pam-rule-signer'), { target: { value: 'Acme Corp' } });
      fireEvent.change(screen.getByTestId('pam-rule-window-start'), { target: { value: '08:00' } });
      fireEvent.click(screen.getByTestId('pam-rule-submit'));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/start and end/i);
      });
      expect(findMutationCall('/pam/rules', 'POST')).toBeUndefined();
    });
  });

  describe('site scoping', () => {
    const sites = [
      { id: 'site-1', name: 'HQ' },
      { id: 'site-2', name: 'Warehouse' },
    ];

    it('sends the selected site uuid when a site is picked', async () => {
      installFetchRoutes({ rules: [], sites });
      render(<PamRulesTab />);
      await openCreateModal();

      await waitFor(() => {
        expect(
          (screen.getByTestId('pam-rule-site') as HTMLSelectElement).options.length,
        ).toBeGreaterThan(1);
      });
      fireEvent.change(screen.getByTestId('pam-rule-name'), { target: { value: 'HQ rule' } });
      fireEvent.change(screen.getByTestId('pam-rule-signer'), { target: { value: 'Acme Corp' } });
      fireEvent.change(screen.getByTestId('pam-rule-site'), { target: { value: 'site-1' } });
      fireEvent.click(screen.getByTestId('pam-rule-submit'));

      await waitFor(() => {
        expect(findMutationCall('/pam/rules', 'POST')).toBeDefined();
      });
      expect(bodyOf(findMutationCall('/pam/rules', 'POST')).siteId).toBe('site-1');
    });

    it('preselects the site when editing a site-scoped rule', async () => {
      const siteScoped: PamRule = { ...signedRule, id: 'rule-s', siteId: 'site-2' };
      installFetchRoutes({ rules: [siteScoped], sites });
      render(<PamRulesTab />);
      await waitFor(() => screen.getByTestId('pam-rule-edit-rule-s'));
      fireEvent.click(screen.getByTestId('pam-rule-edit-rule-s'));

      await waitFor(() => {
        expect((screen.getByTestId('pam-rule-site') as HTMLSelectElement).value).toBe('site-2');
      });
    });
  });

  describe('organization scoping (partner scope)', () => {
    const orgs = [
      { id: 'org-1', name: 'Acme' },
      { id: 'org-2', name: 'Beta LLC' },
    ];

    it('shows an org select for multi-org users, scopes the sites fetch, and sends the choice', async () => {
      installFetchRoutes({ rules: [], orgs, sites: [{ id: 'site-9', name: 'Beta HQ' }] });
      render(<PamRulesTab />);
      await openCreateModal();

      await waitFor(() => {
        expect((screen.getByTestId('pam-rule-org') as HTMLSelectElement).value).toBe('org-1');
      });
      // Sites are fetched scoped to the selected org.
      await waitFor(() => {
        expect(
          fetchWithAuthMock.mock.calls.some(
            (c) => typeof c[0] === 'string' && c[0].includes('/orgs/sites') && c[0].includes('organizationId=org-1'),
          ),
        ).toBe(true);
      });

      fireEvent.change(screen.getByTestId('pam-rule-org'), { target: { value: 'org-2' } });
      await waitFor(() => {
        expect(
          fetchWithAuthMock.mock.calls.some(
            (c) => typeof c[0] === 'string' && c[0].includes('/orgs/sites') && c[0].includes('organizationId=org-2'),
          ),
        ).toBe(true);
      });

      fireEvent.change(screen.getByTestId('pam-rule-name'), { target: { value: 'Beta rule' } });
      fireEvent.change(screen.getByTestId('pam-rule-signer'), { target: { value: 'Acme Corp' } });
      fireEvent.click(screen.getByTestId('pam-rule-submit'));

      await waitFor(() => {
        expect(findMutationCall('/pam/rules', 'POST')).toBeDefined();
      });
      const payload = bodyOf(findMutationCall('/pam/rules', 'POST'));
      expect(payload.orgId).toBe('org-2');
      expect(payload.siteId).toBe(null);
    });

    it('hides the org select for single-org users', async () => {
      installFetchRoutes({ rules: [] });
      render(<PamRulesTab />);
      await openCreateModal();

      await waitFor(() => {
        expect(screen.getByTestId('pam-rule-site')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('pam-rule-org')).toBeNull();
    });

    it('does not send orgId on edit', async () => {
      installFetchRoutes({ rules: [signedRule], orgs });
      render(<PamRulesTab />);
      await waitFor(() => screen.getByTestId('pam-rule-edit-rule-1'));
      fireEvent.click(screen.getByTestId('pam-rule-edit-rule-1'));

      // Org is fixed on edit: no editable org select.
      await waitFor(() => screen.getByTestId('pam-rule-site'));
      expect(screen.queryByTestId('pam-rule-org')).toBeNull();

      fireEvent.change(screen.getByTestId('pam-rule-name'), { target: { value: 'Renamed' } });
      fireEvent.click(screen.getByTestId('pam-rule-submit'));

      await waitFor(() => {
        expect(findMutationCall('/pam/rules/rule-1', 'PATCH')).toBeDefined();
      });
      expect('orgId' in bodyOf(findMutationCall('/pam/rules/rule-1', 'PATCH'))).toBe(false);
    });
  });
});
