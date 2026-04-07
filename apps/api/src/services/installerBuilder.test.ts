import { describe, it, expect } from 'vitest';
import { replaceMsiPlaceholders, PLACEHOLDERS } from './installerBuilder';

describe('replaceMsiPlaceholders', () => {
  it('replaces all three placeholders in a buffer', () => {
    const serverSentinel = Buffer.from(PLACEHOLDERS.SERVER_URL, 'utf16le');
    const keySentinel = Buffer.from(PLACEHOLDERS.ENROLLMENT_KEY, 'utf16le');
    const secretSentinel = Buffer.from(PLACEHOLDERS.ENROLLMENT_SECRET, 'utf16le');

    const template = Buffer.concat([
      Buffer.from('header-bytes'),
      serverSentinel,
      Buffer.from('middle-bytes'),
      keySentinel,
      Buffer.from('more-bytes'),
      secretSentinel,
      Buffer.from('footer-bytes'),
    ]);

    const result = replaceMsiPlaceholders(template, {
      serverUrl: 'https://breeze.example.com',
      enrollmentKey: 'abc123',
      enrollmentSecret: 'secret456',
    });

    expect(result.length).toBe(template.length);
    expect(result.includes(Buffer.from('@@BREEZE_SERVER_URL@@', 'utf16le'))).toBe(false);
    expect(result.includes(Buffer.from('@@BREEZE_ENROLLMENT_KEY@@', 'utf16le'))).toBe(false);
    expect(result.includes(Buffer.from('@@BREEZE_ENROLLMENT_SECRET@@', 'utf16le'))).toBe(false);
    expect(result.includes(Buffer.from('https://breeze.example.com', 'utf16le'))).toBe(true);
    expect(result.includes(Buffer.from('abc123', 'utf16le'))).toBe(true);
    expect(result.includes(Buffer.from('secret456', 'utf16le'))).toBe(true);
  });

  it('leaves ENROLLMENT_SECRET as nulls when empty', () => {
    const secretSentinel = Buffer.from(PLACEHOLDERS.ENROLLMENT_SECRET, 'utf16le');
    const keySentinel = Buffer.from(PLACEHOLDERS.ENROLLMENT_KEY, 'utf16le');
    const serverSentinel = Buffer.from(PLACEHOLDERS.SERVER_URL, 'utf16le');
    const template = Buffer.concat([serverSentinel, keySentinel, secretSentinel]);

    const result = replaceMsiPlaceholders(template, {
      serverUrl: 'https://x.com',
      enrollmentKey: 'key1',
      enrollmentSecret: '',
    });

    expect(result.length).toBe(template.length);
    expect(result.includes(Buffer.from('@@BREEZE_ENROLLMENT_SECRET@@', 'utf16le'))).toBe(false);
  });

  it('throws if a placeholder is not found in the buffer', () => {
    const emptyBuffer = Buffer.from('no placeholders here');
    expect(() =>
      replaceMsiPlaceholders(emptyBuffer, {
        serverUrl: 'https://x.com',
        enrollmentKey: 'k',
        enrollmentSecret: '',
      })
    ).toThrow(/SERVER_URL placeholder not found/);
  });

  it('throws if value exceeds placeholder capacity', () => {
    const serverSentinel = Buffer.from(PLACEHOLDERS.SERVER_URL, 'utf16le');
    const keySentinel = Buffer.from(PLACEHOLDERS.ENROLLMENT_KEY, 'utf16le');
    const secretSentinel = Buffer.from(PLACEHOLDERS.ENROLLMENT_SECRET, 'utf16le');
    const template = Buffer.concat([serverSentinel, keySentinel, secretSentinel]);

    expect(() =>
      replaceMsiPlaceholders(template, {
        serverUrl: 'x'.repeat(600),
        enrollmentKey: 'k',
        enrollmentSecret: '',
      })
    ).toThrow(/SERVER_URL value too long/);
  });
});
