import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { encryptedColumnRegistry } from '../encryptedColumnRegistry';
import { LINK_TOKEN_RE, hashLinkToken, linkUrl, newLinkChallenge, openLinkToken, sealLinkToken, storedChoices } from './linkChallenge';

const id = '11111111-1111-4111-8111-111111111111';
const other = '33333333-3333-4333-8333-333333333333';

afterEach(() => vi.unstubAllEnvs());

describe('link challenge material', () => {
  it('builds only an HTTPS application link from trusted deployment config', () => {
    const token = 'A'.repeat(43);
    vi.stubEnv('PUBLIC_WEB_URL', 'https://app.example.com');
    expect(linkUrl(token)).toBe(`https://app.example.com/verify/${token}`);
    vi.stubEnv('PUBLIC_WEB_URL', 'https://app.example.com/');
    expect(linkUrl(token)).toBe(`https://app.example.com/verify/${token}`);
    for (const value of ['', 'http://app.example.com', 'https://user:pass@app.example.com', 'https://app.example.com/?next=x', 'https://app.example.com/#x', 'https://app.example.com/sub', 'not a url']) {
      vi.stubEnv('PUBLIC_WEB_URL', value);
      expect(() => linkUrl(token), value).toThrow('app_url_invalid');
    }
    vi.stubEnv('PUBLIC_WEB_URL', 'https://app.example.com');
    expect(() => linkUrl('../../x')).toThrow('link_token_invalid');
  });

  it('stores only a digest and an encrypted, row-bound recoverable delivery token', () => {
    const material = newLinkChallenge(id);
    const token = openLinkToken(id, material.sealedToken);
    expect(token).toMatch(LINK_TOKEN_RE);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(material.challengeTokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(material.sealedToken).not.toContain(token);
    expect(newLinkChallenge(id).challengeTokenHash).not.toBe(material.challengeTokenHash);
    // A sealed token pasted onto another verification never opens.
    expect(() => openLinkToken(other, material.sealedToken)).toThrow();
  });

  it('refuses plaintext or malformed sealed material', () => {
    expect(() => openLinkToken(id, JSON.stringify({ verificationId: id, token: 'A'.repeat(43) }))).toThrow('link_token_invalid');
    expect(() => sealLinkToken(id, 'short')).toThrow('link_token_invalid');
  });

  it('registers the sealed column for key rotation with row-bound AAD', () => {
    const spec = encryptedColumnRegistry.find((c) => c.table === 'caller_verifications' && c.column === 'sealed_link_token');
    expect(spec).toMatchObject({ kind: 'text', aadBinding: 'row' });
  });

  it('hashes exactly like the W01 start producer', () => {
    expect(hashLinkToken('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
  });

  it('stored choice order is stable, complete, and independent of which candidate is the match', () => {
    const first = storedChoices(id, '42', ['17', '83']);
    expect(new Set(first)).toEqual(new Set(['42', '17', '83']));
    expect(storedChoices(id, '17', ['83', '42'])).toEqual(first);
    expect(storedChoices(id, '83', ['42', '17'])).toEqual(first);
    expect(() => storedChoices(id, '42', ['42', '83'])).toThrow('challenge_choices_invalid');
    expect(() => storedChoices(id, '4', ['42', '83'])).toThrow('challenge_choices_invalid');
    expect(() => storedChoices(id, '42', ['17'])).toThrow('challenge_choices_invalid');
  });

  it('does not put the match first by convention', () => {
    // Over many verification ids the match lands in every position.
    const positions = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const vid = `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`;
      positions.add(storedChoices(vid, '42', ['17', '83']).indexOf('42'));
    }
    expect(positions).toEqual(new Set([0, 1, 2]));
  });
});
