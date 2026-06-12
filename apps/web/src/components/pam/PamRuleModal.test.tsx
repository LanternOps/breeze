import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PamRuleModal from './PamRuleModal';
import { fetchWithAuth } from '../../stores/auth';
import type { PamRuleDraft } from './types';

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

/** The modal fetches /orgs/organizations and /orgs/sites on mount. */
function installFetchRoutes({
  sites = [] as Array<{ id: string; name: string }>,
  orgs = [{ id: 'org-1', name: 'Acme' }],
}: {
  sites?: Array<{ id: string; name: string }>;
  orgs?: Array<{ id: string; name: string }>;
} = {}) {
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/orgs/organizations')) return makeJsonResponse({ data: orgs });
    if (url.startsWith('/orgs/sites')) return makeJsonResponse({ data: sites });
    return makeJsonResponse({ success: true });
  });
}

describe('PamRuleModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pre-fills create-mode inputs from the initial draft', async () => {
    installFetchRoutes();
    const initial: PamRuleDraft = {
      shape: 'executable',
      matchSigner: 'Acme Corp',
      name: 'Rule for installer.exe',
      siteId: '',
    };
    render(<PamRuleModal rule={null} initial={initial} onClose={() => {}} onSaved={() => {}} />);

    await waitFor(() => {
      expect((screen.getByTestId('pam-rule-name') as HTMLInputElement).value).toBe(
        'Rule for installer.exe',
      );
    });
    expect((screen.getByTestId('pam-rule-signer') as HTMLInputElement).value).toBe('Acme Corp');
    // Executable shape selected by the seed.
    expect(screen.getByTestId('pam-rule-shape-executable')).toHaveClass('border-primary');
  });

  it('seeds tool-shape fields from a draft', async () => {
    installFetchRoutes();
    const initial: PamRuleDraft = {
      shape: 'tool',
      name: 'Rule for run_script',
      matchToolName: 'run_script',
      matchRiskTier: 3,
      siteId: null,
    };
    render(<PamRuleModal rule={null} initial={initial} onClose={() => {}} onSaved={() => {}} />);

    await waitFor(() => {
      expect((screen.getByTestId('pam-rule-toolname') as HTMLInputElement).value).toBe('run_script');
    });
    expect((screen.getByTestId('pam-rule-risktier') as HTMLInputElement).value).toBe('3');
  });
});
