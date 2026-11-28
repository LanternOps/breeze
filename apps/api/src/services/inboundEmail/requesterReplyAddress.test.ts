import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    rows: [] as unknown[],
    calls: [] as { where: unknown; orderBy: unknown[]; limit: number }[],
  },
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const call = { where: undefined as unknown, orderBy: [] as unknown[], limit: 0 };
      const chain = {
        from() { return chain; },
        where(w: unknown) { call.where = w; return chain; },
        orderBy(...o: unknown[]) { call.orderBy = o; return chain; },
        limit(n: number) { call.limit = n; state.calls.push(call); return Promise.resolve(state.rows); },
      };
      return chain;
    }),
  },
}));

import { requesterReplyAddress } from './requesterReplyAddress';

const ticket = { id: 't-1', partnerId: 'p-1', submitterEmail: 'no-reply@forms.example' };

// Flatten a drizzle condition to its plain-string chunks (column names are real
// drizzle columns here, so the bound literals are what we can see).
function literals(cond: unknown): unknown[] {
  // A value interpolated into sql`` is a bare chunk.
  if (typeof cond === 'string') return [cond];
  const chunks = (cond as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) {
    const v = (cond as { value?: unknown })?.value;
    return v !== undefined && !Array.isArray(v) ? [v] : [];
  }
  return chunks.flatMap(literals);
}

beforeEach(() => {
  state.rows = [];
  state.calls = [];
});

describe('requesterReplyAddress (email-first replies W1)', () => {
  it('web-form ticket replies to the stored Reply-To', async () => {
    state.rows = [{ replyToAddress: 'jane@customer.example' }];
    await expect(requesterReplyAddress(ticket)).resolves.toBe('jane@customer.example');
  });

  it('no Reply-To falls back to submitterEmail', async () => {
    state.rows = [{ replyToAddress: null }];
    await expect(requesterReplyAddress(ticket)).resolves.toBe('no-reply@forms.example');
    state.rows = [];
    await expect(requesterReplyAddress(ticket)).resolves.toBe('no-reply@forms.example');
  });

  it('a follow-up\'s Reply-To does not change the address: reads only the creating row', async () => {
    state.rows = [{ replyToAddress: 'jane@customer.example' }];
    await requesterReplyAddress(ticket);
    const call = state.calls[0]!;
    // The creating row: this ticket, this partner, parse_status 'created', sent
    // by the requester, the earliest one.
    const bound = literals(call.where);
    expect(bound).toEqual(expect.arrayContaining(['t-1', 'p-1', 'created', 'no-reply@forms.example']));
    expect(call.orderBy).toHaveLength(2);
    expect(call.limit).toBe(1);
  });

  it('re-checks the stored value and falls back when it is not a single valid address', async () => {
    state.rows = [{ replyToAddress: 'a@customer.example, b@customer.example' }];
    await expect(requesterReplyAddress(ticket)).resolves.toBe('no-reply@forms.example');
  });

  it('no submitterEmail: no address, no query', async () => {
    await expect(requesterReplyAddress({ ...ticket, submitterEmail: null })).resolves.toBeNull();
    expect(state.calls).toHaveLength(0);
  });

  it('no partner: submitterEmail, no query', async () => {
    await expect(requesterReplyAddress({ ...ticket, partnerId: null })).resolves.toBe('no-reply@forms.example');
    expect(state.calls).toHaveLength(0);
  });
});
