import { describe, it, expect } from 'vitest';
import { findTokens, findUnknownTokens, customFieldToken } from './installerVariables';

describe('findTokens', () => {
  it('extracts every {{...}} token', () => {
    expect(findTokens('https://dl/{{org.id}}/{{device.hostname}}.msi')).toEqual([
      '{{org.id}}',
      '{{device.hostname}}',
    ]);
  });

  it('ignores single-brace {file}', () => {
    expect(findTokens('msiexec /i "{file}" /qn')).toEqual([]);
  });
});

describe('customFieldToken', () => {
  it('builds the device custom-field token', () => {
    expect(customFieldToken('license_key')).toBe('{{device.customField.license_key}}');
  });
});

describe('findUnknownTokens', () => {
  it('accepts all built-ins', () => {
    const s = '{{org.name}} {{org.id}} {{site.name}} {{site.id}} {{device.hostname}}';
    expect(findUnknownTokens(s, new Set())).toEqual([]);
  });

  it('flags a typo\'d built-in', () => {
    expect(findUnknownTokens('{{org.nam}}', new Set())).toEqual(['{{org.nam}}']);
  });

  it('accepts custom-field tokens on structure alone before keys load', () => {
    // Empty known-key set + default requireKnownCustomKeys=false → structural pass.
    expect(findUnknownTokens('{{device.customField.license_key}}', new Set())).toEqual([]);
  });

  it('validates custom-field keys against the known set when required', () => {
    const known = new Set(['license_key']);
    expect(
      findUnknownTokens('{{device.customField.license_key}}', known, { requireKnownCustomKeys: true }),
    ).toEqual([]);
    expect(
      findUnknownTokens('{{device.customField.ghost}}', known, { requireKnownCustomKeys: true }),
    ).toEqual(['{{device.customField.ghost}}']);
  });

  it('tolerates inner whitespace', () => {
    expect(findUnknownTokens('{{ org.name }}', new Set())).toEqual([]);
  });
});
