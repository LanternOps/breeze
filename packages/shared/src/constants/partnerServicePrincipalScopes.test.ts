import { describe, expect, it } from 'vitest';
import {
  PARTNER_SERVICE_PRINCIPAL_MCP_SCOPES,
  PARTNER_SERVICE_PRINCIPAL_OPT_IN_READ_SCOPES,
  PARTNER_SERVICE_PRINCIPAL_READ_SCOPES,
  PARTNER_SERVICE_PRINCIPAL_SCOPES,
  PARTNER_SERVICE_PRINCIPAL_SCOPE_PRESETS,
  PARTNER_SERVICE_PRINCIPAL_WRITE_SCOPES,
  partnerServicePrincipalScopeI18nKey,
} from './partnerServicePrincipalScopes';

describe('partner service principal scope presets', () => {
  const all = new Set<string>(PARTNER_SERVICE_PRINCIPAL_SCOPES);

  it('only expands to scopes that exist (a preset can never widen the registry)', () => {
    for (const preset of PARTNER_SERVICE_PRINCIPAL_SCOPE_PRESETS) {
      for (const scope of preset.scopes) expect(all.has(scope), `${preset.id}: ${scope}`).toBe(true);
      expect(new Set(preset.scopes).size).toBe(preset.scopes.length);
    }
  });

  it('offers the documented task presets in order, default first, custom last', () => {
    expect(PARTNER_SERVICE_PRINCIPAL_SCOPE_PRESETS.map((p) => p.id)).toEqual([
      'docs-sync', 'provisioning', 'alert-feed', 'ticketing', 'ai-mcp', 'custom',
    ]);
    const byId = Object.fromEntries(PARTNER_SERVICE_PRINCIPAL_SCOPE_PRESETS.map((p) => [p.id, p.scopes]));
    expect(byId['docs-sync']).toEqual([...PARTNER_SERVICE_PRINCIPAL_READ_SCOPES]);
    expect(byId.provisioning).toEqual([
      ...PARTNER_SERVICE_PRINCIPAL_READ_SCOPES, 'organizations:write', 'sites:write', 'enrollment-keys:write',
    ]);
    expect(byId['alert-feed']).toEqual(['organizations:read', 'alerts:read']);
    expect(byId.ticketing).toEqual(['organizations:read', 'tickets:read', 'tickets:write']);
    expect(byId['ai-mcp']).toEqual(['ai:read']);
    expect(byId.custom).toEqual([]);
  });

  it('never pre-selects the high-impact scopes', () => {
    for (const preset of PARTNER_SERVICE_PRINCIPAL_SCOPE_PRESETS) {
      for (const scope of ['ai:execute_admin', 'ai:execute', 'ai:write', 'contracts:write']) {
        expect(preset.scopes).not.toContain(scope);
      }
    }
  });

  it('partitions the registry with no duplicates across groups', () => {
    const groups = [
      ...PARTNER_SERVICE_PRINCIPAL_READ_SCOPES,
      ...PARTNER_SERVICE_PRINCIPAL_OPT_IN_READ_SCOPES,
      ...PARTNER_SERVICE_PRINCIPAL_WRITE_SCOPES,
      ...PARTNER_SERVICE_PRINCIPAL_MCP_SCOPES,
    ];
    expect(groups).toEqual([...PARTNER_SERVICE_PRINCIPAL_SCOPES]);
    expect(new Set(groups).size).toBe(groups.length);
  });

  it('derives an i18n-safe key (no ":" which i18next treats as a namespace separator)', () => {
    expect(partnerServicePrincipalScopeI18nKey('alerts:read')).toBe('alerts_read');
    expect(partnerServicePrincipalScopeI18nKey('backup-configuration:read')).toBe('backup-configuration_read');
  });
});
