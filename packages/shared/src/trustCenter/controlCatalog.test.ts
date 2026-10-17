import { describe, expect, it } from 'vitest';
import {
  TRUST_CONTROL_CATALOG, TRUST_CONTROL_CATALOG_VERSION, TELEMETRY_CONTROL_IDS, trustControlById,
} from './controlCatalog';
import { DECLARED_CONTROL_CATALOG } from './declaredCatalog';
import { FRAMEWORK_CROSSWALK, FRAMEWORK_META, TRUST_FRAMEWORKS } from './frameworkCrosswalk';
import { W1_TELEMETRY_CONTROL_IDS } from './types';

/** Crosswalk entries kept for framework completeness with no Breeze control mapped yet (exempt from the orphan check). */
const CROSSWALK_COMPLETENESS_ALLOWLIST = new Set([
  'essential_eight:application_control', 'essential_eight:patch_applications', 'essential_eight:macro_settings',
]);

describe('trust control catalog', () => {
  it('has exactly the telemetry controls, each once', () => {
    expect(TRUST_CONTROL_CATALOG.map((c) => c.id).sort()).toEqual([...TELEMETRY_CONTROL_IDS].sort());
    expect(new Set(TRUST_CONTROL_CATALOG.map((c) => c.id)).size).toBe(16);
  });

  it('has 16 telemetry controls with unique insurer ranks 1..16, mfa_enforced_m365 first', () => {
    expect(TRUST_CONTROL_CATALOG).toHaveLength(16);
    expect(TRUST_CONTROL_CATALOG.map((c) => c.insurerRank).sort((a, b) => a - b)).toEqual([...Array(16)].map((_, i) => i + 1));
    expect(trustControlById('mfa_enforced_m365')).toMatchObject({ insurerRank: 1, metric: 'boolean', unit: 'org', category: 'identity_access' });
  });

  it('keeps the frozen W1 id list', () => {
    expect(W1_TELEMETRY_CONTROL_IDS).toHaveLength(15);
    expect(W1_TELEMETRY_CONTROL_IDS).not.toContain('mfa_enforced_m365');
    expect(TELEMETRY_CONTROL_IDS.filter((id) => id !== 'mfa_enforced_m365')).toEqual([...W1_TELEMETRY_CONTROL_IDS]);
  });

  it('every NIST ref is a subcategory', () => {
    const refs = [...TRUST_CONTROL_CATALOG, ...DECLARED_CONTROL_CATALOG].flatMap((c) => c.frameworkRefs).filter((r) => r.framework === 'nist_csf_2');
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(r.ref).toMatch(/^[A-Z]{2}\.[A-Z]{2}-\d{2}$/);
  });

  it('every ref of both catalogs resolves in the crosswalk and no crosswalk entry is orphaned', () => {
    const used = new Set<string>();
    for (const c of [...TRUST_CONTROL_CATALOG, ...DECLARED_CONTROL_CATALOG]) {
      for (const r of c.frameworkRefs) {
        expect(FRAMEWORK_CROSSWALK[r.framework][r.ref], `${c.id} → ${r.framework} ${r.ref}`).toBeDefined();
        used.add(`${r.framework}:${r.ref}`);
      }
    }
    for (const fw of TRUST_FRAMEWORKS) {
      for (const ref of Object.keys(FRAMEWORK_CROSSWALK[fw])) {
        const key = `${fw}:${ref}`;
        if (CROSSWALK_COMPLETENESS_ALLOWLIST.has(key)) continue;
        expect(used.has(key), `orphaned crosswalk entry ${key}`).toBe(true);
      }
    }
  });

  it('the Essential Eight crosswalk lists all eight strategies, completeness entries included', () => {
    expect(Object.keys(FRAMEWORK_CROSSWALK.essential_eight)).toHaveLength(8);
    for (const key of CROSSWALK_COMPLETENESS_ALLOWLIST) {
      const [fw, ref] = key.split(':') as ['essential_eight', string];
      expect(FRAMEWORK_CROSSWALK[fw][ref], key).toBeDefined();
    }
  });

  it('every control has unique insurerRank and non-empty English copy', () => {
    const ranks = TRUST_CONTROL_CATALOG.map((c) => c.insurerRank);
    expect(new Set(ranks).size).toBe(ranks.length);
    for (const c of TRUST_CONTROL_CATALOG) {
      expect(c.title.length).toBeGreaterThan(3);
      expect(c.description.length).toBeGreaterThan(10);
      expect(c.source).toBe('telemetry');
    }
  });

  it('every control references at least one CIS v8 safeguard and every ref resolves in the crosswalk', () => {
    for (const c of TRUST_CONTROL_CATALOG) {
      expect(c.frameworkRefs.some((r) => r.framework === 'cis_v8'), c.id).toBe(true);
      for (const r of c.frameworkRefs) {
        expect(TRUST_FRAMEWORKS).toContain(r.framework);
        expect(FRAMEWORK_CROSSWALK[r.framework][r.ref], `${c.id} → ${r.framework} ${r.ref}`).toBeDefined();
      }
    }
  });

  it('names the CIS version the crosswalk was transcribed from (v8.1)', () => {
    expect(FRAMEWORK_META.cis_v8.name).toBe('CIS Critical Security Controls v8.1');
  });

  it('crosswalk labels are Breeze paraphrases, never framework-verbatim markers, and every framework has meta', () => {
    for (const fw of TRUST_FRAMEWORKS) {
      expect(FRAMEWORK_META[fw].name.length).toBeGreaterThan(2);
      expect(FRAMEWORK_META[fw].sourceUrl.startsWith('https://')).toBe(true);
      expect(FRAMEWORK_META[fw].safeguardTotal).toBeGreaterThan(0);
      for (const [ref, entry] of Object.entries(FRAMEWORK_CROSSWALK[fw])) {
        expect(ref.length).toBeGreaterThan(0);
        expect(entry.label.length).toBeLessThanOrEqual(60);
        expect(entry.label).not.toMatch(/compliant|certified/i);
      }
    }
  });

  it('copy never implies certification', () => {
    for (const c of TRUST_CONTROL_CATALOG) {
      expect(`${c.title} ${c.description}`).not.toMatch(/compliant with|certified|meets IG/i);
    }
  });

  it('exposes a semver-ish catalog version and a lookup', () => {
    expect(TRUST_CONTROL_CATALOG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(TRUST_CONTROL_CATALOG_VERSION).toBe('2026-10-17.1');
    expect(trustControlById('disk_encryption')?.category).toBe('data_protection');
    expect(trustControlById('nope' as never)).toBeUndefined();
  });
});
