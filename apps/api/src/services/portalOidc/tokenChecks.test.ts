import { describe, expect, it } from 'vitest';

import { addressClaim, errorDiagnostics, nonceMatches } from './tokenChecks';

describe('nonceMatches (shared by the Entra and Google clients)', () => {
  it('matches only an identical non-empty string', () => {
    expect(nonceMatches('nonce-value', 'nonce-value')).toBe(true);
    expect(nonceMatches('nonce-value', 'nonce-valuE')).toBe(false);
    expect(nonceMatches('nonce-value', 'nonce-value-longer')).toBe(false);
    expect(nonceMatches('n', 'a-much-longer-expected-nonce')).toBe(false);
  });

  it('fails closed on an empty or non-string value on either side', () => {
    expect(nonceMatches('', '')).toBe(false);
    expect(nonceMatches('', 'expected')).toBe(false);
    expect(nonceMatches('actual', '')).toBe(false);
    for (const actual of [undefined, null, 42, ['expected'], { nonce: 'expected' }]) {
      expect(nonceMatches(actual, 'expected')).toBe(false);
    }
  });
});

describe('addressClaim', () => {
  it('lowercases a string containing @ and refuses anything else', () => {
    expect(addressClaim('Pat@Contoso.Example.com')).toBe('pat@contoso.example.com');
    expect(addressClaim('pat')).toBeNull();
    expect(addressClaim('')).toBeNull();
    expect(addressClaim(undefined)).toBeNull();
    expect(addressClaim(['pat@contoso.example.com'])).toBeNull();
  });
});

describe('errorDiagnostics', () => {
  it('keeps the error name and a string code, never the message', () => {
    const diag = errorDiagnostics(Object.assign(new TypeError('secret-message'), { code: 'ECONNRESET' }));
    expect(diag).toEqual({ errorName: 'TypeError', errorCode: 'ECONNRESET' });
    expect(JSON.stringify(diag)).not.toContain('secret-message');
    expect(errorDiagnostics(Object.assign(new Error('m'), { code: 7 }))).toEqual({ errorName: 'Error' });
    expect(errorDiagnostics('a thrown string')).toEqual({ errorName: 'string' });
    expect(errorDiagnostics(null)).toEqual({ errorName: 'object' });
  });
});
