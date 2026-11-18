import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool Catalog W06 (#5221) Task B3 — `findOwnedScriptIds` reads in a fresh
 * SYSTEM context by default (every validator and enable caller), and through
 * a caller-supplied executor only when one is passed (the conversion switch,
 * whose generated scripts exist only in its own uncommitted transaction).
 */
const h = vi.hoisted(() => ({
  log: [] as string[],
  systemRows: [] as Array<{ id: string }>,
}));

vi.mock('../../db', () => {
  const chain = (rows: () => unknown[]): unknown => {
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') return (res: (v: unknown) => void) => Promise.resolve(rows()).then(res);
        return () => proxy;
      },
    });
    return proxy;
  };
  return {
    db: { select: () => { h.log.push('db.select'); return chain(() => h.systemRows); } },
    runOutsideDbContext: (fn: () => unknown) => { h.log.push('runOutsideDbContext'); return fn(); },
    withSystemDbAccessContext: (fn: () => unknown, label?: string) => { h.log.push(`system:${label}`); return fn(); },
  };
});

import { findOwnedScriptIds } from './ownedReferences';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const A = '33333333-3333-4333-8333-333333333333';
const B = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  h.log.length = 0;
  h.systemRows = [];
});

describe('findOwnedScriptIds', () => {
  it('without an executor it reads through a fresh system context, as before', async () => {
    h.systemRows = [{ id: A }];
    const owned = await findOwnedScriptIds({ orgId: ORG, partnerId: PARTNER }, [A, B]);
    expect(owned).toEqual(new Set([A]));
    expect(h.log).toEqual(['runOutsideDbContext', 'system:flowValidator.scripts', 'db.select']);
  });

  it('with an executor it reads through that executor only and opens no system context', async () => {
    const executorRows = [{ id: B }];
    const executorSelect = vi.fn(() => {
      const proxy: unknown = new Proxy(() => {}, {
        get(_t, prop) {
          if (prop === 'then') return (res: (v: unknown) => void) => Promise.resolve(executorRows).then(res);
          return () => proxy;
        },
      });
      return proxy;
    });
    const owned = await findOwnedScriptIds({ orgId: ORG, partnerId: PARTNER }, [A, B], { executor: { select: executorSelect } as never });
    expect(owned).toEqual(new Set([B]));
    expect(executorSelect).toHaveBeenCalledTimes(1);
    expect(h.log).toEqual([]);
  });

  it('no well-formed id reads nothing on either path', async () => {
    const executorSelect = vi.fn();
    expect(await findOwnedScriptIds({ orgId: ORG, partnerId: PARTNER }, ['nope'], { executor: { select: executorSelect } as never })).toEqual(new Set());
    expect(executorSelect).not.toHaveBeenCalled();
    expect(h.log).toEqual([]);
  });
});
