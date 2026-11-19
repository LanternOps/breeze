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

function mockApi(listRow: Record<string, unknown> = LIST_ROW, detail: unknown = DETAIL) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/client-ai/admin/orgs' && !init?.method) {
      return makeJsonResponse({
        data: [{ orgId: ORG_ID, orgName: 'Contoso Accounting' }],
      });
    }
    if (url.startsWith('/client-ai/admin/sessions?') && !init?.method) {
      return makeJsonResponse({
        data: [listRow],
        pagination: { total: 1, limit: 50, offset: 0 },
      });
    }
    if (url === `/client-ai/admin/sessions/${SESSION_ID}` && !init?.method) {
      return makeJsonResponse(detail);
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

  it('shows a platform-refused tool call as stopped, never as applied (#10411)', async () => {
    mockApi();
    const refusedExec = {
      ...DETAIL.toolExecutions[0],
      id: 't-refused',
      status: 'refused',
      approvedAt: null,
      errorMessage: 'Rate limit exceeded for write_range',
    };
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === `/client-ai/admin/sessions/${SESSION_ID}`) {
        return makeJsonResponse({ ...DETAIL, toolExecutions: [refusedExec] });
      }
      if (url.startsWith('/client-ai/admin/sessions?')) {
        return makeJsonResponse({ data: [LIST_ROW], pagination: { total: 1, limit: 50, offset: 0 } });
      }
      return makeJsonResponse({ data: [{ orgId: ORG_ID, orgName: 'Contoso Accounting' }] });
    });
    render(<SessionsTab />);
    await waitFor(() =>
      expect(screen.getByTestId(`ai-office-session-row-${SESSION_ID}`)).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId(`ai-office-session-row-${SESSION_ID}`));
    await waitFor(() => expect(screen.getByTestId('ai-office-tool-exec-t-refused')).toBeInTheDocument());

    const card = screen.getByTestId('ai-office-tool-exec-t-refused');
    expect(card.textContent).toMatch(/stopped/i);
    expect(card.textContent).not.toMatch(/refused/i);
    expect(card.textContent).not.toMatch(/applied/i);
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

  describe('transcript removed by retention (#4342 W4)', () => {
    const PURGED_AT = '2027-02-01T03:15:00Z';
    const purgedRow = { ...LIST_ROW, title: null, transcriptPurgedAt: PURGED_AT };
    const purgedDetail = {
      session: { ...DETAIL.session, title: null, transcriptPurgedAt: PURGED_AT },
      messages: [],
      toolExecutions: [],
    };

    it('labels the list row and shows the dated banner instead of "no messages"', async () => {
      mockApi(purgedRow, purgedDetail);
      render(<SessionsTab />);
      const row = await screen.findByTestId(`ai-office-session-row-${SESSION_ID}`);
      expect(row).toHaveTextContent('Removed by retention');
      fireEvent.click(row);
      const banner = await screen.findByTestId('ai-office-session-transcript-purged');
      expect(banner).toHaveTextContent(/Transcript removed by retention on/);
      expect(banner).toHaveTextContent(/2027/);
      expect(screen.queryByText('No messages stored for this session.')).toBeNull();
    });

    it('renders unchanged when transcriptPurgedAt is null', async () => {
      mockApi({ ...LIST_ROW, transcriptPurgedAt: null }, { ...DETAIL, session: { ...DETAIL.session, transcriptPurgedAt: null } });
      render(<SessionsTab />);
      const row = await screen.findByTestId(`ai-office-session-row-${SESSION_ID}`);
      expect(row).not.toHaveTextContent('Removed by retention');
      fireEvent.click(row);
      await screen.findByTestId('ai-office-redaction-creditCard');
      expect(screen.queryByTestId('ai-office-session-transcript-purged')).toBeNull();
    });
  });
});
