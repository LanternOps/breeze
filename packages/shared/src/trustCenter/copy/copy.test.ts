import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '../../utils/locale';
import { TRUST_CONTROL_CATALOG } from '../controlCatalog';
import { DECLARED_CONTROL_CATALOG } from '../declaredCatalog';
import { FRAMEWORK_CROSSWALK } from '../frameworkCrosswalk';
import { TRUST_CONTROL_CATEGORY_ORDER, TRUST_FRAMEWORKS } from '../types';
import { TRUST_CATALOG_COPY, trustCopyFor } from './index';
import type { TrustCatalogCopy } from './types';

const STATUS_KEYS = ['met', 'attention', 'not_met', 'not_assessed', 'current', 'expired'];

/** Every leaf string with a stable path. */
function leaves(c: TrustCatalogCopy): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [id, v] of Object.entries(c.controls)) out.push([`controls.${id}.title`, v.title], [`controls.${id}.description`, v.description]);
  for (const [k, v] of Object.entries(c.categories)) out.push([`categories.${k}`, v]);
  for (const [fw, refs] of Object.entries(c.crosswalk)) for (const [ref, v] of Object.entries(refs)) out.push([`crosswalk.${fw}.${ref}`, v]);
  for (const [k, v] of Object.entries(c.statuses)) out.push([`statuses.${k}`, v]);
  return out;
}

// Product and framework proper nouns that legitimately stay as-is in a translation.
const PROPER_NOUN = /^(Microsoft 365|EDR|MFA|DNS|CIS|NIST|Cyber Essentials|Essential Eight|Firewalls?)$/i;

describe('trust catalog copy', () => {
  it('has every locale', () => {
    expect(Object.keys(TRUST_CATALOG_COPY).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it.each(SUPPORTED_LOCALES)('%s carries every control, category, crosswalk ref and status', (locale) => {
    const c = TRUST_CATALOG_COPY[locale];
    for (const def of [...TRUST_CONTROL_CATALOG, ...DECLARED_CONTROL_CATALOG]) {
      expect(c.controls[def.id], `${locale} control ${def.id}`).toBeTruthy();
    }
    expect(Object.keys(c.controls).length).toBe(TRUST_CONTROL_CATALOG.length + DECLARED_CONTROL_CATALOG.length);
    for (const cat of TRUST_CONTROL_CATEGORY_ORDER) expect(c.categories[cat], `${locale} category ${cat}`).toBeTruthy();
    for (const fw of TRUST_FRAMEWORKS) {
      expect(Object.keys(c.crosswalk[fw]).sort(), `${locale} crosswalk ${fw}`).toEqual(Object.keys(FRAMEWORK_CROSSWALK[fw]).sort());
    }
    expect(Object.keys(c.statuses).sort()).toEqual([...STATUS_KEYS].sort());
  });

  it.each(SUPPORTED_LOCALES)('%s has no empty value', (locale) => {
    for (const [path, v] of leaves(TRUST_CATALOG_COPY[locale])) expect(v.trim(), `${locale} ${path}`).not.toBe('');
  });

  it('en equals the catalog strings', () => {
    const en = TRUST_CATALOG_COPY.en;
    for (const def of [...TRUST_CONTROL_CATALOG, ...DECLARED_CONTROL_CATALOG]) {
      expect(en.controls[def.id]).toEqual({ title: def.title, description: def.description });
    }
    for (const fw of TRUST_FRAMEWORKS) {
      for (const [ref, entry] of Object.entries(FRAMEWORK_CROSSWALK[fw])) expect(en.crosswalk[fw][ref]).toBe(entry.label);
    }
  });

  it.each(SUPPORTED_LOCALES.filter((l) => l !== 'en'))('%s is really translated (>= 90%% of strings differ from English)', (locale) => {
    const en = new Map(leaves(TRUST_CATALOG_COPY.en));
    const rows = leaves(TRUST_CATALOG_COPY[locale]);
    const same = rows.filter(([path, v]) => v === en.get(path) && !PROPER_NOUN.test(v));
    expect((rows.length - same.length) / rows.length, `${locale} untranslated: ${same.map(([p]) => p).join(', ')}`).toBeGreaterThanOrEqual(0.9);
    // Control prose is never a proper noun: no title or description may be left in English.
    expect(same.filter(([p]) => p.startsWith('controls.')).map(([p]) => p), `${locale} untranslated control prose`).toEqual([]);
  });

  it('trustCopyFor falls back to en for unknown, null and undefined', () => {
    expect(trustCopyFor('xx-XX')).toBe(TRUST_CATALOG_COPY.en);
    expect(trustCopyFor(null)).toBe(TRUST_CATALOG_COPY.en);
    expect(trustCopyFor(undefined)).toBe(TRUST_CATALOG_COPY.en);
    expect(trustCopyFor('de-DE')).toBe(TRUST_CATALOG_COPY['de-DE']);
  });
});
