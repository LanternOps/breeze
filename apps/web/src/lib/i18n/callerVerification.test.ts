import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const locales = ['en','de-DE','es-419','fr-CA','fr-FR','it-IT','pt-BR','tr-TR'];
it.each(locales)('%s supplies request-confirmation and independent callback copy', locale => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '../../locales', locale, 'callerVerification.json');
  const messages = JSON.parse(readFileSync(file, 'utf8')).public;
  expect(messages.request).toContain('{{technician}}');
  expect(messages.request).toContain('{{partner}}');
  expect(messages.reset_password).toContain('{{target}}');
  expect(messages.disable_user).toContain('{{target}}');
  expect(messages.caution).toContain('{{partner}}');
  expect(messages.caution.length).toBeGreaterThan(35);
  expect(messages.notMe.length).toBeGreaterThan(3);
});
