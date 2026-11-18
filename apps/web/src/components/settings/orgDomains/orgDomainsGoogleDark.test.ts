import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// W7 ships dark: the Domains tab renders these two strings whatever the
// deployment can run, so they must not name Google sign-in (which a deployment
// without a Google client never offers).
const LOCALES = ['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'];

describe('orgDomains copy names no sign-in provider', () => {
  it.each(LOCALES)('%s: description and remove message do not mention Google', (locale) => {
    const settings = JSON.parse(readFileSync(`src/locales/${locale}/settings.json`, 'utf8'));
    expect(settings.orgDomains.description).not.toMatch(/google/i);
    expect(settings.orgDomains.verify.removeMessage).not.toMatch(/google/i);
  });
});
