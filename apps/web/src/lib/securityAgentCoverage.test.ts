import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coverageReasonLabel } from './securityAgentCoverage';

const LOCALES = ['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'] as const;

function tFor(locale: string) {
  const security = JSON.parse(readFileSync(join(__dirname, '..', 'locales', locale, 'security.json'), 'utf8'));
  return (key: string) => {
    const path = key.replace(/^security:/, '').split('.');
    let node: unknown = security;
    for (const part of path) node = (node as Record<string, unknown> | undefined)?.[part];
    return typeof node === 'string' ? node : key;
  };
}

describe('coverageReasonLabel — tenant-variable readiness reasons (#6960 W05)', () => {
  it.each(LOCALES)('%s: var_secret and var_missing render translated labels, never the raw key', (locale) => {
    const t = tFor(locale);
    for (const code of ['var_secret', 'var_missing']) {
      const label = coverageReasonLabel(t, code);
      expect(label).not.toBe(code);
      expect(label).not.toContain('securityAgentCoverage.reasons');
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('var_secret and var_missing are distinct labels (different remedies), and translated', () => {
    const de = tFor('de-DE');
    expect(coverageReasonLabel(de, 'var_secret')).not.toBe(coverageReasonLabel(de, 'var_missing'));
    expect(coverageReasonLabel(tFor('en'), 'var_secret')).not.toBe(coverageReasonLabel(de, 'var_secret'));
  });

  it('an unknown code still falls back to the raw code', () => {
    expect(coverageReasonLabel(tFor('en'), 'acme_reason')).toBe('acme_reason');
  });
});
