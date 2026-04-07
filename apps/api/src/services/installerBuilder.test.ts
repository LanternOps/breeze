import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { replaceMsiPlaceholders, PLACEHOLDERS, buildMacosInstallerZip } from './installerBuilder';

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

  it('throws if template is suspiciously small', () => {
    const tinyBuffer = Buffer.from('no placeholders here');
    expect(() =>
      replaceMsiPlaceholders(tinyBuffer, {
        serverUrl: 'https://x.com',
        enrollmentKey: 'k',
        enrollmentSecret: '',
      })
    ).toThrow(/suspiciously small/);
  });

  it('throws if a placeholder is not found in the buffer', () => {
    const largeBuffer = Buffer.alloc(2048, 0xaa);
    expect(() =>
      replaceMsiPlaceholders(largeBuffer, {
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

describe('buildMacosInstallerZip', () => {
  it('produces a zip with pkg, enrollment.json, and install.sh', async () => {
    const fakePkg = Buffer.from('fake-pkg-contents');

    const zipBuffer = await buildMacosInstallerZip(fakePkg, {
      serverUrl: 'https://breeze.example.com',
      enrollmentKey: 'abc123',
      enrollmentSecret: 'secret456',
      siteId: '550e8400-e29b-41d4-a716-446655440000',
    });

    const zip = await JSZip.loadAsync(zipBuffer);
    const entries = Object.keys(zip.files);

    expect(entries).toContain('breeze-agent.pkg');
    expect(entries).toContain('enrollment.json');
    expect(entries).toContain('install.sh');

    const jsonStr = await zip.files['enrollment.json']!.async('string');
    const config = JSON.parse(jsonStr);
    expect(config.serverUrl).toBe('https://breeze.example.com');
    expect(config.enrollmentKey).toBe('abc123');
    expect(config.enrollmentSecret).toBe('secret456');
    expect(config.siteId).toBe('550e8400-e29b-41d4-a716-446655440000');

    const pkgData = await zip.files['breeze-agent.pkg']!.async('nodebuffer');
    expect(pkgData.equals(fakePkg)).toBe(true);
  });

  it('sets enrollmentSecret to empty string when not provided', async () => {
    const zipBuffer = await buildMacosInstallerZip(Buffer.from('pkg'), {
      serverUrl: 'https://x.com',
      enrollmentKey: 'key1',
      enrollmentSecret: '',
      siteId: '550e8400-e29b-41d4-a716-446655440000',
    });

    const zip = await JSZip.loadAsync(zipBuffer);
    const config = JSON.parse(await zip.files['enrollment.json']!.async('string'));
    expect(config.enrollmentSecret).toBe('');
  });
});

describe('replaceMsiPlaceholders — boundary & immutability', () => {
  it('accepts a value of exactly 512 characters', () => {
    const template = Buffer.concat([
      Buffer.alloc(2048, 0xaa),
      Buffer.from(PLACEHOLDERS.SERVER_URL, 'utf16le'),
      Buffer.from(PLACEHOLDERS.ENROLLMENT_KEY, 'utf16le'),
      Buffer.from(PLACEHOLDERS.ENROLLMENT_SECRET, 'utf16le'),
    ]);

    expect(() =>
      replaceMsiPlaceholders(template, {
        serverUrl: 'x'.repeat(512),
        enrollmentKey: 'k',
        enrollmentSecret: '',
      })
    ).not.toThrow();
  });

  it('rejects a value of 513 characters', () => {
    const template = Buffer.concat([
      Buffer.alloc(2048, 0xaa),
      Buffer.from(PLACEHOLDERS.SERVER_URL, 'utf16le'),
      Buffer.from(PLACEHOLDERS.ENROLLMENT_KEY, 'utf16le'),
      Buffer.from(PLACEHOLDERS.ENROLLMENT_SECRET, 'utf16le'),
    ]);

    expect(() =>
      replaceMsiPlaceholders(template, {
        serverUrl: 'x'.repeat(513),
        enrollmentKey: 'k',
        enrollmentSecret: '',
      })
    ).toThrow(/SERVER_URL value too long/);
  });

  it('does not mutate the input template buffer', () => {
    const serverSentinel = Buffer.from(PLACEHOLDERS.SERVER_URL, 'utf16le');
    const keySentinel = Buffer.from(PLACEHOLDERS.ENROLLMENT_KEY, 'utf16le');
    const secretSentinel = Buffer.from(PLACEHOLDERS.ENROLLMENT_SECRET, 'utf16le');
    const template = Buffer.concat([Buffer.alloc(2048, 0xaa), serverSentinel, keySentinel, secretSentinel]);
    const originalCopy = Buffer.from(template);

    replaceMsiPlaceholders(template, {
      serverUrl: 'https://changed.com',
      enrollmentKey: 'newkey',
      enrollmentSecret: 'newsecret',
    });

    expect(template.equals(originalCopy)).toBe(true);
  });
});

describe('buildMacosInstallerZip — install.sh content', () => {
  it('install.sh contains shebang and enrollment command', async () => {
    const zipBuffer = await buildMacosInstallerZip(Buffer.from('pkg'), {
      serverUrl: 'https://x.com',
      enrollmentKey: 'key1',
      enrollmentSecret: '',
      siteId: '550e8400-e29b-41d4-a716-446655440000',
    });

    const zip = await JSZip.loadAsync(zipBuffer);
    const script = await zip.files['install.sh']!.async('string');
    expect(script).toContain('#!/bin/bash');
    expect(script).toContain('breeze-agent enroll');
    expect(script).toContain('enrollment.json');
  });
});

describe('installer endpoint integration', () => {
  it('MSI placeholder replacement produces valid output with realistic layout', () => {
    // Build a realistic template buffer with all 3 sentinels scattered throughout
    const sentinel1 = Buffer.from(PLACEHOLDERS.SERVER_URL, 'utf16le');
    const sentinel2 = Buffer.from(PLACEHOLDERS.ENROLLMENT_KEY, 'utf16le');
    const sentinel3 = Buffer.from(PLACEHOLDERS.ENROLLMENT_SECRET, 'utf16le');

    // Simulate a real MSI layout (header + data + sentinels scattered with gaps)
    const header = Buffer.alloc(4096, 0xcc);
    const gap = Buffer.alloc(1024, 0xdd);
    const template = Buffer.concat([header, sentinel1, gap, sentinel2, gap, sentinel3, gap]);

    const result = replaceMsiPlaceholders(template, {
      serverUrl: 'https://rmm.acme-msp.com',
      enrollmentKey: 'a'.repeat(64),
      enrollmentSecret: 'my-enrollment-secret',
    });

    // Size unchanged
    expect(result.length).toBe(template.length);

    // Header unchanged (not corrupted)
    expect(result.subarray(0, 4096).equals(header)).toBe(true);

    // Gaps unchanged
    const gap1Start = 4096 + sentinel1.length;
    expect(result.subarray(gap1Start, gap1Start + 1024).equals(gap)).toBe(true);

    // Values present at correct offsets
    const serverVal = result.subarray(4096, 4096 + sentinel1.length).toString('utf16le');
    expect(serverVal.startsWith('https://rmm.acme-msp.com')).toBe(true);
    expect(serverVal.includes('@@BREEZE')).toBe(false);
  });
});
