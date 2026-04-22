import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import JSZip from 'jszip';
import { buildMacosInstallerZip, buildWindowsInstallerZip } from './installerBuilder';

// Real keys are 64 lowercase hex chars produced by randomBytes(32).toString('hex').
// Tests use that exact generator so a future drift between generator and validator
// fails here loudly.
function realEnrollmentKey(): string {
  return randomBytes(32).toString('hex');
}

describe('buildMacosInstallerZip', () => {
  it('produces a zip with pkg, enrollment.json, and install.sh', async () => {
    const fakePkg = Buffer.from('fake-pkg-contents');
    const validKey = realEnrollmentKey();

    const zipBuffer = await buildMacosInstallerZip(fakePkg, {
      serverUrl: 'https://breeze.example.com',
      enrollmentKey: validKey,
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
    expect(config.enrollmentKey).toBe(validKey);
    expect(config.enrollmentSecret).toBe('secret456');
    expect(config.siteId).toBe('550e8400-e29b-41d4-a716-446655440000');

    const pkgData = await zip.files['breeze-agent.pkg']!.async('nodebuffer');
    expect(pkgData.equals(fakePkg)).toBe(true);
  });

  it('sets enrollmentSecret to empty string when not provided', async () => {
    const zipBuffer = await buildMacosInstallerZip(Buffer.from('pkg'), {
      serverUrl: 'https://x.com',
      enrollmentKey: realEnrollmentKey(),
      enrollmentSecret: '',
      siteId: '550e8400-e29b-41d4-a716-446655440000',
    });

    const zip = await JSZip.loadAsync(zipBuffer);
    const config = JSON.parse(await zip.files['enrollment.json']!.async('string'));
    expect(config.enrollmentSecret).toBe('');
  });

  it('rejects a key with the legacy brz_ prefix (drift guard)', async () => {
    await expect(
      buildMacosInstallerZip(Buffer.from('pkg'), {
        serverUrl: 'https://x.com',
        enrollmentKey: 'brz_' + realEnrollmentKey(),
        enrollmentSecret: '',
        siteId: '550e8400-e29b-41d4-a716-446655440000',
      })
    ).rejects.toThrow(/invalid enrollment key/i);
  });
});

describe('buildMacosInstallerZip — install.sh content', () => {
  it('install.sh contains shebang and enrollment command', async () => {
    const zipBuffer = await buildMacosInstallerZip(Buffer.from('pkg'), {
      serverUrl: 'https://x.com',
      enrollmentKey: realEnrollmentKey(),
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

describe('buildWindowsInstallerZip', () => {
  it('rejects an enrollment key with shell-meaningful characters', async () => {
    await expect(
      buildWindowsInstallerZip(Buffer.from('msi'), {
        serverUrl: 'https://breeze.example.com',
        enrollmentKey: 'abc\nrm -rf /',
        enrollmentSecret: 'secret456',
        siteId: '550e8400-e29b-41d4-a716-446655440000',
      })
    ).rejects.toThrow(/invalid enrollment key/i);
  });

  it('rejects an enrollment key with the legacy brz_ prefix (drift guard)', async () => {
    await expect(
      buildWindowsInstallerZip(Buffer.from('msi'), {
        serverUrl: 'https://breeze.example.com',
        enrollmentKey: 'brz_' + realEnrollmentKey(),
        enrollmentSecret: 'secret456',
        siteId: '550e8400-e29b-41d4-a716-446655440000',
      })
    ).rejects.toThrow(/invalid enrollment key/i);
  });

  it('quotes ENROLLMENT_KEY in install.bat', async () => {
    const validKey = realEnrollmentKey();
    const zip = await buildWindowsInstallerZip(Buffer.from('msi'), {
      serverUrl: 'https://breeze.example.com',
      enrollmentKey: validKey,
      enrollmentSecret: 'secret456',
      siteId: '550e8400-e29b-41d4-a716-446655440000',
    });

    const zipInstance = await JSZip.loadAsync(zip);
    const batScript = await zipInstance.files['install.bat']!.async('string');
    expect(batScript).toContain(`set ENROLLMENT_KEY="${validKey}"`);
  });
});
