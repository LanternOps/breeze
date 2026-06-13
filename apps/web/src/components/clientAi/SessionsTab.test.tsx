import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SessionsTab from './SessionsTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const SESSION_ID = '5e5e5e5e-1111-4222-8333-444455556666';

const LIST_ROW = {
  id: SESSION_ID,
  orgId: ORG_ID,
  orgName: 'Contoso Accounting',
  clientUserId: 'beefbeef-1111-4222-8333-444455556666',
  userEmail: 'finance.user@contoso.com',
  title: 'Q3 budget review',
  startedAt: '2026-06-10T09:00:00Z',
  lastActivityAt: '2026-06-10T09:20:00Z',
  turnCount: 6,
  totalCostCents: 12.5,
  flaggedAt: null,
  flagReason: null,
  status: 'closed',
};

const DETAIL = {
  session: {
    ...LIST_ROW,
    model: 'claude-sonnet-4-5-20250929',
    totalInputTokens: 4000,
    totalOutputTokens: 900,
    flaggedBy: null,
    createdAt: '2026-06-10T09:00:00Z',
  },
  messages: [
    {
      id: 'm1',
      role: 'user',
      content: 'Card [REDACTED:creditCard] please summarize',
      contentBlocks: null,
      toolName: null,
      toolInput: null,
      toolOutput: null,
      createdAt: '2026-06-10T09:00:01Z',
      redactionCounts: { creditCard: 1 },
    },
  ],
  toolExecutions: [
    {
      id: 't1',
      toolName: 'write_range',
      toolInput: { range: 'B2:B4' },
      status: 'completed',
      approvedBy: null,
      approvedAt: '2026-06-10T09:05:00Z',
      errorMessage: null,
      durationMs: 240,
      createdAt: '2026-06-10T09:04:00Z',
      completedAt: '2026-06-10T09:05:01Z',
    },
  ],
};

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

function mockApi() {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/client-ai/admin/orgs' && !init?.method) {
      return makeJsonResponse({
        data: [{ orgId: ORG_ID, orgName: 'Contoso Accounting' }],
      });
    }
    if (url.startsWith('/client-ai/admin/sessions?') && !init?.method) {
      return makeJsonResponse({
        data: [LIST_ROW],
        pagination: { total: 1, limit: 50, offset: 0 },
      });
    }
    if (url === `/client-ai/admin/sessions/${SESSION_ID}` && !init?.method) {
      return makeJsonResponse(DETAIL);
    }
    if (url === `/client-ai/admin/sessions/${SESSION_ID}/flag` && init?.method === 'POST') {
      return makeJsonResponse({ success: true });
    }
    if (url === `/client-ai/admin/sessions/${SESSION_ID}/flag` && init?.method === 'DELETE') {
      return makeJsonResponse({ success: true });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 500);
  });
}

describe('SessionsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists sessions and shows the transcript with redaction badges + tool trail', async () => {
    mockApi();
    render(<SessionsTab />);
    await waitFor(() =>
      expect(screen.getByTestId(`ai-office-session-row-${SESSION_ID}`)).toBeInTheDocument()
    );
    expect(screen.getByText('finance.user@contoso.com')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`ai-office-session-row-${SESSION_ID}`));
    await waitFor(() =>
      expect(screen.getByTestId('ai-office-redaction-creditCard')).toBeInTheDocument()
    );
    expect(screen.getByTestId('ai-office-redaction-creditCard').textContent).toContain('×1');
    expect(screen.getByTestId('ai-office-tool-exec-t1')).toBeInTheDocument();
    expect(screen.getByText('B2:B4')).toBeInTheDocument();
  });

  it('flags a session with a reason (exact POST payload)', async () => {
    mockApi();
    render(<SessionsTab />);
    await waitFor(() =>
      expect(screen.getByTestId(`ai-office-session-row-${SESSION_ID}`)).toBeInTheDocument()
    );

    fireEvent.click(screen.getByTestId(`ai-office-session-row-${SESSION_ID}`));
    await waitFor(() => expect(screen.getByTestId('ai-office-session-flag')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ai-office-session-flag'));
    fireEvent.change(screen.getByTestId('ai-office-flag-reason'), {
      target: { value: 'PII concern' },
    });
    fireEvent.click(screen.getByTestId('ai-office-flag-confirm'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    );
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(String(postCall![0])).toBe(`/client-ai/admin/sessions/${SESSION_ID}/flag`);
    expect(JSON.parse(String(postCall![1]!.body))).toEqual({ reason: 'PII concern' });
  });

  it('unflags a flagged session through the confirm dialog', async () => {
    // Same mock surface as mockApi(), but the session is flagged so the
    // Unflag button renders.
    const flaggedDetail = {
      ...DETAIL,
      session: { ...DETAIL.session, flaggedAt: '2026-06-11T00:00:00Z', flagReason: 'old' },
    };
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/client-ai/admin/orgs' && !init?.method)
        return makeJsonResponse({ data: [{ orgId: ORG_ID, orgName: 'Contoso Accounting' }] });
      if (url.startsWith('/client-ai/admin/sessions?') && !init?.method)
        return makeJsonResponse({
          data: [{ ...LIST_ROW, flaggedAt: '2026-06-11T00:00:00Z', flagReason: 'old' }],
          pagination: { total: 1, limit: 50, offset: 0 },
        });
      if (url === `/client-ai/admin/sessions/${SESSION_ID}` && !init?.method)
        return makeJsonResponse(flaggedDetail);
      if (url === `/client-ai/admin/sessions/${SESSION_ID}/flag` && init?.method === 'DELETE')
        return makeJsonResponse({ success: true });
      return makeJsonResponse({ error: 'unexpected' }, false, 500);
    });

    render(<SessionsTab />);
    await waitFor(() =>
      expect(screen.getByTestId(`ai-office-session-row-${SESSION_ID}`)).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId(`ai-office-session-row-${SESSION_ID}`));
    await waitFor(() => expect(screen.getByTestId('ai-office-session-unflag')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ai-office-session-unflag'));
    fireEvent.click(screen.getByTestId('ai-office-unflag-confirm'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
    );
  });

  it('flagged-only filter adds flagged=true to the list query', async () => {
    mockApi();
    render(<SessionsTab />);
    await waitFor(() =>
      expect(screen.getByTestId('ai-office-sessions-flagged')).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId('ai-office-sessions-flagged'));
    await waitFor(() => {
      const listCalls = fetchMock.mock.calls.filter(([u]) =>
        String(u).startsWith('/client-ai/admin/sessions?')
      );
      expect(String(listCalls[listCalls.length - 1]![0])).toContain('flagged=true');
    });
  });
});
