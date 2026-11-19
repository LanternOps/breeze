import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMPORT_ERROR_CODES, RUN_ISSUE_KINDS, RUN_STOP_REASONS } from './ticketImportApi';

/**
 * Every stop reason, refusal code and issue kind the API can hand the wizard
 * has words in every locale (#8313 W6). The lists are fixtures that name the
 * API files they come from (ticketImportApi.ts); a new reason there without a
 * label here fails this test.
 */
const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../locales');
const locales = readdirSync(localesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

function catalog(locale: string): Record<string, any> {
  return JSON.parse(readFileSync(join(localesDir, locale, 'ticketImport.json'), 'utf8'));
}

describe('ticket import labels (#8313 W6)', () => {
  it('covers every locale folder', () => {
    expect(locales).toEqual(expect.arrayContaining(['en', 'pt-BR', 'es-419', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT', 'tr-TR']));
  });

  it.each(locales)('%s labels every stop reason the runner writes, and source_<status>', (locale) => {
    const stop = catalog(locale).run.stopReason;
    for (const reason of RUN_STOP_REASONS) expect(stop[reason], `${locale} run.stopReason.${reason}`).toEqual(expect.any(String));
    expect(stop.sourceHttp).toContain('{{status}}');
  });

  it.each(locales)('%s labels every refusal code the routes answer', (locale) => {
    const errors = catalog(locale).errors;
    for (const code of IMPORT_ERROR_CODES) expect(errors[code], `${locale} errors.${code}`).toEqual(expect.any(String));
  });

  it.each(locales)('%s labels every issue kind', (locale) => {
    const kinds = catalog(locale).issues.kind;
    for (const kind of RUN_ISSUE_KINDS) expect(kinds[kind], `${locale} issues.kind.${kind}`).toEqual(expect.any(String));
  });
});
