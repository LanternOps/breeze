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

describe('PamRulesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the empty state when no rules exist', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ success: true, rules: [] }));
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
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ success: true, rules: [catchAll, signedRule] }),
    );
    render(<PamRulesTab />);
    await waitFor(() => {
      expect(screen.getByTestId('pam-rule-row-rule-1')).toBeInTheDocument();
    });
    const rows = screen.getAllByTestId(/^pam-rule-row-/);
    // priority 10 sorts before priority 500
    expect(rows[0]).toHaveAttribute('data-testid', 'pam-rule-row-rule-1');
    expect(screen.getByText('signer=Microsoft Corporation')).toBeInTheDocument();
  });

  it('toggles a rule enabled state via PATCH', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ success: true, rules: [signedRule] }))
      .mockResolvedValueOnce(
        makeJsonResponse({ success: true, rule: { ...signedRule, enabled: false } }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({ success: true, rules: [{ ...signedRule, enabled: false }] }),
      );
    render(<PamRulesTab />);
    await waitFor(() => screen.getByTestId('pam-rule-toggle-rule-1'));
    fireEvent.click(screen.getByTestId('pam-rule-toggle-rule-1'));
    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/pam/rules/rule-1',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
    const patchCall = fetchWithAuthMock.mock.calls.find((c) => c[0] === '/pam/rules/rule-1');
    expect(JSON.parse((patchCall?.[1] as RequestInit).body as string)).toEqual({ enabled: false });
  });

  it('creates a rule through the modal, sending a clean executable-shaped payload', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ success: true, rules: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ success: true, rule: signedRule }, true, 201))
      .mockResolvedValueOnce(makeJsonResponse({ success: true, rules: [signedRule] }));

    render(<PamRulesTab />);
    await waitFor(() => screen.getByTestId('pam-add-rule-btn'));
    fireEvent.click(screen.getByTestId('pam-add-rule-btn'));

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
    const postCall = fetchWithAuthMock.mock.calls.find(
      (c) => c[0] === '/pam/rules' && (c[1] as RequestInit)?.method === 'POST',
    );
    const payload = JSON.parse((postCall?.[1] as RequestInit).body as string);
    expect(payload).toMatchObject({
      name: 'Allow signed Microsoft installers',
      matchSigner: 'Microsoft Corporation',
      matchToolName: null,
      matchRiskTier: null,
      verdict: 'require_approval',
      enabled: true,
    });
  });

  it('blocks submission client-side when no criterion is provided', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ success: true, rules: [] }));
    render(<PamRulesTab />);
    await waitFor(() => screen.getByTestId('pam-add-rule-btn'));
    fireEvent.click(screen.getByTestId('pam-add-rule-btn'));

    fireEvent.change(screen.getByTestId('pam-rule-name'), { target: { value: 'No criteria' } });
    fireEvent.click(screen.getByTestId('pam-rule-submit'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('At least one match criterion');
    });
    // No POST went out
    expect(
      fetchWithAuthMock.mock.calls.find(
        (c) => c[0] === '/pam/rules' && (c[1] as RequestInit)?.method === 'POST',
      ),
    ).toBeUndefined();
  });

  it('blocks the ignore verdict for tool-action rules client-side', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ success: true, rules: [] }));
    render(<PamRulesTab />);
    await waitFor(() => screen.getByTestId('pam-add-rule-btn'));
    fireEvent.click(screen.getByTestId('pam-add-rule-btn'));

    fireEvent.change(screen.getByTestId('pam-rule-name'), { target: { value: 'Tool rule' } });
    fireEvent.click(screen.getByTestId('pam-rule-shape-tool'));
    fireEvent.change(screen.getByTestId('pam-rule-toolname'), { target: { value: 'run_script' } });
    // The ignore option is disabled in the select for tool shape; force the state
    // by asserting the option is disabled instead.
    const verdictSelect = screen.getByTestId('pam-rule-verdict') as HTMLSelectElement;
    const ignoreOption = Array.from(verdictSelect.options).find((o) => o.value === 'ignore');
    expect(ignoreOption?.disabled).toBe(true);
  });
});
