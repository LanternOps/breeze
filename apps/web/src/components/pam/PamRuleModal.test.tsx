import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('seeds selectedOrgId from the draft org for multi-org create (seed wins over default)', async () => {
    // Two orgs → the org select renders; the orgs-load effect would otherwise
    // default to items[0] (org-1), but the seed's org-2 must win (#1286 Fix A).
    installFetchRoutes({
      orgs: [
        { id: 'org-1', name: 'Acme' },
        { id: 'org-2', name: 'Globex' },
      ],
    });
    const initial: PamRuleDraft = {
      shape: 'executable',
      matchSigner: 'Acme Corp',
      orgId: 'org-2',
      siteId: '',
    };
    render(<PamRuleModal rule={null} initial={initial} onClose={() => {}} onSaved={() => {}} />);

    await waitFor(() => {
      expect((screen.getByTestId('pam-rule-org') as HTMLSelectElement).value).toBe('org-2');
    });
  });

  describe('rule preview', () => {
    const previewResult = {
      success: true,
      totalMatched: 14,
      totalScanned: 240,
      windowDays: 30,
      truncated: false,
      statusBreakdown: {
        pending: 9,
        auto_approved: 5,
        approved: 0,
        denied: 0,
        expired: 0,
        revoked: 0,
        actuating: 0,
      },
      sample: [
        {
          id: 'er-1',
          requestedAt: '2026-06-10T18:00:00Z',
          flowType: 'uac_intercept',
          subjectUsername: 'ACME\\jdoe',
          targetExecutablePath: 'C:\\Tools\\installer.exe',
          toolName: null,
          status: 'pending',
        },
        {
          id: 'er-2',
          requestedAt: '2026-06-09T12:00:00Z',
          flowType: 'uac_intercept',
          subjectUsername: 'ACME\\asmith',
          targetExecutablePath: 'C:\\Tools\\setup.exe',
          toolName: null,
          status: 'auto_approved',
        },
      ],
    };

    it('previews matches against recent requests', async () => {
      const user = userEvent.setup();
      let previewCalls = 0;
      fetchWithAuthMock.mockImplementation(async (url: string) => {
        if (url.startsWith('/orgs/organizations')) return makeJsonResponse({ data: [{ id: 'org-1', name: 'Acme' }] });
        if (url.startsWith('/orgs/sites')) return makeJsonResponse({ data: [] });
        if (url.startsWith('/pam/rules/preview')) {
          previewCalls += 1;
          return makeJsonResponse(previewResult);
        }
        return makeJsonResponse({ success: true });
      });

      render(<PamRuleModal rule={null} onClose={() => {}} onSaved={() => {}} />);

      await waitFor(() => {
        expect(screen.getByTestId('pam-rule-signer')).toBeInTheDocument();
      });

      await user.type(screen.getByTestId('pam-rule-signer'), 'Acme Corp');
      await user.click(screen.getByTestId('pam-rule-preview-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('pam-rule-preview-result')).toBeInTheDocument();
      });
      expect(previewCalls).toBe(1);
      const result = screen.getByTestId('pam-rule-preview-result');
      expect(result.textContent).toContain('Would have matched');
      expect(result.textContent).toContain('14');
      expect(result.textContent).toContain('240');
      expect(result.textContent).toContain('30 days');
      expect(result.textContent).toContain('9 pending');
    });

    it('shows the criterion error and does not call preview when no criteria entered', async () => {
      const user = userEvent.setup();
      let previewCalls = 0;
      fetchWithAuthMock.mockImplementation(async (url: string) => {
        if (url.startsWith('/orgs/organizations')) return makeJsonResponse({ data: [{ id: 'org-1', name: 'Acme' }] });
        if (url.startsWith('/orgs/sites')) return makeJsonResponse({ data: [] });
        if (url.startsWith('/pam/rules/preview')) {
          previewCalls += 1;
          return makeJsonResponse(previewResult);
        }
        return makeJsonResponse({ success: true });
      });

      render(<PamRuleModal rule={null} onClose={() => {}} onSaved={() => {}} />);

      await waitFor(() => {
        expect(screen.getByTestId('pam-rule-preview-btn')).toBeInTheDocument();
      });

      await user.click(screen.getByTestId('pam-rule-preview-btn'));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toContain('At least one match criterion is required.');
      });
      expect(previewCalls).toBe(0);
      expect(screen.queryByTestId('pam-rule-preview-result')).not.toBeInTheDocument();
    });

    it('surfaces the server zod error message on a 400 preview response', async () => {
      const user = userEvent.setup();
      fetchWithAuthMock.mockImplementation(async (url: string) => {
        if (url.startsWith('/orgs/organizations')) return makeJsonResponse({ data: [{ id: 'org-1', name: 'Acme' }] });
        if (url.startsWith('/orgs/sites')) return makeJsonResponse({ data: [] });
        if (url.startsWith('/pam/rules/preview')) {
          // @hono/zod-validator 400 shape: { success:false, error: ZodError }.
          return makeJsonResponse(
            { success: false, error: { issues: [{ message: 'matchHash must be a 64-char sha256 hex string' }] } },
            false,
            400,
          );
        }
        return makeJsonResponse({ success: true });
      });

      render(<PamRuleModal rule={null} onClose={() => {}} onSaved={() => {}} />);

      await waitFor(() => {
        expect(screen.getByTestId('pam-rule-hash')).toBeInTheDocument();
      });

      await user.type(screen.getByTestId('pam-rule-signer'), 'Acme Corp');
      await user.click(screen.getByTestId('pam-rule-preview-btn'));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toContain(
          'matchHash must be a 64-char sha256 hex string',
        );
      });
      expect(screen.getByRole('alert').textContent).not.toContain('HTTP 400');
    });
  });
});
