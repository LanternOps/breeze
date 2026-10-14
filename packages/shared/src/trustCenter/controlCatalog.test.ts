import { describe, expect, it } from 'vitest';
import {
  TRUST_CONTROL_CATALOG, TRUST_CONTROL_CATALOG_VERSION, TELEMETRY_CONTROL_IDS, trustControlById,
} from './controlCatalog';
import { FRAMEWORK_CROSSWALK, FRAMEWORK_META, TRUST_FRAMEWORKS } from './frameworkCrosswalk';

describe('trust control catalog', () => {
  it('has exactly the 15 W1 telemetry controls, each once', () => {
    expect(TRUST_CONTROL_CATALOG.map((c) => c.id).sort()).toEqual([...TELEMETRY_CONTROL_IDS].sort());
    expect(new Set(TRUST_CONTROL_CATALOG.map((c) => c.id)).size).toBe(15);
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
    expect(trustControlById('disk_encryption')?.category).toBe('data_protection');
    expect(trustControlById('nope' as never)).toBeUndefined();
  });
});
