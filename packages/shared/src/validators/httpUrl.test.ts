import { describe, it, expect } from 'vitest';
import {
  isHttpUrl,
  httpUrlValue,
  httpUrlField,
  nullableHttpUrlField,
  httpUrlErrorMessage,
  HTTP_URL_MAX_LENGTH,
} from './httpUrl';

// The payloads #3430 was filed for. Kept as a named list so every schema
// helper below is exercised against the same corpus.
const DANGEROUS = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'javascript:alert(document.cookie)',
  'data:text/html,<script>alert(1)</script>',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'about:blank',
  'blob:https://example.com/1234',
  'view-source:https://example.com',
  'chrome://settings',
  'jar:https://example.com!/',
  'filesystem:https://example.com/temporary/x',
  // Whitespace/control-char obfuscation that a naive `startsWith('javascript:')`
  // check would miss but `new URL()` still resolves to the javascript scheme.
  'java\nscript:alert(1)',
  'java\tscript:alert(1)',
  ' javascript:alert(1)',
];

const VALID = [
  'https://example.com',
  'http://example.com',
  'https://example.com/path?q=1#frag',
  'HTTPS://EXAMPLE.COM',
  'http://localhost:3000',
  'https://sub.domain.example.co.uk/a/b',
];

describe('isHttpUrl', () => {
  it.each(VALID)('accepts %s', (value) => {
    expect(isHttpUrl(value)).toBe(true);
  });

  it.each(DANGEROUS)('rejects %j', (value) => {
    expect(isHttpUrl(value)).toBe(false);
  });

  it('rejects relative and scheme-less values', () => {
    for (const v of ['example.com', '//example.com', '/path', '', '   ']) {
      expect(isHttpUrl(v)).toBe(false);
    }
  });
});

describe('httpUrlValue', () => {
  const schema = httpUrlValue('Website');

  it.each(VALID)('parses %s', (value) => {
    expect(schema.parse(value)).toBe(value);
  });

  it.each(DANGEROUS)('rejects %j with the labelled message', (value) => {
    const result = schema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(httpUrlErrorMessage('Website'));
    }
  });

  it('accepts empty string so the field can be cleared', () => {
    expect(schema.parse('')).toBe('');
  });

  it('rejects rather than silently stripping a bad value', () => {
    // Regression guard for #3430: a transform that dropped the value would make
    // a rejected save look like a successful one that lost the field.
    const result = schema.safeParse('javascript:alert(1)');
    expect(result.success).toBe(false);
  });

  it('enforces the default max length', () => {
    const long = `https://example.com/${'a'.repeat(HTTP_URL_MAX_LENGTH)}`;
    expect(schema.safeParse(long).success).toBe(false);
  });

  it('honours a caller-supplied max length', () => {
    const narrow = httpUrlValue('Website', 30);
    expect(narrow.safeParse('https://example.com').success).toBe(true);
    expect(narrow.safeParse(`https://example.com/${'a'.repeat(40)}`).success).toBe(false);
  });
});

describe('httpUrlField', () => {
  const schema = httpUrlField('Website');

  it('accepts undefined and empty string', () => {
    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.parse('')).toBe('');
  });

  it('still rejects dangerous schemes', () => {
    for (const value of DANGEROUS) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });
});

describe('nullableHttpUrlField', () => {
  const schema = nullableHttpUrlField('Billing website', 255);

  it('accepts null, undefined and empty string', () => {
    expect(schema.parse(null)).toBeNull();
    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.parse('')).toBe('');
  });

  it('accepts a valid https URL', () => {
    expect(schema.parse('https://example.com')).toBe('https://example.com');
  });

  it('still rejects dangerous schemes', () => {
    for (const value of DANGEROUS) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it('applies the narrowed max length', () => {
    expect(schema.safeParse(`https://example.com/${'a'.repeat(300)}`).success).toBe(false);
  });
});
