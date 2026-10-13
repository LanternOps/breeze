import { describe, it, expect } from 'vitest';
import { errorMessageFromBody } from './errorMessage';

describe('errorMessageFromBody', () => {
  it('returns the server error string', () => {
    expect(errorMessageFromBody('{"error":"nope"}', 'fb')).toBe('nope');
  });
  it('falls back when error is empty', () => {
    expect(errorMessageFromBody('{"error":""}', 'fb')).toBe('fb');
  });
  it('falls back when error is not a string', () => {
    expect(errorMessageFromBody('{"error":{"code":1}}', 'fb')).toBe('fb');
  });
  it('falls back when error key is missing', () => {
    expect(errorMessageFromBody('{"ok":false}', 'fb')).toBe('fb');
  });
  it('falls back on invalid JSON', () => {
    expect(errorMessageFromBody('<html>502</html>', 'fb')).toBe('fb');
  });
  it('falls back on empty body', () => {
    expect(errorMessageFromBody('', 'fb')).toBe('fb');
  });
  it('falls back on JSON null', () => {
    expect(errorMessageFromBody('null', 'fb')).toBe('fb');
  });
});
