import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The System Restore ledger records requests and observations, never a promise
// of recoverability. The English badge tests pin that wording; this pins it in
// every shipped locale, where an accidental "restorable"/"protected" would
// otherwise pass unnoticed.
const dir = dirname(fileURLToPath(import.meta.url));
const locales = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const BANNED = [
  'rollback available', 'roll back', 'restorable', 'recoverable', 'protected', 'safe to restore',
  'wiederherstellbar', 'geschützt', 'restaurable', 'protegido', 'récupérable', 'restaurable', 'protégé',
  'ripristinabile', 'protetto', 'recuperável', 'protegido', 'geri yüklenebilir', 'korumalı',
];

function leaves(o: unknown, out: string[] = []): string[] {
  if (typeof o === 'string') out.push(o);
  else if (o && typeof o === 'object') Object.values(o).forEach((v) => leaves(v, out));
  return out;
}

describe('restorePoints locale language', () => {
  it('ships in every locale folder', () => {
    expect(locales.length).toBeGreaterThanOrEqual(8);
  });

  it.each(locales)('%s badge copy makes no recoverability promise', (locale) => {
    const json = JSON.parse(readFileSync(join(dir, locale, 'restorePoints.json'), 'utf8'));
    for (const text of leaves(json.badge)) {
      const lower = text.toLowerCase();
      for (const term of BANNED) expect(lower, `${locale}: "${text}"`).not.toContain(term);
    }
  });

  it.each(locales)('%s keeps a non-empty disclaimer', (locale) => {
    const json = JSON.parse(readFileSync(join(dir, locale, 'restorePoints.json'), 'utf8'));
    expect(String(json.list.disclaimer).length).toBeGreaterThan(40);
  });
});
