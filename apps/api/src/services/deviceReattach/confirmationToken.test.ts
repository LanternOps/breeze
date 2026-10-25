import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../agentCredentialHashes';
import { confirmationHashMatches, parseConfirmationBearer } from './confirmationToken';

const hashConfirmationToken = sha256Hex;

const SECRET = 'a'.repeat(43);
const TOKEN = `brz_rbc_${SECRET}`;

describe('parseConfirmationBearer (#8318 §6.4)', () => {
  it('accepts a brz_rbc_ bearer with at least 128 bits of secret', () => {
    expect(parseConfirmationBearer(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(parseConfirmationBearer(`bearer ${TOKEN}`)).toBe(TOKEN);
    expect(parseConfirmationBearer(`  Bearer ${TOKEN}  `)).toBe(TOKEN);
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['another scheme', `Basic ${TOKEN}`],
    ['an agent token (wrong prefix)', `Bearer brz_${SECRET}`],
    ['a short secret', 'Bearer brz_rbc_tooshort'],
    ['an absurdly long token', `Bearer brz_rbc_${'a'.repeat(300)}`],
    ['two tokens', `Bearer ${TOKEN} ${TOKEN}`],
  ])('refuses %s', (_label, header) => {
    expect(parseConfirmationBearer(header)).toBeNull();
  });
});

describe('sha256Hex (the stored form) / confirmationHashMatches', () => {
  it('is the SHA-256 hex of the whole token, prefix included (what the agent sends at phase 1)', () => {
    expect(hashConfirmationToken(TOKEN)).toBe(createHash('sha256').update(TOKEN).digest('hex'));
  });

  it('matches only the exact stored digest', () => {
    const stored = hashConfirmationToken(TOKEN);
    expect(confirmationHashMatches(hashConfirmationToken(TOKEN), stored)).toBe(true);
    expect(confirmationHashMatches(hashConfirmationToken(`${TOKEN}x`), stored)).toBe(false);
  });

  it('is false (never throws) for a missing or malformed digest on either side', () => {
    const good = hashConfirmationToken(TOKEN);
    expect(confirmationHashMatches(good, null)).toBe(false);
    expect(confirmationHashMatches(good, undefined)).toBe(false);
    expect(confirmationHashMatches(good, 'nothex')).toBe(false);
    expect(confirmationHashMatches('nothex', good)).toBe(false);
    expect(confirmationHashMatches(good.toUpperCase(), good)).toBe(false);
    expect(confirmationHashMatches(good.slice(0, 62), good)).toBe(false);
  });
});
