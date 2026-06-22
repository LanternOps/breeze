import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PamRuleModal from './PamRuleModal';
import { fetchWithAuth } from '../../stores/auth';
import type { PamRuleDraft, PamRuleNegateKey } from './types';

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

  it('sends matchCommandLine and a matchNegate array for negated criteria', async () => {
    const user = userEvent.setup();
    installFetchRoutes();
    let postBody: Record<string, unknown> | null = null;
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url.startsWith('/orgs/organizations')) return makeJsonResponse({ data: [{ id: 'org-1', name: 'Acme' }] });
      if (url.startsWith('/orgs/sites')) return makeJsonResponse({ data: [] });
      if (url === '/pam/rules' && method === 'POST') {
        postBody = JSON.parse(init!.body as string);
        return makeJsonResponse({ success: true, rule: {} }, true, 201);
      }
      return makeJsonResponse({ success: true });
    });

    render(<PamRuleModal rule={null} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('pam-rule-match-command-line')).toBeInTheDocument());

    await user.type(screen.getByTestId('pam-rule-name'), 'Only printui rundll32');
    await user.type(screen.getByTestId('pam-rule-path'), 'C:\\Windows\\System32\\rundll32.exe');
    await user.type(screen.getByTestId('pam-rule-match-command-line'), 'printui.dll,PrintUIEntry');
    // Negate the path glob: "rundll32 unless ..." — the path stays, but the
    // command-line criterion is the positive match.
    await user.click(screen.getByTestId('pam-rule-negate-pathGlob'));
    await user.click(screen.getByTestId('pam-rule-submit'));

    await waitFor(() => expect(postBody).not.toBeNull());
    expect(postBody!.matchCommandLine).toBe('printui.dll,PrintUIEntry');
    expect(postBody!.matchNegate).toEqual(['pathGlob']);
  });

  it('omits a dangling negate key whose criterion is empty', async () => {
    const user = userEvent.setup();
    installFetchRoutes();
    let postBody: Record<string, unknown> | null = null;
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url.startsWith('/orgs/organizations')) return makeJsonResponse({ data: [{ id: 'org-1', name: 'Acme' }] });
      if (url.startsWith('/orgs/sites')) return makeJsonResponse({ data: [] });
      if (url === '/pam/rules' && method === 'POST') {
        postBody = JSON.parse(init!.body as string);
        return makeJsonResponse({ success: true, rule: {} }, true, 201);
      }
      return makeJsonResponse({ success: true });
    });

    render(<PamRuleModal rule={null} onClose={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('pam-rule-signer')).toBeInTheDocument());

    await user.type(screen.getByTestId('pam-rule-name'), 'Signer only');
    await user.type(screen.getByTestId('pam-rule-signer'), 'Acme Corp');
    // Toggle parentImage negation but leave the parent-image field empty.
    await user.click(screen.getByTestId('pam-rule-negate-parentImage'));
    await user.click(screen.getByTestId('pam-rule-submit'));

    await waitFor(() => expect(postBody).not.toBeNull());
    // No populated negatable criterion → matchNegate is null, not ['parentImage'].
    expect(postBody!.matchNegate).toBeNull();
  });

  it('seeds the negate toggles and command line from an edited rule', async () => {
    installFetchRoutes();
    const rule = {
      id: 'rule-x',
      orgId: 'org-1',
      name: 'rundll32 not printui',
      enabled: true,
      priority: 100,
      matchPathGlob: 'C:\\Windows\\System32\\rundll32.exe',
      matchCommandLine: 'printui.dll',
      matchNegate: ['commandLine'] as PamRuleNegateKey[],
      verdict: 'require_approval' as const,
      createdAt: '2026-06-10T00:00:00.000Z',
      updatedAt: '2026-06-10T00:00:00.000Z',
    };
    render(<PamRuleModal rule={rule} onClose={() => {}} onSaved={() => {}} />);

    await waitFor(() =>
      expect((screen.getByTestId('pam-rule-match-command-line') as HTMLInputElement).value).toBe('printui.dll'),
    );
    expect((screen.getByTestId('pam-rule-negate-commandLine') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('pam-rule-negate-pathGlob') as HTMLInputElement).checked).toBe(false);
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

  describe('signer group selector', () => {
    const signerGroups = [
      { id: 'grp-1', orgId: 'org-1', name: 'Trusted vendors', signers: ['Acme Corp'], createdAt: '', updatedAt: '' },
      { id: 'grp-2', orgId: 'org-1', name: 'Microsoft', signers: ['Microsoft Corporation'], createdAt: '', updatedAt: '' },
    ];

    function installWithGroups(captured: { postBody: Record<string, unknown> | null }) {
      fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (url.startsWith('/orgs/organizations')) return makeJsonResponse({ data: [{ id: 'org-1', name: 'Acme' }] });
        if (url.startsWith('/orgs/sites')) return makeJsonResponse({ data: [] });
        if (url.startsWith('/pam/signer-groups') && method === 'GET') {
          return makeJsonResponse({ success: true, signerGroups });
        }
        if (url === '/pam/rules' && method === 'POST') {
          captured.postBody = JSON.parse(init!.body as string);
          return makeJsonResponse({ success: true, rule: {} }, true, 201);
        }
        return makeJsonResponse({ success: true });
      });
    }

    it('fetches and lists the org signer groups as options', async () => {
      installWithGroups({ postBody: null });
      render(<PamRuleModal rule={null} onClose={() => {}} onSaved={() => {}} />);

      await waitFor(() => {
        const select = screen.getByTestId('pam-rule-match-signer-group') as HTMLSelectElement;
        // blank "— none —" plus the two groups
        expect(select.options.length).toBe(3);
      });
      const select = screen.getByTestId('pam-rule-match-signer-group') as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'grp-1', 'grp-2']);
    });

    it('picking a group clears and disables the free-text signer, and sends matchSignerGroupId', async () => {
      const user = userEvent.setup();
      const captured: { postBody: Record<string, unknown> | null } = { postBody: null };
      installWithGroups(captured);
      render(<PamRuleModal rule={null} onClose={() => {}} onSaved={() => {}} />);

      await waitFor(() => {
        expect(
          (screen.getByTestId('pam-rule-match-signer-group') as HTMLSelectElement).options.length,
        ).toBe(3);
      });

      // Type a signer first, then pick a group — the signer must be cleared.
      await user.type(screen.getByTestId('pam-rule-signer'), 'Some Corp');
      await user.selectOptions(screen.getByTestId('pam-rule-match-signer-group'), 'grp-1');

      expect((screen.getByTestId('pam-rule-signer') as HTMLInputElement).value).toBe('');
      expect((screen.getByTestId('pam-rule-signer') as HTMLInputElement).disabled).toBe(true);

      await user.type(screen.getByTestId('pam-rule-name'), 'Vendor group rule');
      await user.click(screen.getByTestId('pam-rule-submit'));

      await waitFor(() => expect(captured.postBody).not.toBeNull());
      expect(captured.postBody!.matchSignerGroupId).toBe('grp-1');
      expect(captured.postBody!.matchSigner).toBe(null);
    });

    it('typing a signer clears a previously selected group', async () => {
      const user = userEvent.setup();
      const captured: { postBody: Record<string, unknown> | null } = { postBody: null };
      installWithGroups(captured);
      render(<PamRuleModal rule={null} onClose={() => {}} onSaved={() => {}} />);

      await waitFor(() => {
        expect(
          (screen.getByTestId('pam-rule-match-signer-group') as HTMLSelectElement).options.length,
        ).toBe(3);
      });

      await user.selectOptions(screen.getByTestId('pam-rule-match-signer-group'), 'grp-2');
      expect((screen.getByTestId('pam-rule-match-signer-group') as HTMLSelectElement).value).toBe('grp-2');

      // The signer input is disabled while a group is set; clearing the group
      // re-enables it. Reset the select, then type.
      await user.selectOptions(screen.getByTestId('pam-rule-match-signer-group'), '');
      await user.type(screen.getByTestId('pam-rule-signer'), 'Acme Corp');
      expect((screen.getByTestId('pam-rule-match-signer-group') as HTMLSelectElement).value).toBe('');

      await user.type(screen.getByTestId('pam-rule-name'), 'Signer text rule');
      await user.click(screen.getByTestId('pam-rule-submit'));

      await waitFor(() => expect(captured.postBody).not.toBeNull());
      expect(captured.postBody!.matchSigner).toBe('Acme Corp');
      expect(captured.postBody!.matchSignerGroupId).toBe(null);
    });

    it('seeds the selected group from rule.matchSignerGroupId on edit', async () => {
      installWithGroups({ postBody: null });
      const rule = {
        id: 'rule-g',
        orgId: 'org-1',
        name: 'Existing group rule',
        enabled: true,
        priority: 10,
        matchSignerGroupId: 'grp-2',
        verdict: 'auto_approve' as const,
        createdAt: '2026-06-10T00:00:00.000Z',
        updatedAt: '2026-06-10T00:00:00.000Z',
      };
      render(<PamRuleModal rule={rule} onClose={() => {}} onSaved={() => {}} />);

      await waitFor(() => {
        expect((screen.getByTestId('pam-rule-match-signer-group') as HTMLSelectElement).value).toBe('grp-2');
      });
      // Signer text is disabled because a group is selected.
      expect((screen.getByTestId('pam-rule-signer') as HTMLInputElement).disabled).toBe(true);
    });
  });
});
