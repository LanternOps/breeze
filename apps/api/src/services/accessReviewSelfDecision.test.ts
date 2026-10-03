import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, runOutsideDbContextMock, withSystemDbAccessContextMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  runOutsideDbContextMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { execute: executeMock },
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

import {
  canSelfDecideAccessReviewItem,
  hasOtherEligibleAccessReviewDecider,
} from './accessReviewSelfDecision';

/** Flatten a drizzle `sql` template into its literal text + bound params. */
function renderSql(query: unknown): { text: string; params: unknown[] } {
  const chunks = (query as { queryChunks: unknown[] }).queryChunks;
  let text = '';
  const params: unknown[] = [];
  for (const chunk of chunks) {
    if (chunk && typeof chunk === 'object' && 'value' in chunk && Array.isArray((chunk as { value: unknown }).value)) {
      text += (chunk as { value: string[] }).value.join('');
    } else {
      text += '$';
      params.push(chunk);
    }
  }
  return { text, params };
}

describe('access review decider lookup', () => {
  beforeEach(() => {
    executeMock.mockReset();
    runOutsideDbContextMock.mockReset();
    withSystemDbAccessContextMock.mockReset();
  });

  it('asks the resolver on the request connection and never opens a nested system context', async () => {
    executeMock.mockResolvedValueOnce([{ has_other: true }]);

    await expect(
      hasOtherEligibleAccessReviewDecider({ scope: 'organization', orgId: 'org-1' }, 'user-1'),
    ).resolves.toBe(true);

    expect(runOutsideDbContextMock).not.toHaveBeenCalled();
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledTimes(1);
    const { text, params } = renderSql(executeMock.mock.calls[0]![0]);
    expect(text).toContain('public.breeze_access_review_has_other_decider(');
    expect(params).toEqual(['organization', 'org-1', 'user-1']);
  });

  it('passes the partner id for a partner-owned review', async () => {
    executeMock.mockResolvedValueOnce([{ has_other: false }]);

    await expect(
      hasOtherEligibleAccessReviewDecider({ scope: 'partner', partnerId: 'partner-1' }, 'user-1'),
    ).resolves.toBe(false);

    expect(renderSql(executeMock.mock.calls[0]![0]).params).toEqual(['partner', 'partner-1', 'user-1']);
  });

  it.each([
    ['another decider exists', [{ has_other: true }], false],
    ['nobody else can decide', [{ has_other: false }], true],
    ['the resolver returns null', [{ has_other: null }], false],
    ['the resolver returns no row', [], false],
  ] as const)('self-decision when %s → %s', async (_label, rows, allowed) => {
    executeMock.mockResolvedValueOnce(rows);
    await expect(
      canSelfDecideAccessReviewItem({ scope: 'organization', orgId: 'org-1' }, 'user-1'),
    ).resolves.toBe(allowed);
  });

  it('propagates a resolver error instead of allowing the self-decision', async () => {
    executeMock.mockRejectedValueOnce(new Error('function does not exist'));
    await expect(
      canSelfDecideAccessReviewItem({ scope: 'organization', orgId: 'org-1' }, 'user-1'),
    ).rejects.toThrow('function does not exist');
  });
});
