import { describe, it, expect } from 'vitest';
import { parseAuthClauses } from './authenticationResults';

describe('parseAuthClauses', () => {
  it('reads each clause with lowercased properties and drops the authserv-id', () => {
    const clauses = parseAuthClauses('mx.example; spf=pass smtp.mailfrom=B@X.com; dkim=pass header.d=X.com header.s="sel"');
    expect(clauses.map((c) => [c.method, c.result])).toEqual([['spf', 'pass'], ['dkim', 'pass']]);
    expect(clauses[0]!.props.get('smtp.mailfrom')).toBe('b@x.com');
    expect(clauses[1]!.props.get('header.d')).toBe('x.com');
    expect(clauses[1]!.props.get('header.s')).toBe('sel');
  });

  it('strips comments first, so a comment cannot add a clause or a property', () => {
    const clauses = parseAuthClauses('mx.example; dmarc=fail (because; dmarc=pass header.from=x.com) header.from=y.com');
    expect(clauses).toHaveLength(1);
    expect(clauses[0]!.result).toBe('fail');
    expect(clauses[0]!.props.get('header.from')).toBe('y.com');
  });

  it('keeps a property repeated with the same value, and nulls one repeated with a different value', () => {
    expect(parseAuthClauses('id; dmarc=pass header.from=x.com header.from=X.com')[0]!.props.get('header.from')).toBe('x.com');
    expect(parseAuthClauses('id; dmarc=pass header.from=x.com header.from=y.com')[0]!.props.get('header.from')).toBeNull();
  });

  it('returns nothing for an empty or verdict-less value', () => {
    expect(parseAuthClauses(undefined)).toEqual([]);
    expect(parseAuthClauses('mx.example; none')).toEqual([]);
  });
});
