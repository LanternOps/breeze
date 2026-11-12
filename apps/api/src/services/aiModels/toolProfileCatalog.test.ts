import { describe, expect, it } from 'vitest';
import { AI_TOOL_PROFILED_SURFACES } from '@breeze/shared';
import { requiredToolsFor, SURFACE_REQUIRED_TOOLS } from './surfaceRequiredTools';
import { CURATED_PROFILES } from './toolProfiles';
import { breezeToolProfileCatalog } from './toolProfileCatalog';
import { buildToolProfileDto, validateToolSettingsPatch } from './toolSettingsWrite';
import { outcomeToolsForRun } from '../aiAgents/outcomeTools';

const catalog = breezeToolProfileCatalog();

describe('breezeToolProfileCatalog (#11398)', () => {
  it('declares every surface floor on its own surface (else the write check could never be satisfied)', () => {
    for (const [surface, names] of Object.entries(SURFACE_REQUIRED_TOOLS)) {
      for (const name of names) expect(catalog.surfaceNames(surface as 'chat').has(name), `${surface}: ${name}`).toBe(true);
    }
    const outcome = new Set<string>(outcomeToolsForRun({ profile: 'device_troubleshooting' }));
    for (const name of requiredToolsFor('ai_agents', { profile: 'device_troubleshooting' }).filter((n) => !outcome.has(n))) {
      expect(catalog.surfaceNames('ai_agents').has(name), name).toBe(true);
    }
  });

  it('declares every curated name (so a custom list copied from a profile is never "unknown")', () => {
    for (const surface of AI_TOOL_PROFILED_SURFACES) {
      for (const name of CURATED_PROFILES[surface].standard) expect(catalog.surfaceNames(surface).has(name), `${surface}: ${name}`).toBe(true);
    }
  });

  it('gives registry tools their domain and script-builder-only names none', () => {
    expect(catalog.domainOf('query_devices')).toBeDefined();
    expect(catalog.domainOf('apply_script_code')).toBeUndefined();
  });

  it('with the real registries: minimal on the script builder misses exactly execute_script_on_device', () => {
    const e = (() => {
      try {
        validateToolSettingsPatch({
          stored: { toolProfile: 'auto', toolAllowlist: null },
          patch: { expectedUpdatedAt: '2026-11-12T00:00:00.000Z', toolProfile: 'minimal' },
          gateway: null,
          served: { surfaces: new Set(['script_builder']), troubleshootingRuns: false },
          catalog,
        });
      } catch (err) {
        return err as { details?: unknown };
      }
      return null;
    })();
    expect(e?.details).toEqual({ field: 'toolProfile', surfaces: [{ surface: 'script_builder', missing: ['execute_script_on_device'] }] });
  });

  it('with the real registries: standard keeps every floor, incl. the troubleshooting run', () => {
    const dto = buildToolProfileDto({ toolProfile: 'standard', toolAllowlist: null }, { effectiveWindow: null, gateway: false, catalog, troubleshootingRuns: true });
    expect(dto.surfaces.map((s) => [s.surface, s.missingRequired])).toEqual(AI_TOOL_PROFILED_SURFACES.map((s) => [s, []]));
  });
});
