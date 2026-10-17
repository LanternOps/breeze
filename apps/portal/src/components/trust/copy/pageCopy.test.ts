import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '@breeze/shared';
import { copyParityProblems } from '../trustCopy';
import { pageCopy } from './pageCopy';

describe('pageCopy', () => {
  it('has every locale with the English key set and no empty value', () => {
    expect(copyParityProblems(pageCopy as never)).toEqual([]);
  });

  it.each(SUPPORTED_LOCALES.filter((l) => l !== 'en'))('%s is really translated (>= 90%% of entries differ from English)', (locale) => {
    const en = pageCopy.en as Record<string, unknown>;
    const loc = pageCopy[locale] as Record<string, unknown>;
    const same = Object.keys(en).filter((k) => String(loc[k]) === String(en[k]));
    expect(1 - same.length / Object.keys(en).length, `${locale} identical to en: ${same.join(', ')}`).toBeGreaterThanOrEqual(0.9);
  });

  it('every function entry accepts the English call shape and uses its inputs', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const c = pageCopy[locale];
      expect(c.summary(3, 15, 1, 'X')).toContain('15');
      expect(c.coverage(46, 50, 'U')).toContain('46');
      expect(c.reasonInsufficient(80, 'U')).toContain('80');
      expect(c.stale('WHEN')).toContain('WHEN');
      expect(c.logoAlt('Acme')).toContain('Acme');
    }
  });
});

describe('static: no hard-coded en-US in the page chrome', () => {
  // Files this sub-wave owns. TrustDocumentsList.tsx (document dates) belongs to the documents sub-wave.
  const owned = ['TrustPageView.tsx', 'trustPageFormat.ts', 'TrustStatusPill.tsx'];
  it.each(owned)('%s has no en-US literal', (file) => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    expect(src).not.toMatch(/['"`]en-US['"`]/);
  });
  it('the copy directory holds exactly pageCopy', () => {
    expect(readdirSync(__dirname).filter((f) => !f.endsWith('.test.ts'))).toEqual(['pageCopy.ts']);
  });
});
