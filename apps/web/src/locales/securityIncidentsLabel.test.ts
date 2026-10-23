import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #9550: the security "Incidents" entry must not read the same as the
// Service Desk "Incidents" entry. Locale keys: nav label, page heading, tab title.
const LOCALES = ['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'] as const;
const EXPECTED: Record<(typeof LOCALES)[number], string> = {
  en: 'Security Incidents',
  'de-DE': 'Sicherheitsvorfälle',
  'es-419': 'Incidentes de seguridad',
  'fr-CA': 'Incidents de sécurité',
  'fr-FR': 'Incidents de sécurité',
  'it-IT': 'Incidenti di sicurezza',
  'pt-BR': 'Incidentes de segurança',
  'tr-TR': 'Güvenlik Olayları',
};

const read = (locale: string, ns: string) =>
  JSON.parse(readFileSync(join(__dirname, locale, `${ns}.json`), 'utf8'));

describe('security Incidents label (#9550)', () => {
  it.each(LOCALES)('%s: nav, page heading and tab title say Security Incidents', (locale) => {
    const common = read(locale, 'common');
    const pages = read(locale, 'pages');
    expect(common.nav.incidents).toBe(EXPECTED[locale]);
    expect(common.longTail.incidents.IncidentsPage.title).toBe(EXPECTED[locale]);
    expect(pages.titles.incidents).toBe(EXPECTED[locale]);
  });

  it.each(LOCALES)('%s: does not collide with the Service Desk Incidents label', (locale) => {
    const common = read(locale, 'common');
    expect(common.nav.incidents).not.toBe(common.nav.ticketsIncidents);
  });
});
