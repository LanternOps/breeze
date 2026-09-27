import { describe, expect, it } from 'vitest';
import {
  destinationSetGainedMembers,
  urlOriginChanged,
  webhookOriginChangeWouldRetainAuthorization,
} from './credentialOriginBinding';

describe('destinationSetGainedMembers', () => {
  it('is false when the set is unchanged', () => {
    expect(destinationSetGainedMembers(['10.0.0.0/24'], ['10.0.0.0/24'])).toBe(false);
  });

  it('is false for pure narrowing (removal only)', () => {
    expect(destinationSetGainedMembers(['10.0.0.0/24', '10.0.1.0/24'], ['10.0.0.0/24'])).toBe(false);
  });

  it('is false when narrowing to empty', () => {
    expect(destinationSetGainedMembers(['10.0.0.0/24'], [])).toBe(false);
  });

  it('is true when a member is added alongside an unchanged member', () => {
    expect(destinationSetGainedMembers(['10.0.0.0/24'], ['10.0.0.0/24', '10.0.1.0/24'])).toBe(true);
  });

  it('is true for a net change even when some entries are dropped (added and removed)', () => {
    expect(destinationSetGainedMembers(['10.0.0.0/24', '10.0.1.0/24'], ['10.0.0.0/24', '10.0.5.0/24'])).toBe(true);
  });

  it('treats a CIDR prefix widening as a different string and so a gain, even though it is a superset', () => {
    // No CIDR-aware containment logic: '10.0.0.0/23' is not byte-identical to
    // '10.0.0.0/24', so it is treated as a new member. This is the
    // safe-by-construction direction (over-block, never under-block).
    expect(destinationSetGainedMembers(['10.0.0.0/24'], ['10.0.0.0/23'])).toBe(true);
  });

  it('treats a bare IP and its /32 form as different members (over-blocks, safe direction)', () => {
    expect(destinationSetGainedMembers(['10.0.0.5'], ['10.0.0.5/32'])).toBe(true);
  });

  it('is false for a shuffled but identical set', () => {
    expect(destinationSetGainedMembers(['10.0.0.0/24', '10.0.1.0/24'], ['10.0.1.0/24', '10.0.0.0/24'])).toBe(false);
  });

  it('trims whitespace before comparing', () => {
    expect(destinationSetGainedMembers(['10.0.0.0/24'], [' 10.0.0.0/24 '])).toBe(false);
    expect(destinationSetGainedMembers([' 10.0.0.0/24 '], ['10.0.0.0/24'])).toBe(false);
  });

  it('ignores duplicate entries in next that are already present', () => {
    expect(destinationSetGainedMembers(['10.0.0.0/24'], ['10.0.0.0/24', '10.0.0.0/24'])).toBe(false);
  });

  it('ignores duplicate entries in existing', () => {
    expect(destinationSetGainedMembers(['10.0.0.0/24', '10.0.0.0/24'], ['10.0.0.0/24'])).toBe(false);
  });

  it('handles IPv6 addresses and CIDRs the same way as IPv4', () => {
    expect(destinationSetGainedMembers(['2001:db8::/64'], ['2001:db8::/64'])).toBe(false);
    expect(destinationSetGainedMembers(['2001:db8::/64'], ['2001:db8::/32'])).toBe(true);
    expect(destinationSetGainedMembers(['2001:db8::/64', '2001:db8:1::/64'], ['2001:db8::/64'])).toBe(false);
  });

  it('is case-sensitive for hostnames (over-blocks on case difference, safe direction)', () => {
    expect(destinationSetGainedMembers(['Printer.Local'], ['printer.local'])).toBe(true);
  });

  it('is false for an empty existing and empty next set', () => {
    expect(destinationSetGainedMembers([], [])).toBe(false);
  });

  it('is true for any member when existing is empty', () => {
    expect(destinationSetGainedMembers([], ['10.0.0.0/24'])).toBe(true);
  });
});

describe('urlOriginChanged', () => {
  it.each([
    ['https://EXAMPLE.com/path', 'https://example.com/other', false],
    ['https://example.com:443/path', 'https://example.com/other', false],
    ['http://example.com/path', 'https://example.com/path', true],
    ['https://example.com/path', 'https://example.com:8443/path', true],
    ['https://example.com/path', 'https://other.example/path', true],
    ['not-a-url', 'https://example.com/path', true],
  ])('%s -> %s changed=%s', (current, next, changed) => {
    expect(urlOriginChanged(current, next)).toBe(changed);
  });
});

describe('webhookOriginChangeWouldRetainAuthorization', () => {
  const isMasked = (value: unknown) => typeof value === 'string' && /^\*+$/.test(value);

  it('fails closed when a destination is first assigned to stored authorization', () => {
    expect(webhookOriginChangeWouldRetainAuthorization(
      { authToken: 'stored-token' },
      { url: 'https://receiver.example/hook' },
      isMasked,
    )).toBe(true);
  });

  it('allows a first destination when stored authorization is explicitly cleared', () => {
    expect(webhookOriginChangeWouldRetainAuthorization(
      { authToken: 'stored-token', headers: { Authorization: 'stored-header' } },
      { url: 'https://receiver.example/hook', authToken: null, headers: {} },
      isMasked,
    )).toBe(false);
  });

  // #4983: the edit form sends the masked URL back when the operator did not
  // touch it. The merge keeps the stored URL, so the origin has not changed and
  // the stored (masked) authorization and headers may stay.
  it('treats a masked url as the stored destination, not an origin change', () => {
    expect(webhookOriginChangeWouldRetainAuthorization(
      { url: 'https://receiver.example/hook', authPassword: 'stored-pass', headers: { 'X-Api-Key': 'stored-key' } },
      { url: '********', authPassword: '********', headers: { 'X-Api-Key': '********' } },
      isMasked,
    )).toBe(false);
  });

  it('still fails closed on a masked url when no destination is stored', () => {
    expect(webhookOriginChangeWouldRetainAuthorization(
      { authToken: 'stored-token' },
      { url: '********', authToken: '********' },
      isMasked,
    )).toBe(true);
  });
});
