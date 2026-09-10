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
});
