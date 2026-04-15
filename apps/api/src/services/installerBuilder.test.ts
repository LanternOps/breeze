import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildMacosInstallerZip } from './installerBuilder';

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
