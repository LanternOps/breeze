import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/quoteService', () => ({ deleteDraftQuote: vi.fn() }));
vi.mock('../../services/quoteLifecycle', () => ({ sendQuote: vi.fn() }));
vi.mock('../../services/quoteTypes', () => ({
  QuoteServiceError: class QuoteServiceError extends Error {
    constructor(msg: string, public status = 400, public code?: string) { super(msg); }
  },
}));
const gate = vi.hoisted(() => ({ permGate: async (_c: any, next: any) => next() }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: null });
    await next();
  },
  requireScope: () => async (c: any, next: any) => gate.permGate(c, next),
  requirePermission: () => async (c: any, next: any) => gate.permGate(c, next),
}));

import { quoteRoutes } from './index';
import { deleteDraftQuote } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { QuoteServiceError } from '../../services/quoteTypes';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

function post(path: string, body: unknown) {
  return quoteRoutes.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('quote bulk routes', () => {
  beforeEach(() => { vi.clearAllMocks(); gate.permGate = async (_c: any, next: any) => next(); });

  it('bulk-delete deletes each id and reports counts', async () => {
    (deleteDraftQuote as any).mockResolvedValue(undefined);
    const res = await post('/bulk-delete', { ids: [A, B] });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ total: 2, succeeded: 2, skipped: 0, failed: 0 });
    expect(deleteDraftQuote).toHaveBeenCalledTimes(2);
  });

  it('bulk-delete tallies non-draft skips without failing the request', async () => {
    (deleteDraftQuote as any)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new QuoteServiceError('Quote is not a draft', 409, 'NOT_A_DRAFT'));
    const res = await post('/bulk-delete', { ids: [A, B] });
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data).toMatchObject({ succeeded: 1, skipped: 1 });
    expect(data.skippedReasons).toEqual({ NOT_A_DRAFT: 1 });
  });

  it('bulk-send sends each draft', async () => {
    (sendQuote as any).mockResolvedValue({});
    const res = await post('/bulk-send', { ids: [A] });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ succeeded: 1 });
    expect(sendQuote).toHaveBeenCalledWith(A, expect.anything());
  });

  it('rejects an empty id list with 400', async () => {
    const res = await post('/bulk-delete', { ids: [] });
    expect(res.status).toBe(400);
  });
});
