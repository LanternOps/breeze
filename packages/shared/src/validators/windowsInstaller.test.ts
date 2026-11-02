import { describe, expect, it } from 'vitest';
import { windowsInstallerIntegritySchema } from './windowsInstaller';

const valid = { url: 'https://rmm.example.com/breeze/api/v1/agents/install.ps1', sha256: 'a'.repeat(64) };

describe('Windows installer integrity', () => {
  it('accepts a canonical HTTPS resource with a complete SHA-256', () => {
    expect(windowsInstallerIntegritySchema.parse(valid)).toEqual(valid);
  });

  it.each([
    undefined, null, {}, { ...valid, sha256: 'short' }, { ...valid, sha256: 'g'.repeat(64) },
    { ...valid, url: 'invalid' }, { ...valid, url: 'http://rmm.example.com/api/v1/agents/install.ps1' },
    { ...valid, url: 'https://user:password@rmm.example.com/api/v1/agents/install.ps1' },
    { ...valid, url: `${valid.url}?token=secret` }, { ...valid, url: `${valid.url}#fragment` },
    { ...valid, url: 'https://rmm.example.com/other.ps1' },
  ])('rejects missing or unsafe metadata %j', (value) => {
    expect(windowsInstallerIntegritySchema.safeParse(value).success).toBe(false);
  });
});
