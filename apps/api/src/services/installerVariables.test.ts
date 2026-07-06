import { describe, it, expect } from 'vitest';
import {
  substituteInstallerVariables,
  resolveInstallerVariables,
  type InstallerVariableContext,
} from './installerVariables';

const ctx: InstallerVariableContext = {
  org: { id: 'org-123', name: 'Acme Corp' },
  site: { id: 'site-9', name: 'HQ' },
  device: {
    hostname: 'WKS-014',
    customFields: { license_key: 'ABC-999', region: 'us-east', blank: '' },
  },
};

describe('substituteInstallerVariables', () => {
  it('returns the template untouched when it has no variables', () => {
    const r = substituteInstallerVariables('https://example.com/app.msi', ctx);
    expect(r.value).toBe('https://example.com/app.msi');
    expect(r.unresolved).toEqual([]);
  });

  it('passes null through', () => {
    expect(substituteInstallerVariables(null, ctx)).toEqual({ value: null, unresolved: [] });
  });

  it.each([
    ['{{org.name}}', 'Acme Corp'],
    ['{{org.id}}', 'org-123'],
    ['{{site.name}}', 'HQ'],
    ['{{site.id}}', 'site-9'],
    ['{{device.hostname}}', 'WKS-014'],
    ['{{device.customField.license_key}}', 'ABC-999'],
  ])('resolves built-in / custom token %s', (token, expected) => {
    const r = substituteInstallerVariables(`x-${token}-y`, ctx);
    expect(r.value).toBe(`x-${expected}-y`);
    expect(r.unresolved).toEqual([]);
  });

  it('tolerates inner whitespace', () => {
    expect(substituteInstallerVariables('{{ org.name }}', ctx).value).toBe('Acme Corp');
  });

  it('resolves multiple variables in one string', () => {
    const r = substituteInstallerVariables(
      'https://dl/{{org.id}}/{{device.customField.region}}/app.msi',
      ctx,
    );
    expect(r.value).toBe('https://dl/org-123/us-east/app.msi');
    expect(r.unresolved).toEqual([]);
  });

  it('leaves the single-brace {file} agent token alone', () => {
    const r = substituteInstallerVariables('msiexec /i "{file}" /qn {{org.id}}', ctx);
    expect(r.value).toBe('msiexec /i "{file}" /qn org-123');
    expect(r.unresolved).toEqual([]);
  });

  it('flags an unknown token and leaves it verbatim', () => {
    const r = substituteInstallerVariables('https://dl/{{org.licence}}/app.msi', ctx);
    expect(r.value).toBe('https://dl/{{org.licence}}/app.msi');
    expect(r.unresolved).toEqual(['{{org.licence}}']);
  });

  it('treats a missing or empty custom field as unresolved (fail loudly)', () => {
    const missing = substituteInstallerVariables('{{device.customField.absent}}', ctx);
    expect(missing.unresolved).toEqual(['{{device.customField.absent}}']);
    const blank = substituteInstallerVariables('{{device.customField.blank}}', ctx);
    expect(blank.unresolved).toEqual(['{{device.customField.blank}}']);
  });

  it('handles a null customFields bag', () => {
    const r = substituteInstallerVariables('{{device.customField.license_key}}', {
      ...ctx,
      device: { hostname: 'H', customFields: null },
    });
    expect(r.unresolved).toEqual(['{{device.customField.license_key}}']);
  });
});

describe('resolveInstallerVariables', () => {
  it('resolves both fields and de-duplicates unresolved tokens', () => {
    const r = resolveInstallerVariables(
      'https://dl/{{org.bogus}}/app.msi',
      'run {{org.bogus}} now',
      ctx,
    );
    expect(r.downloadUrl).toBe('https://dl/{{org.bogus}}/app.msi');
    expect(r.silentInstallArgs).toBe('run {{org.bogus}} now');
    expect(r.unresolved).toEqual(['{{org.bogus}}']); // de-duped across both fields
  });

  it('returns clean values when everything resolves', () => {
    const r = resolveInstallerVariables(
      'https://dl/{{org.id}}/app.msi',
      'msiexec /i "{file}" /qn KEY={{device.customField.license_key}}',
      ctx,
    );
    expect(r.downloadUrl).toBe('https://dl/org-123/app.msi');
    expect(r.silentInstallArgs).toBe('msiexec /i "{file}" /qn KEY=ABC-999');
    expect(r.unresolved).toEqual([]);
  });
});
