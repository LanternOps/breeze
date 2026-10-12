import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// #7975: the public release ships the Windows agent MSI/exes UNSIGNED
// (platformTrust "none"). Guard the prose that must not claim otherwise.
const repo = resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(resolve(repo, p), 'utf8');

describe('installer signing docs (#7975)', () => {
  it('installerBuilder does not call the served MSI "CI-signed"', () => {
    expect(read('apps/api/src/services/installerBuilder.ts')).not.toMatch(/CI-signed MSI/);
  });

  it('WINDOWS_INSTALLER_SIGNING.md does not claim the public agent MSI/exes are signed', () => {
    const state = read('docs/signing/WINDOWS_INSTALLER_SIGNING.md').split('## What We Need')[0];
    expect(state).not.toMatch(/itself\s+signed/);
    expect(state).not.toMatch(/from\s+the\s+signed\s+exes/);
    expect(state).toMatch(/unsigned/i);
  });

  it('a "Verify a Breeze installer" docs page exists and covers the checks', () => {
    const page = 'apps/docs/src/content/docs/deploy/verify-installer.mdx';
    expect(existsSync(resolve(repo, page))).toBe(true);
    const body = read(page);
    for (const needle of [
      'Get-FileHash',
      'shasum -a 256',
      'checksums.txt',
      'release-artifact-manifest.json.ed25519',
      'Get-AuthenticodeSignature',
    ]) {
      expect(body).toContain(needle);
    }
  });
});
