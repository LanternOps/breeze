import { describe, it, expect } from 'vitest';
import {
  findTokens,
  findUnknownTokens,
  customFieldToken,
  BUILTIN_INSTALLER_VARIABLES,
} from './installerVariables';

describe('BUILTIN_INSTALLER_VARIABLES vocabulary', () => {
  // Tripwire: this exact set must have a matching arm in the API resolver's
  // resolveKey switch (apps/api/src/services/installerVariables.ts). Adding a
  // token here without wiring the API side would ship a UI-offered variable the
  // resolver fails on at deploy time — update BOTH when this test trips.
  it('offers exactly the tokens the API resolver supports', () => {
    expect(BUILTIN_INSTALLER_VARIABLES.map((v) => v.token).sort()).toEqual(
      ['{{device.hostname}}', '{{org.id}}', '{{org.name}}', '{{site.id}}', '{{site.name}}'].sort(),
    );
  });
});

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
