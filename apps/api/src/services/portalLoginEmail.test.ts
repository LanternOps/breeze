import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  portalLoginEmailEquals,
  portalLoginEmailKey,
  portalLoginEmailMatchIsAmbiguous,
  soleCaseInsensitiveMatch,
} from './portalLoginEmail';

const compile = (s: ReturnType<typeof portalLoginEmailEquals>) => new PgDialect().sqlToQuery(s as never);

describe('portalLoginEmailEquals (#11529, #11541)', () => {
  it('compares lower(stored) against the trimmed, lower-cased address', () => {
    const q = compile(portalLoginEmailEquals('  Ada@X.Test '));
    expect(q.sql).toBe('lower("portal_users"."email") = $1');
    expect(q.params).toEqual(['ada@x.test']);
  });

  it('the key is the same transform', () => {
    expect(portalLoginEmailKey('  Ada@X.Test ')).toBe('ada@x.test');
  });
});

describe('portalLoginEmailMatchIsAmbiguous', () => {
  it('is false for no rows, one row, or one row per org', () => {
    expect(portalLoginEmailMatchIsAmbiguous([])).toBe(false);
    expect(portalLoginEmailMatchIsAmbiguous([{ orgId: 'a' }])).toBe(false);
    expect(portalLoginEmailMatchIsAmbiguous([{ orgId: 'a' }, { orgId: 'b' }])).toBe(false);
  });

  it('is true when two rows share an org (case-only duplicates)', () => {
    expect(portalLoginEmailMatchIsAmbiguous([{ orgId: 'a' }, { orgId: 'b' }, { orgId: 'a' }])).toBe(true);
  });
});

describe('soleCaseInsensitiveMatch', () => {
  it('returns the row only when exactly one matched', () => {
    expect(soleCaseInsensitiveMatch([])).toBeNull();
    expect(soleCaseInsensitiveMatch([{ id: 1 }])).toEqual({ id: 1 });
    expect(soleCaseInsensitiveMatch([{ id: 1 }, { id: 2 }])).toBeNull();
  });
});
