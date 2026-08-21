import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../locales');
const translatedLocales = ['pt-BR', 'es-419', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT', 'tr-TR'] as const;
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
    // +3: order breakdown — "SKU" is a locale-invariant acronym, and "Item" /
    // "{{count}} item" spell identically to English in pt-BR.
    // +1: partnerBillingSettings.defaults.documentPageSizeA4 — "A4" is the
    // ISO 216 paper size code, identical in every catalog.
    'billing.json': 51,
    // +1: richTextEditor.link — "Link" is the standard loanword in pt-BR.
    // +3: dashboard.vuln.kevCves — "{{count}} CVE(s)" is a locale-invariant
    // acronym (base/_one/_other).
    // +8: PsaConnectionForm credential placeholders — literal token formats
    // (api-key, company-id, personal-access-token, …) and the example address
    // are input-shape hints, not wording, so they are intentionally identical
    // in every catalog.
    'common.json': 101,
    'devices.json': 159,
    'discovery.json': 17,
    'integrations.json': 23,
    // +1: updateRingList.badges.manual — "Manual" is spelled identically in
    // pt-BR.
    'patches.json': 23,
    'peripherals.json': 4,
    'policies.json': 357,
    'portal.json': 3,
    // +1: the input placeholder "XXX-XXX-XXX" is a code-shape mask, not
    // wording — it is intentionally identical in every catalog.
    'quick.json': 1,
    'remote.json': 12,
    'reports.json': 39,
    // +2: automationRunHistory.scriptOutput — "stderr" is a stream name, not
    // wording, and "Script" is the standard loanword in this locale (#3162).
    'scripts.json': 57,
    'security.json': 140,
    // +1: the it-IT locale's self-name is intentionally identical in every catalog.
    // +1: bulkOrgImport.preview.status — "Status" is the same cognate in pt-BR
    // (already accepted for billing.json).
    'settings.json': 112,
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
    // +1: order breakdown — "SKU" is a locale-invariant acronym.
    // +1: partnerBillingSettings.defaults.documentPageSizeA4 — "A4" is the
    // ISO 216 paper size code, identical in every catalog.
    // 41 -> 40: `contracts.contractPax8Drawer.priceEach` is no longer a
    // duplicate; its "/ea" was genuinely untranslated, not a literal.
    'billing.json': 40,
    // +1: dashboard.vuln.kevCves_one — "{{count}} CVE" is a locale-invariant
    // acronym.
    // +8: PsaConnectionForm credential placeholders — literal token formats
    // (api-key, company-id, personal-access-token, …) and the example address
    // are input-shape hints, not wording, so they are intentionally identical
    // in every catalog.
    // +1: longTail.fleet.FindingsFeed.severities.error — "Error" is the correct
    // es-419 severity label and spells identically to English.
    // +1: nav.variables — "Variables" is the same word in Spanish.
    'common.json': 86,
    'devices.json': 115,
    'discovery.json': 17,
    'integrations.json': 31,
    // +1: updateRingList.badges.manual — "Manual" is spelled identically in
    // es-419.
    'patches.json': 16,
    'peripherals.json': 4,
    'policies.json': 241,
    'portal.json': 4,
    // +1: the input placeholder "XXX-XXX-XXX" is a code-shape mask, not
    // wording — it is intentionally identical in every catalog.
    'quick.json': 1,
    'remote.json': 12,
    'reports.json': 32,
    // +2: automationRunHistory.scriptOutput — "stderr" is a stream name, not
    // wording, and "Script" is the standard loanword in this locale (#3162).
    // +1: scriptForm.variables.button — "Variables" is the same word in Spanish
    // (same cognate already accepted for nav.variables).
    'scripts.json': 60,
    'security.json': 114,
    // +1: tenantVariablesPage.title — "Variables" is identical in Spanish.
    'settings.json': 115,
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
    // +1: order breakdown — "SKU" is a locale-invariant acronym.
    // +1: partnerBillingSettings.defaults.documentPageSizeA4 — "A4" is the
    // ISO 216 paper size code, identical in every catalog.
    'billing.json': 52,
    // +1: dashboard.vuln.kevCves_one — "{{count}} CVE" is a locale-invariant
    // acronym.
    // +8: PsaConnectionForm credential placeholders — literal token formats
    // (api-key, company-id, personal-access-token, …) and the example address
    // are input-shape hints, not wording, so they are intentionally identical
    // in every catalog.
    // +1: PsaConnectionForm.fields.secret — "Secret" is the identical French
    // term for this credential field (fr already uses "Secret client").
    // +1: nav.variables — "Variables" is identical in French.
    'common.json': 104,
    'devices.json': 136,
    'discovery.json': 15,
    'integrations.json': 38,
    'patches.json': 20,
    'peripherals.json': 9,
    'policies.json': 204,
    'portal.json': 4,
    // +1: the input placeholder "XXX-XXX-XXX" is a code-shape mask, not
    // wording — it is intentionally identical in every catalog.
    'quick.json': 1,
    'remote.json': 18,
    'reports.json': 43,
    // +2: automationRunHistory.scriptOutput — "stderr" is a stream name, not
    // wording, and "Script" is the standard loanword in this locale (#3162).
    // +1: scriptForm.variables.button — "Variables" is identical in French
    // (same cognate already accepted for nav.variables).
    'scripts.json': 63,
    'security.json': 144,
    // +1: orgDefaultsEditor.enrollment.capMinutes — "{{minutes}} minutes" is
    // spelled identically in French.
    // +2: bulkOrgImport.mapping.site + preview.site — "Site" is the same word
    // in French.
    // +3: tenant variables page — "Variables", "Description" and "Secret"
    // are spelled identically in French.
    // +1: officeAddinBindings.actions — "Actions" is the same word in French
    // and is already the reviewed value for the eight other table
    // action-column headers in this namespace.
    'settings.json': 151,
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
    // +1: order breakdown — "SKU" is a locale-invariant acronym.
    // +1: partnerBillingSettings.defaults.documentPageSizeA4 — "A4" is the
    // ISO 216 paper size code, identical in every catalog.
    'billing.json': 52,
    // +1: dashboard.vuln.kevCves_one "{{count}} CVE" is a locale-invariant
    // acronym.
    // +8: PsaConnectionForm credential placeholders — literal token formats
    // (api-key, company-id, personal-access-token, …) and the example address
    // are input-shape hints, not wording, so they are intentionally identical
    // in every catalog.
    // +1: PsaConnectionForm.fields.secret — "Secret" is the identical French
    // term for this credential field (fr already uses "Secret client").
    // +1: nav.variables — "Variables" is identical in French.
    'common.json': 106,
    'devices.json': 136,
    'discovery.json': 15,
    'integrations.json': 40,
    'patches.json': 20,
    'peripherals.json': 9,
    'policies.json': 204,
    'portal.json': 4,
    // +1: the input placeholder "XXX-XXX-XXX" is a code-shape mask, not
    // wording — it is intentionally identical in every catalog.
    'quick.json': 1,
    'remote.json': 17,
    'reports.json': 43,
    // +2: automationRunHistory.scriptOutput — "stderr" is a stream name, not
    // wording, and "Script" is the standard loanword in this locale (#3162).
    // +1: scriptForm.variables.button — "Variables" is identical in French
    // (same cognate already accepted for nav.variables).
    'scripts.json': 63,
    'security.json': 144,
    // +1: orgDefaultsEditor.enrollment.capMinutes — "{{minutes}} minutes" is
    // spelled identically in French.
    // +2: bulkOrgImport.mapping.site + preview.site — "Site" is the same word
    // in French.
    // +3: tenant variables page — "Variables", "Description" and "Secret"
    // are spelled identically in French.
    // +1: officeAddinBindings.actions — "Actions" is the same word in French
    // and is already the reviewed value for the other table action-column
    // headers in this namespace.
    'settings.json': 156,
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
    // +2: order breakdown — "SKU" is a locale-invariant acronym and "Markup" is
    // the loanword the quote editor already uses in de-DE.
    // +1: partnerBillingSettings.defaults.documentPageSizeA4 — "A4" is the
    // ISO 216 paper size code, identical in every catalog.
    'billing.json': 38,
    // +1: richTextEditor.link — "Link" is the standard loanword in de-DE.
    // +3: dashboard.vuln.kevCves — "{{count}} CVE(s)" is a locale-invariant
    // acronym (base/_one/_other).
    // +8: PsaConnectionForm credential placeholders — literal token formats
    // (api-key, company-id, personal-access-token, …) and the example address
    // are input-shape hints, not wording, so they are intentionally identical
    // in every catalog.
    'common.json': 102,
    'devices.json': 146,
    'discovery.json': 26,
    'integrations.json': 43,
    // +1: updateRingList.badges.os — "OS: {{severities}}" is an acronym plus an
    // interpolation; German uses the same "OS" acronym.
    'patches.json': 23,
    'peripherals.json': 4,
    'policies.json': 205,
    'portal.json': 4,
    // +1: the input placeholder "XXX-XXX-XXX" is a code-shape mask, not
    // wording — it is intentionally identical in every catalog.
    'quick.json': 1,
    'remote.json': 14,
    'reports.json': 53,
    // +1: automationRunHistory.scriptOutput.stderr — a stream name, not
    // wording; intentionally identical in every catalog (#3162).
    'scripts.json': 54,
    'security.json': 166,
    // +1: bulkOrgImport.preview.status — "Status" is the German word too.
    'settings.json': 167,
    'tickets.json': 13,
    'vulnerabilities.json': 20,
  },
  'it-IT': {
    'admin.json': 31,
    'ai.json': 12,
    'alerts.json': 57,
    'auth.json': 21,
    'backup.json': 45,
    // +1: unassigned.qtyPrice "{{qty}} × {{price}}" is two interpolations plus a
    // multiplication sign with no wording to translate.
    // +1: order breakdown — "SKU" is a locale-invariant acronym.
    // +1: partnerBillingSettings.defaults.documentPageSizeA4 — "A4" is the
    // ISO 216 paper size code, identical in every catalog.
    'billing.json': 32,
    // +1: dashboard.vuln.kevCves_one "{{count}} CVE" is a locale-invariant
    // acronym.
    // +8: PsaConnectionForm credential placeholders — literal token formats
    // (api-key, company-id, personal-access-token, …) and the example address
    // are input-shape hints, not wording, so they are intentionally identical
    // in every catalog.
    'common.json': 105,
    'devices.json': 144,
    'discovery.json': 22,
    'integrations.json': 81,
    'patches.json': 18,
    'peripherals.json': 4,
    'policies.json': 363,
    'portal.json': 9,
    // +1: the input placeholder "XXX-XXX-XXX" is a code-shape mask, not
    // wording — it is intentionally identical in every catalog.
    'quick.json': 1,
    'remote.json': 14,
    'reports.json': 51,
    // +2: automationRunHistory.scriptOutput — "stderr" is a stream name, not
    // wording, and "Script" is the standard loanword in this locale (#3162).
    'scripts.json': 59,
    'security.json': 163,
    'settings.json': 156,
    'tickets.json': 6,
    'vulnerabilities.json': 17,
  },
  'tr-TR': {
    'admin.json': 14,
    'ai.json': 1,
    'alerts.json': 25,
    'auth.json': 14,
    'backup.json': 25,
    // +1: the quote/invoice bulk-result strings ("{{succeeded}} {{verb}}") are
    // pure interpolation with no prose to translate, so they are necessarily
    // identical to English. They arrived from #3501 after tr-TR (#3497) forked,
    // which is why the PR was green on its base and this baseline was short on
    // main. 18 -> 17 because `contracts.contractPax8Drawer.priceEach` is no
    // longer a duplicate: it was genuinely untranslated, not a literal.
    'billing.json': 17,
    'common.json': 48,
    'devices.json': 77,
    'discovery.json': 9,
    'integrations.json': 22,
    'patches.json': 11,
    'peripherals.json': 4,
    // +8: package-manager software library — OS names ("Windows", "macOS",
    // "Linux" in both addPackageModal and deploymentWizard) and package-manager
    // identifiers ("winget", "Homebrew cask", "Homebrew formula") are proper
    // nouns and command-line tokens, so they are intentionally identical in
    // every catalog.
    'policies.json': 123,
    'portal.json': 2,
    'quick.json': 1,
    'remote.json': 4,
    'reports.json': 31,
    'scripts.json': 38,
    'security.json': 86,
    'settings.json': 64,
    'tickets.json': 11,
    'vulnerabilities.json': 11,
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
