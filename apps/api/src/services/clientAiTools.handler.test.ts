import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  requestToolMock,
  applyDlpMock,
  writeAuditEventMock,
  messagesValuesMock,
  executionsValuesMock,
  dbInsertMock,
} = vi.hoisted(() => {
  const messagesValues = vi.fn(() => Promise.resolve());
  const executionsValues = vi.fn(() => Promise.resolve());
  return {
    requestToolMock: vi.fn(),
    applyDlpMock: vi.fn(),
    writeAuditEventMock: vi.fn(),
    messagesValuesMock: messagesValues,
    executionsValuesMock: executionsValues,
    // First insert per handler call = ai_messages, second = ai_tool_executions
    dbInsertMock: vi.fn(),
  };
});

vi.mock('./clientAiToolBridge', () => ({
  requestClientToolExecution: requestToolMock,
}));
vi.mock('./clientAiDlp', () => ({ applyDlp: applyDlpMock }));
vi.mock('./auditEvents', () => ({
  writeAuditEvent: writeAuditEventMock,
  requestLikeFromSnapshot: (s: { ip?: string; userAgent?: string }) => ({
    req: { header: () => s.userAgent },
  }),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('../db', () => ({
  db: { insert: dbInsertMock },
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

import { makeClientToolHandler } from './clientAiTools';
import type { ActiveSession } from './streamingSessionManager';

const ORG = '0c0c0c0c-1111-4222-8333-444455556666';
const CLIENT_USER = 'beefbeef-1111-4222-8333-444455556666';
const SESSION_ID = 'a1a1a1a1-1111-4222-8333-444455556666';

function makeSession(overrides: Partial<{ clientWriteMode: 'readonly' | 'readwrite'; queue: string[] }> = {}) {
  const publish = vi.fn();
  const session = {
    breezeSessionId: SESSION_ID,
    orgId: ORG,
    eventBus: { publish },
    toolUseIdQueue: overrides.queue ?? ['toolu_abc123'],
    auditSnapshot: { ip: '203.0.113.7', userAgent: 'office-addin' },
    auth: { user: { id: CLIENT_USER, email: 'finance.user@contoso.com' } },
    clientWriteMode: overrides.clientWriteMode ?? 'readwrite',
    clientDlpConfig: {},
  } as unknown as ActiveSession;
  return { session, publish };
}

function passthroughDlp() {
  applyDlpMock.mockImplementation(
    async (input: { text?: string; cells?: unknown[][] }) => ({
      action: 'allow',
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.cells !== undefined ? { cells: input.cells.map((r) => [...r]) } : {}),
      redactions: [],
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  let call = 0;
  dbInsertMock.mockImplementation(() => {
    call++;
    return { values: call % 2 === 1 ? messagesValuesMock : executionsValuesMock };
  });
  passthroughDlp();
});

describe('makeClientToolHandler — readonly write-mode gate', () => {
  it('rejects mutating tools server-side without calling the bridge, audits tool_reject', async () => {
    const { session, publish } = makeSession({ clientWriteMode: 'readonly' });
    const handler = makeClientToolHandler('excel', 'write_range', () => session);

    const result = await handler({ address: 'A1', cells: [[1]] });

    expect(result.isError).toBe(true);
    expect(requestToolMock).not.toHaveBeenCalled();
    expect(executionsValuesMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ai.client_session.tool_reject',
        result: 'denied',
        actorType: 'user',
        actorId: CLIENT_USER,
        orgId: ORG,
        details: expect.objectContaining({ principalType: 'portal_user', reason: 'readonly_policy' }),
      }),
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tool_completed', status: 'rejected', toolName: 'write_range' }),
    );
  });

  it('still allows read tools under readonly', async () => {
    const { session } = makeSession({ clientWriteMode: 'readonly' });
    requestToolMock.mockResolvedValue({ status: 'success', output: { cells: [['x']] } });
    const handler = makeClientToolHandler('excel', 'read_range', () => session);
    const result = await handler({ address: 'A1' });
    expect(result.isError).toBeFalsy();
    expect(requestToolMock).toHaveBeenCalled();
  });
});

describe('makeClientToolHandler — success path', () => {
  it('round-trips through the bridge with the FIFO toolUseId, persists redacted output, audits, publishes tool_completed', async () => {
    const { session, publish } = makeSession({ queue: ['toolu_real'] });
    requestToolMock.mockResolvedValue({ status: 'success', output: { address: 'A1:B1', cells: [['v1', 'v2']] } });
    applyDlpMock.mockImplementation(async (input: { text?: string; cells?: unknown[][] }) => {
      if (input.cells) {
        return {
          action: 'allow',
          cells: [['[REDACTED:creditCard]', 'v2']],
          redactions: [{ rule: 'creditCard', count: 1, location: 'cell[0][0]' }],
        };
      }
      return { action: 'allow', text: input.text, redactions: [] };
    });

    const handler = makeClientToolHandler('excel', 'read_range', () => session);
    const result = await handler({ address: 'A1:B1' });

    expect(requestToolMock).toHaveBeenCalledWith(session, 'toolu_real', 'read_range', { address: 'A1:B1' }, false);

    // Persisted form is the REDACTED form, with redactions in content_blocks
    expect(messagesValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION_ID,
      role: 'tool_result',
      toolUseId: 'toolu_real',
      toolName: 'read_range',
      toolOutput: expect.objectContaining({ cells: [['[REDACTED:creditCard]', 'v2']] }),
      contentBlocks: [
        { type: 'dlp_redactions', redactions: [{ rule: 'creditCard', count: 1, location: 'cell[0][0]' }] },
      ],
    }));
    expect(executionsValuesMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'ai.client_session.tool_execute', result: 'success' }),
    );
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_completed', status: 'success' }));

    // The model sees the redacted form
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('[REDACTED:creditCard]');
    expect(result.content[0]!.text).not.toContain('v1');
  });

  it('mints a toolUseId when the FIFO queue is empty', async () => {
    const { session } = makeSession({ queue: [] });
    requestToolMock.mockResolvedValue({ status: 'success', output: { ok: true } });
    const handler = makeClientToolHandler('excel', 'read_selection', () => session);
    await handler({});
    const usedId = requestToolMock.mock.calls[0]![1] as string;
    expect(usedId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('makeClientToolHandler — DLP block on tool output', () => {
  it('returns a block-reason error tool_result and never persists the raw payload', async () => {
    const { session, publish } = makeSession();
    requestToolMock.mockResolvedValue({ status: 'success', output: { cells: [['4111111111111111']] } });
    applyDlpMock.mockResolvedValue({
      action: 'block',
      blockReason: 'dlp_blocked:creditCard',
      redactions: [{ rule: 'creditCard', count: 1, location: 'cell[0][0]' }],
    });

    const handler = makeClientToolHandler('excel', 'read_range', () => session);
    const result = await handler({ address: 'A1' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('dlp_blocked:creditCard');
    expect(JSON.stringify(messagesValuesMock.mock.calls)).not.toContain('4111111111111111');
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tool_completed', status: 'error', blockReason: 'dlp_blocked:creditCard' }),
    );
  });
});

describe('makeClientToolHandler — rejection and timeout results', () => {
  it('user rejection → rejected execution + tool_reject audit + isError result', async () => {
    const { session, publish } = makeSession();
    requestToolMock.mockResolvedValue({ status: 'rejected', output: null });
    const handler = makeClientToolHandler('excel', 'write_range', () => session);

    const result = await handler({ address: 'A1', cells: [[1]] });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('rejected');
    expect(executionsValuesMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ai.client_session.tool_reject',
        details: expect.objectContaining({ reason: 'user_rejected' }),
      }),
    );
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_completed', status: 'rejected' }));
  });

  it('timeout → failed execution + failure audit + timeout tool_completed', async () => {
    const { session, publish } = makeSession();
    requestToolMock.mockResolvedValue({
      status: 'timeout',
      output: { error: "Tool 'read_range' timed out after 60s — the user may have closed the document or not responded to the approval prompt." },
    });
    const handler = makeClientToolHandler('excel', 'read_range', () => session);

    const result = await handler({ address: 'A1' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('timed out');
    expect(executionsValuesMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'ai.client_session.tool_execute', result: 'failure' }),
    );
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_completed', status: 'timeout' }));
  });
});
