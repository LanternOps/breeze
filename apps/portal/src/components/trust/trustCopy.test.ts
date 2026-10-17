import { describe, expect, it } from 'vitest';
import { copyParityProblems, defineTrustCopy, formatTrustDate, pickTrustCopy } from './trustCopy';

const COPY = defineTrustCopy({
  en: { title: 'Declared controls', count: (n: number) => `${n} declared` },
  'pt-BR': { title: 'Controles declarados', count: (n: number) => `${n} declarados` },
  'es-419': { title: 'Controles declarados', count: (n: number) => `${n} declarados` },
  'fr-FR': { title: 'Contrôles déclarés', count: (n: number) => `${n} déclarés` },
  'fr-CA': { title: 'Contrôles déclarés', count: (n: number) => `${n} déclarés` },
  'de-DE': { title: 'Erklärte Kontrollen', count: (n: number) => `${n} erklärt` },
  'it-IT': { title: 'Controlli dichiarati', count: (n: number) => `${n} dichiarati` },
  'tr-TR': { title: 'Beyan edilen kontroller', count: (n: number) => `${n} beyan` },
});

describe('trust copy mechanism', () => {
  it('picks the locale, and an unknown or missing locale gets English', () => {
    expect(pickTrustCopy(COPY, 'de-DE').title).toBe('Erklärte Kontrollen');
    expect(pickTrustCopy(COPY, 'xx-YY').title).toBe('Declared controls');
    expect(pickTrustCopy(COPY, null).title).toBe('Declared controls');
    expect(pickTrustCopy(COPY, undefined).count(3)).toBe('3 declared');
  });

  it('copyParityProblems accepts a complete module and flags a missing key, an extra key, an empty string and a missing locale', () => {
    expect(copyParityProblems(COPY)).toEqual([]);
    const { title: _t, ...noTitle } = COPY['fr-CA'];
    expect(copyParityProblems({ ...COPY, 'fr-CA': noTitle })).toContain('fr-CA: missing key title');
    expect(copyParityProblems({ ...COPY, 'it-IT': { ...COPY['it-IT'], extra: 'x' } })).toContain('it-IT: extra key extra');
    expect(copyParityProblems({ ...COPY, 'tr-TR': { ...COPY['tr-TR'], title: '' } })).toContain('tr-TR: empty string at title');
    const { 'pt-BR': _p, ...noPt } = COPY;
    expect(copyParityProblems(noPt)).toContain('missing locale pt-BR');
  });

  it('formats dates in the page locale and renders an unparseable value as empty', () => {
    expect(formatTrustDate('2026-10-01T12:00:00.000Z', 'en')).toMatch(/2026/);
    expect(formatTrustDate('2026-10-01T12:00:00.000Z', 'de-DE')).not.toBe(formatTrustDate('2026-10-01T12:00:00.000Z', 'en'));
    expect(formatTrustDate('not a date', 'en')).toBe('');
  });
});
