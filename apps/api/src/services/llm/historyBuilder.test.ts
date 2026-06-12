import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildMessagesFromHistory, ToolUseInHistoryError } from './historyBuilder';

// ============================================
// Mocks
// ============================================

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();

vi.mock('../../db', () => ({
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

vi.mock('../../db/schema', () => ({
  aiMessages: {
    role: 'role',
    content: 'content',
    sessionId: 'session_id',
    createdAt: 'created_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ _eq: args })),
  asc: vi.fn((col: unknown) => ({ _asc: col })),
}));

// ============================================
// Helpers
// ============================================

type DbRow = { role: string; content: string | null };

function setupDbReturning(rows: DbRow[]) {
  mockOrderBy.mockResolvedValue(rows);
  mockWhere.mockReturnValue({ orderBy: mockOrderBy });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockSelect.mockReturnValue({ from: mockFrom });
}

// ============================================
// Tests
// ============================================

describe('buildMessagesFromHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array for empty history', async () => {
    setupDbReturning([]);
    const result = await buildMessagesFromHistory('session-1', 'org-1');
    expect(result).toEqual([]);
  });

  it('maps user and assistant messages to ChatMessage', async () => {
    setupDbReturning([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'How are you?' },
      { role: 'assistant', content: 'I am fine' },
    ]);
    const result = await buildMessagesFromHistory('session-1', 'org-1');
    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'How are you?' },
      { role: 'assistant', content: 'I am fine' },
    ]);
  });

  it('skips system messages silently', async () => {
    setupDbReturning([
      { role: 'system', content: 'You are a helpful assistant' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);
    const result = await buildMessagesFromHistory('session-1', 'org-1');
    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);
  });

  it('skips assistant rows with null content (pure tool-use turns)', async () => {
    setupDbReturning([
      { role: 'user', content: 'Do something' },
      { role: 'assistant', content: null },
    ]);
    const result = await buildMessagesFromHistory('session-1', 'org-1');
    expect(result).toEqual([
      { role: 'user', content: 'Do something' },
    ]);
  });

  it('skips user rows with null content', async () => {
    setupDbReturning([
      { role: 'user', content: null },
      { role: 'assistant', content: 'Hello' },
    ]);
    const result = await buildMessagesFromHistory('session-1', 'org-1');
    expect(result).toEqual([
      { role: 'assistant', content: 'Hello' },
    ]);
  });

  it('throws ToolUseInHistoryError when tool_use row is present', async () => {
    setupDbReturning([
      { role: 'user', content: 'List my devices' },
      { role: 'assistant', content: null },
      { role: 'tool_use', content: null },
    ]);
    await expect(buildMessagesFromHistory('session-1', 'org-1')).rejects.toThrow(
      ToolUseInHistoryError,
    );
  });

  it('throws ToolUseInHistoryError when tool_result row is present', async () => {
    setupDbReturning([
      { role: 'user', content: 'List my devices' },
      { role: 'tool_result', content: null },
    ]);
    await expect(buildMessagesFromHistory('session-1', 'org-1')).rejects.toThrow(
      ToolUseInHistoryError,
    );
  });

  it('ToolUseInHistoryError message includes the sessionId', async () => {
    setupDbReturning([{ role: 'tool_use', content: null }]);
    await expect(buildMessagesFromHistory('my-session-id', 'org-1')).rejects.toThrow(
      /my-session-id/,
    );
  });

  it('preserves message order from DB result', async () => {
    setupDbReturning([
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Second' },
      { role: 'user', content: 'Third' },
    ]);
    const result = await buildMessagesFromHistory('session-1', 'org-1');
    expect(result.map((m) => m.content)).toEqual(['First', 'Second', 'Third']);
  });
});
