import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../locales');
const translatedLocales = ['pt-BR', 'es-419', 'fr-FR', 'fr-CA', 'de-DE'] as const;
type TranslatedLocale = (typeof translatedLocales)[number];

// Per-namespace count caps for exact-English duplicates that survived review
// (mostly intentionally preserved literals). These limit net duplicate growth;
// translating an existing duplicate creates headroom because keys are not pinned.
// Language labels are self-names, so `language.frCALabel` is intentionally the
// same `Français (Canada)` value in every catalog.
const namespaceDuplicateBaselines = {
  'pt-BR': {
    'admin.json': 19,
    'ai.json': 1,
    'alerts.json': 43,
    'auth.json': 14,
    'backup.json': 52,
    // +4: contract-template format strings + Portuguese cognate ("v{{number}} ·
    // {{status}}", "v{{number}}", "{{name}} — v{{number}}", "Status")
    // legitimately identical to English.
    // +3: quote send composer — "Cc" (label + toggle) and the example email
    // placeholder are locale-invariant.
    // +2: liveTotals "Subtotal"/"Total" — both spell identically to English in
    // pt-BR (same cognate already accepted for document.totals.subtotal).
    'billing.json': 47,
    // +1: richTextEditor.link — "Link" is the standard loanword in pt-BR.
    // +3: dashboard.vuln.kevCves — "{{count}} CVE(s)" is a locale-invariant
    // acronym (base/_one/_other).
    'common.json': 93,
    'devices.json': 159,
    'discovery.json': 17,
    'integrations.json': 23,
    'patches.json': 22,
    'peripherals.json': 4,
    'policies.json': 357,
    'portal.json': 3,
    'remote.json': 12,
    'reports.json': 39,
    'scripts.json': 55,
    'security.json': 140,
    'settings.json': 109,
    'tickets.json': 13,
    'vulnerabilities.json': 13,
  },
  'es-419': {
    'admin.json': 16,
    'ai.json': 4,
    'alerts.json': 39,
    'auth.json': 14,
    'backup.json': 30,
    // +3: contract-template format strings ("v{{number}} · {{status}}",
    // "v{{number}}", "{{name}} — v{{number}}") that are legitimately identical
    // to English in es-419.
    // +3: quote send composer — "Cc" (label + toggle) and the example email
    // placeholder are locale-invariant.
    // +1: liveTotals "Total" — spells identically to English in es-419 (same
    // cognate already accepted for document.totals.firstPeriodTotal's root word).
    'billing.json': 39,
    // +1: dashboard.vuln.kevCves_one — "{{count}} CVE" is a locale-invariant
    // acronym.
    'common.json': 76,
    'devices.json': 115,
    'discovery.json': 17,
    'integrations.json': 31,
    'patches.json': 15,
    'peripherals.json': 4,
    'policies.json': 241,
    'portal.json': 4,
    'remote.json': 12,
    'reports.json': 32,
    'scripts.json': 57,
    'security.json': 114,
    'settings.json': 112,
    'tickets.json': 13,
    'vulnerabilities.json': 16,
  },
  'fr-FR': {
    'admin.json': 27,
    'ai.json': 9,
    'alerts.json': 58,
    'auth.json': 13,
    'backup.json': 59,
    // +7: contract-template format strings + French cognates ("v{{number}} ·
    // {{status}}", "v{{number}}", "{{name}} — v{{number}}", "Description",
    // "Versions", "Documents" ×2) that are legitimately identical to English
    // in fr-FR.
    // +3: quote send composer — "Cc" (label + toggle) and the example email
    // placeholder are locale-invariant.
    // +1: the unassigned-lines row format ("{{qty}} × {{price}}") is two
    // interpolations and a multiplication sign — there is no French wording to
    // translate, and every other locale carries the identical value.
    // +1: liveTotals "Total" — spells identically to English in fr-FR (same
    // cognate already accepted for document.totals.firstPeriodTotal's root word).
    'billing.json': 50,
    // +1: dashboard.vuln.kevCves_one — "{{count}} CVE" is a locale-invariant
    // acronym.
    'common.json': 94,
    'devices.json': 136,
    'discovery.json': 15,
    'integrations.json': 38,
    'patches.json': 20,
    'peripherals.json': 9,
    'policies.json': 204,
    'portal.json': 4,
    'remote.json': 18,
    'reports.json': 43,
    'scripts.json': 60,
    'security.json': 144,
    'settings.json': 142,
    'tickets.json': 21,
    'vulnerabilities.json': 15,
  },
  'fr-CA': {
    'admin.json': 27,
    'ai.json': 9,
    'alerts.json': 59,
    'auth.json': 13,
    'backup.json': 60,
    // Contract-template format strings, French cognates, and locale-invariant
    // quote composer fields are intentionally identical to English.
    // +2: liveTotals "Total" is the identical French cognate (already accepted
    // in fr-FR), and unassigned.qtyPrice "{{qty}} × {{price}}" is two
    // interpolations plus a multiplication sign with no wording to translate.
    'billing.json': 50,
    // +1: dashboard.vuln.kevCves_one "{{count}} CVE" is a locale-invariant
    // acronym.
    'common.json': 96,
    'devices.json': 136,
    'discovery.json': 15,
    'integrations.json': 40,
    'patches.json': 20,
    'peripherals.json': 9,
    'policies.json': 204,
    'portal.json': 4,
    'remote.json': 17,
    'reports.json': 43,
    'scripts.json': 60,
    'security.json': 144,
    'settings.json': 147,
    'tickets.json': 20,
    'vulnerabilities.json': 15,
  },
  'de-DE': {
    'admin.json': 23,
    'ai.json': 5,
    'alerts.json': 46,
    'auth.json': 15,
    'backup.json': 63,
    // +6: contract-template format strings + German cognates ("v{{number}} ·
    // {{status}}", "v{{number}}", "{{name}} — v{{number}}", "Name", "Status")
    // that are legitimately identical to English in de-DE.
    // +3: quote send composer — "Cc" (label + toggle) and the example email
    // placeholder are locale-invariant.
    'billing.json': 35,
    // +1: richTextEditor.link — "Link" is the standard loanword in de-DE.
    // +3: dashboard.vuln.kevCves — "{{count}} CVE(s)" is a locale-invariant
    // acronym (base/_one/_other).
    'common.json': 94,
    'devices.json': 146,
    'discovery.json': 26,
    'integrations.json': 43,
    'patches.json': 22,
    'peripherals.json': 4,
    'policies.json': 205,
    'portal.json': 4,
    'remote.json': 14,
    'reports.json': 53,
    'scripts.json': 53,
    'security.json': 166,
    'settings.json': 164,
    'tickets.json': 13,
    'vulnerabilities.json': 20,
  },
} satisfies Record<TranslatedLocale, Record<string, number>>;

function flatten(
  obj: Record<string, unknown>,
  prefix = '',
  out = new Map<string, string>(),
): Map<string, string> {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') {
      flatten(value as Record<string, unknown>, path, out);
    } else {
      out.set(path, String(value));
    }
  }
  return out;
}

function readLocale(locale: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const file of readdirSync(join(localesDir, locale)).filter((name) =>
    name.endsWith('.json'),
  )) {
    const values = flatten(
      JSON.parse(readFileSync(join(localesDir, locale, file), 'utf8')),
    );
    for (const [key, value] of values) {
      result.set(`${file}:${key}`, value);
    }
  }
  return result;
}

function namespaceDuplicateRegressions(
  english: Map<string, string>,
  translated: Map<string, string>,
  baselines: Record<string, number>,
): string[] {
  const duplicateCounts = new Map<string, number>();
  for (const [key, value] of english) {
    if (translated.get(key) !== value) continue;
    const namespace = key.slice(0, key.indexOf(':'));
    duplicateCounts.set(namespace, (duplicateCounts.get(namespace) ?? 0) + 1);
  }

  return Object.entries(baselines).flatMap(([namespace, baseline]) => {
    const count = duplicateCounts.get(namespace) ?? 0;
    return count > baseline
      ? [`${namespace}: ${count} exact-English duplicates exceeds baseline ${baseline}`]
      : [];
  });
}

describe('translation coverage', () => {
  const english = readLocale('en');

  for (const locale of translatedLocales) {
    it(`${locale} is not an English catalog copy`, () => {
      const translated = readLocale(locale);
      const duplicates = [...english].filter(
        ([key, value]) => translated.get(key) === value,
      );

      expect(
        duplicates.length / english.size,
        duplicates
          .slice(0, 25)
          .map(([key]) => key)
          .join('\n'),
      ).toBeLessThan(0.2);
    });

    it(`${locale} does not exceed reviewed namespace duplicate baselines`, () => {
      const translated = readLocale(locale);
      const baselines = namespaceDuplicateBaselines[locale];
      const namespaces = [
        ...new Set([...english.keys()].map((key) => key.slice(0, key.indexOf(':')))),
      ].sort();

      expect(Object.keys(baselines).sort()).toEqual(namespaces);
      const regressions = namespaceDuplicateRegressions(
        english,
        translated,
        baselines,
      );
      expect(regressions, regressions.join('\n')).toEqual([]);
    });
  }
});

describe('translation coverage guard helpers', () => {
  it('rejects a namespace whose exact-English duplicates exceed its baseline', () => {
    const english = new Map([
      ['settings.json:title', 'Settings'],
      ['settings.json:save', 'Save'],
    ]);
    const translated = new Map([
      ['settings.json:title', 'Settings'],
      ['settings.json:save', 'Save'],
    ]);

    expect(
      namespaceDuplicateRegressions(english, translated, {
        'settings.json': 1,
      }),
    ).toEqual(['settings.json: 2 exact-English duplicates exceeds baseline 1']);
  });
});
