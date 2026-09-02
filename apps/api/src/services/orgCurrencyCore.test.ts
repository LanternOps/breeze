import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable Drizzle chain mock (same pattern as invoiceService.test.ts /
// contractService.test.ts): every builder method returns the same chain and an
// awaited chain yields the next queued result.
const results: unknown[][] = [];
const log: string[] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'for', 'update', 'set', 'insert', 'values', 'returning', 'groupBy'];
    for (const m of methods) chain[m] = vi.fn((...args: unknown[]) => { log.push(`${m}(${args.join(',')})`); return chain; });
    chain.transaction = vi.fn(async (run: (tx: unknown) => unknown) => { log.push('transaction'); return run(chain); });
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(results.shift() ?? []).then(resolve);
    return chain;
  };
  return { db: makeChain() };
});

import { db } from '../db';
import { OrgCurrencyServiceError, readOrgStampingDefaults, requireOrgAccessById } from './orgCurrencyCore';

describe('orgCurrencyCore.requireOrgAccessById (#3778)', () => {
  it('allows a system actor (accessibleOrgIds === null)', () => {
    expect(() => requireOrgAccessById({ accessibleOrgIds: null }, 'org1')).not.toThrow();
  });

  it('allows an actor whose allowlist contains the org', () => {
    expect(() => requireOrgAccessById({ accessibleOrgIds: ['org1', 'org2'] }, 'org1')).not.toThrow();
  });

  it('throws a NEUTRAL ORG_DENIED (403) for a cross-org actor — never an invoice error', () => {
    try {
      requireOrgAccessById({ accessibleOrgIds: ['other'] }, 'org1');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OrgCurrencyServiceError);
      expect(err).toMatchObject({ code: 'ORG_DENIED', status: 403, name: 'OrgCurrencyServiceError' });
    }
  });
});

describe('orgCurrencyCore.readOrgStampingDefaults (#3778)', () => {
  beforeEach(() => { results.length = 0; log.length = 0; vi.clearAllMocks(); });

  it('reads the org currency under a SHARE lock', async () => {
    queueResult([{ currencyCode: 'EUR' }]);
    const out = await readOrgStampingDefaults(db as never, 'org1');
    expect(out).toEqual({ currencyCode: 'EUR' });
    // The SHARE lock is the whole point of the helper — assert the mode, not
    // merely that `.for()` was called.
    expect(log).toContain('for(share)');
    expect(log).not.toContain('for(update)');
  });

  it('throws ORG_NOT_FOUND (404) when the org row is absent', async () => {
    queueResult([]);
    await expect(readOrgStampingDefaults(db as never, 'missing'))
      .rejects.toMatchObject({ code: 'ORG_NOT_FOUND', status: 404, name: 'OrgCurrencyServiceError' });
  });
});
