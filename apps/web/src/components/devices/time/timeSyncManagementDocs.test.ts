import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), 'utf8');
it('documents management without claiming queue acceptance is enforcement', () => {
  const docs = read('../docs/src/content/docs/features/time-sync.mdx');
  for (const phrase of [
    'Configuration Policies',
    'overrides the site timezone',
    'Group Policy',
    'forest-root PDC',
    'Entra-only',
    'domain hierarchy',
    'one hour',
    'does not restore',
    'agent update',
    'Queued is not applied',
  ])
    expect(docs).toContain(phrase);
});
it('ships the same management, action and result keys in all eight locales', () => {
  const english = JSON.parse(read('src/locales/en/devices.json')).timeSync;
  for (const locale of [
    'de-DE',
    'es-419',
    'fr-CA',
    'fr-FR',
    'it-IT',
    'pt-BR',
    'tr-TR',
  ]) {
    const copy = JSON.parse(
      read(`src/locales/${locale}/devices.json`),
    ).timeSync;
    for (const section of ['management', 'actions', 'enforcement'])
      expect(Object.keys(copy[section]).sort()).toEqual(
        Object.keys(english[section]).sort(),
      );
  }
  expect(english.management.pinOverrides).toBe(
    'The pinned timezone overrides the site timezone.',
  );
  expect(english.management.policySource).toContain(
    'overrides the site timezone',
  );
  expect(english.actions.offline).toContain('1 hour');
});
