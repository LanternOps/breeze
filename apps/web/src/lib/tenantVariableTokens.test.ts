import { describe, expect, it } from 'vitest';
import type { TenantVariable } from '@breeze/shared';
import { findUnknownVariableKeys, toTenantVariableEntries } from './tenantVariableTokens';

function row(partial: Partial<TenantVariable> & { key: string }): TenantVariable {
  return {
    id: `id-${partial.key}-${partial.ownerScope ?? 'organization'}`,
    value: 'v',
    isSecret: false,
    description: null,
    ownerScope: 'organization',
    orgId: 'o-1',
    partnerId: null,
    version: 1,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    ...partial,
  };
}

describe('toTenantVariableEntries', () => {
  it('maps rows to picker entries sorted by key', () => {
    expect(
      toTenantVariableEntries([
        row({ key: 'vendor_token', description: 'Vendor token' }),
        row({ key: 'apt_mirror', description: null, isSecret: true }),
      ]),
    ).toEqual([
      { key: 'apt_mirror', description: null, isSecret: true },
      { key: 'vendor_token', description: 'Vendor token', isSecret: false },
    ]);
  });

  it('collapses a key owned at both scopes to the org-owned row (resolution precedence)', () => {
    const entries = toTenantVariableEntries([
      row({ key: 'repo_url', ownerScope: 'partner', orgId: null, partnerId: 'p-1', description: 'Partner-wide' }),
      row({ key: 'repo_url', ownerScope: 'organization', description: 'Org override' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].description).toBe('Org override');
  });
});

describe('findUnknownVariableKeys', () => {
  const known = new Set(['vendor_token']);

  it('reports a key that is not in the known set', () => {
    expect(
      findUnknownVariableKeys('echo {{var.ghost}}', known, { requireKnownKeys: true }),
    ).toEqual(['ghost']);
  });

  it('de-duplicates a key referenced several times', () => {
    expect(
      findUnknownVariableKeys('{{var.ghost}} {{var.ghost}}', known, { requireKnownKeys: true }),
    ).toEqual(['ghost']);
  });

  it('accepts a known key', () => {
    expect(
      findUnknownVariableKeys('curl {{var.vendor_token}}', known, { requireKnownKeys: true }),
    ).toEqual([]);
  });

  // The list arrives async, and a failed fetch degrades to an empty list. An
  // empty list must never mean "every token is unknown" — same convention as
  // `requireKnownCustomKeys` in VariableInput.
  it('suppresses every warning while the known set is empty', () => {
    expect(findUnknownVariableKeys('{{var.ghost}}', new Set())).toEqual([]);
  });

  it('ignores ${{var.x}} and tokens from other namespaces', () => {
    const content = '${{var.shell_expr}} {{org.name}} {{device.customField.license_key}} {{ var.spaced }}';
    expect(findUnknownVariableKeys(content, known, { requireKnownKeys: true })).toEqual([]);
  });
});
