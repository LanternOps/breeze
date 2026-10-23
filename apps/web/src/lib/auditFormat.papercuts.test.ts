import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditActionFilterOptions, formatAuditAction } from './auditFormat';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../locales');
const LOCALES = ['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'];

function actions(locale: string): Record<string, string> {
  const admin = JSON.parse(readFileSync(join(localesDir, locale, 'admin.json'), 'utf-8')) as {
    audit: { actions: Record<string, string> };
  };
  return admin.audit.actions;
}

// #9672
describe('audit catalog papercuts (#9672)', () => {
  it('labels script.execute', () => {
    expect(formatAuditAction('script.execute')).toBe('Ran script on device');
  });

  it('ships a script.execute label in every locale', () => {
    for (const locale of LOCALES) {
      expect(actions(locale)['script.execute'], locale).toBeTruthy();
    }
  });

  it('offers real dotted-code prefixes as action filter options, not bare verbs', () => {
    const options = auditActionFilterOptions();
    for (const wanted of ['user', 'device', 'script', 'agent.command']) {
      expect(options, wanted).toContain(wanted);
    }
    for (const verb of ['login', 'update', 'delete', 'create', 'export', 'access']) {
      expect(options, verb).not.toContain(verb);
    }
  });

  it('every option is a prefix of at least one real catalog code', () => {
    const codes = Object.keys(actions('en'));
    for (const option of auditActionFilterOptions()) {
      expect(
        codes.some((c) => c === option || c.startsWith(`${option}.`)),
        option,
      ).toBe(true);
    }
  });

  it('settings copy says logs are forwarded as each device reports them', () => {
    const settings = JSON.parse(readFileSync(join(localesDir, 'en', 'settings.json'), 'utf-8')) as {
      orgEventLogSettings: { enable: { description: string } };
    };
    expect(settings.orgEventLogSettings.enable.description).toContain('as each device reports them');
    expect(settings.orgEventLogSettings.enable.description).not.toContain('recurring');
  });
});
