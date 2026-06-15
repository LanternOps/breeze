import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PolicyEditor, { testPattern } from './PolicyEditor';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const USER_1 = 'beefbeef-1111-4222-8333-444455556666';

// Plan-1 getOrgPolicy defaults (admin.test.ts fixture).
const DEFAULT_POLICY = {
  orgId: ORG_ID,
  enabled: false,
  userAccess: 'all',
  selectedUserIds: [],
  allowedProviders: ['anthropic'],
  allowedModels: [],
  writeMode: 'readwrite',
  dlpConfig: {},
  dailyBudgetCents: null,
  monthlyBudgetCents: null,
  perUserMessagesPerMinute: 10,
  orgMessagesPerHour: 500,
  retentionDays: null,
  branding: {},
};

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

function mockApi(policy: unknown = DEFAULT_POLICY) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `/client-ai/admin/orgs/${ORG_ID}/policy` && !init?.method) {
      return makeJsonResponse({ policy });
    }
    if (url === `/client-ai/admin/orgs/${ORG_ID}/policy` && init?.method === 'PUT') {
      return makeJsonResponse({ policy });
    }
    if (url === `/client-ai/admin/orgs/${ORG_ID}/users` && !init?.method) {
      return makeJsonResponse({
        data: [{ id: USER_1, email: 'a@contoso.com', name: 'A', lastLoginAt: null }],
      });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 500);
  });
}

describe('PolicyEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves the exact putPolicySchema payload', async () => {
    mockApi();
    render(<PolicyEditor orgId={ORG_ID} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('ai-office-policy-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('ai-office-policy-enabled'), { target: { value: 'true' } });
    fireEvent.change(screen.getByTestId('ai-office-policy-writemode'), { target: { value: 'readonly' } });
    fireEvent.change(screen.getByTestId('ai-office-policy-writeapproval'), {
      target: { value: 'allow_auto' },
    });
    fireEvent.click(screen.getByTestId('ai-office-policy-model-claude-sonnet-4-5-20250929'));
    fireEvent.change(screen.getByTestId('ai-office-policy-monthly-budget'), { target: { value: '25.00' } });
    fireEvent.change(screen.getByTestId('ai-office-policy-dlp-ssn'), { target: { value: 'block' } });
    fireEvent.click(screen.getByTestId('ai-office-policy-dlp-add-rule'));
    fireEvent.change(screen.getByTestId('ai-office-policy-dlp-rule-name-0'), { target: { value: 'Project codes' } });
    fireEvent.change(screen.getByTestId('ai-office-policy-dlp-rule-pattern-0'), { target: { value: 'PRJ-\\d{4}' } });
    fireEvent.change(screen.getByTestId('ai-office-policy-dlp-rule-action-0'), { target: { value: 'block' } });
    fireEvent.change(screen.getByTestId('ai-office-policy-brand-name'), { target: { value: 'Lantern IT' } });
    fireEvent.click(screen.getByTestId('ai-office-policy-save'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    );
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(String(putCall![0])).toBe(`/client-ai/admin/orgs/${ORG_ID}/policy`);
    const body = JSON.parse(String(putCall![1]!.body));
    expect(body).toEqual({
      enabled: true,
      userAccess: 'all',
      selectedUserIds: [],
      allowedModels: ['claude-sonnet-4-5-20250929'],
      writeMode: 'readonly',
      writeApproval: 'allow_auto',
      dlpConfig: {
        builtins: {
          creditCard: 'redact',
          ssn: 'block',
          iban: 'redact',
          apiKey: 'redact',
          email: 'off',
          phone: 'off',
        },
        customRules: [
          { id: expect.any(String), name: 'Project codes', pattern: 'PRJ-\\d{4}', action: 'block' },
        ],
      },
      dailyBudgetCents: null,
      monthlyBudgetCents: 2500,
      perUserMessagesPerMinute: 10,
      orgMessagesPerHour: 500,
      retentionDays: null,
      branding: { displayName: 'Lantern IT', logoUrl: null },
    });
  });

  it('sends selectedUserIds when access is "selected"', async () => {
    mockApi();
    render(<PolicyEditor orgId={ORG_ID} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('ai-office-policy-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('ai-office-policy-useraccess'), { target: { value: 'selected' } });
    fireEvent.click(screen.getByTestId(`ai-office-policy-user-${USER_1}`));
    fireEvent.click(screen.getByTestId('ai-office-policy-save'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    );
    const body = JSON.parse(
      String(fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')![1]!.body)
    );
    expect(body.userAccess).toBe('selected');
    expect(body.selectedUserIds).toEqual([USER_1]);
  });

  it('blocks save and toasts when a custom rule pattern does not compile', async () => {
    mockApi();
    render(<PolicyEditor orgId={ORG_ID} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('ai-office-policy-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ai-office-policy-dlp-add-rule'));
    fireEvent.change(screen.getByTestId('ai-office-policy-dlp-rule-name-0'), { target: { value: 'Broken' } });
    fireEvent.change(screen.getByTestId('ai-office-policy-dlp-rule-pattern-0'), { target: { value: '(' } });
    fireEvent.click(screen.getByTestId('ai-office-policy-save'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
    );
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('live regex test box shows match counts and compile errors', async () => {
    mockApi();
    render(<PolicyEditor orgId={ORG_ID} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('ai-office-policy-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ai-office-policy-dlp-add-rule'));
    fireEvent.change(screen.getByTestId('ai-office-policy-dlp-rule-pattern-0'), { target: { value: 'PRJ-\\d{4}' } });
    fireEvent.change(screen.getByTestId('ai-office-policy-dlp-sample'), {
      target: { value: 'PRJ-0001 and PRJ-0002 but not PRJ-1' },
    });
    expect(screen.getByTestId('ai-office-policy-dlp-rule-result-0').textContent).toContain('2 matches');

    fireEvent.change(screen.getByTestId('ai-office-policy-dlp-rule-pattern-0'), { target: { value: '(' } });
    expect(screen.getByTestId('ai-office-policy-dlp-rule-result-0').textContent).toContain('Pattern error');
  });

  it('defaults the writeApproval control to "ask" and loads a stored value', async () => {
    mockApi({ ...DEFAULT_POLICY, writeApproval: 'allow_auto' });
    render(<PolicyEditor orgId={ORG_ID} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('ai-office-policy-editor')).toBeInTheDocument());
    expect((screen.getByTestId('ai-office-policy-writeapproval') as HTMLSelectElement).value).toBe(
      'allow_auto'
    );
  });

  it('defaults writeApproval to "ask" when the policy omits it (default-deny)', async () => {
    mockApi(DEFAULT_POLICY); // no writeApproval field
    render(<PolicyEditor orgId={ORG_ID} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('ai-office-policy-editor')).toBeInTheDocument());
    expect((screen.getByTestId('ai-office-policy-writeapproval') as HTMLSelectElement).value).toBe(
      'ask'
    );
    // And the saved payload carries 'ask'.
    fireEvent.click(screen.getByTestId('ai-office-policy-save'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    );
    const body = JSON.parse(
      String(fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')![1]!.body)
    );
    expect(body.writeApproval).toBe('ask');
  });

  it('testPattern counts matches and reports compile errors', () => {
    expect(testPattern('\\d+', 'a1 b22')).toEqual({ ok: true, matches: 2 });
    expect(testPattern('([', 'x').ok).toBe(false);
  });
});
