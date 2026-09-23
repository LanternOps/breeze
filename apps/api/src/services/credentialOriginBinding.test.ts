import { describe, expect, it } from 'vitest';
import {
  urlOriginChanged,
  webhookOriginChangeWouldRetainAuthorization,
} from './credentialOriginBinding';

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
