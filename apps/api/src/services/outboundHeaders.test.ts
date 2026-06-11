import { describe, expect, it } from 'vitest';
import {
  getOutboundHeaderValidationErrors,
  sanitizeOutboundHeaders,
  validateOutboundHeader
} from './outboundHeaders';

describe('outbound header validation', () => {
  it('accepts RFC token header names and normal values', () => {
    expect(validateOutboundHeader('X-Customer-Token', 'abc123')).toBeNull();
    expect(validateOutboundHeader("X-Trace_`|~", 'value')).toBeNull();
  });

  it('rejects invalid, control-character, and reserved names', () => {
    expect(validateOutboundHeader('Bad Header', 'value')).toMatch(/RFC token/);
    expect(validateOutboundHeader('X-Test', 'line\r\nbreak')).toMatch(/control characters/);
    expect(validateOutboundHeader('Host', '169.254.169.254')).toMatch(/reserved/);
    expect(validateOutboundHeader('Transfer-Encoding', 'chunked')).toMatch(/reserved/);
    expect(validateOutboundHeader('X-Breeze-Event-Type', 'forged')).toMatch(/reserved/);
  });

  it('detects duplicate header names case-insensitively', () => {
    expect(getOutboundHeaderValidationErrors([
      { key: 'X-Test', value: 'one' },
      { key: 'x-test', value: 'two' },
    ])).toContain('Header "x-test" is duplicated');
  });

  it('drops unsafe headers at runtime while preserving allowed headers', () => {
    expect(sanitizeOutboundHeaders({
      Authorization: 'Bearer token',
      Host: 'metadata.google.internal',
      'X-Breeze-Timestamp': 'forged',
      'X-Partner': 'ok',
    })).toEqual({
      Authorization: 'Bearer token',
      'X-Partner': 'ok',
    });
  });
});
