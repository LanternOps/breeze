import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAIL_PURPOSES, type MailPurpose } from './mailPurposes';

const SRC_DIR = join(__dirname, '..', '..');
const REGISTRY_FILE = `services${sep}emailDomains${sep}mailPurposes.ts`;

function productionTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(absolute);
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [absolute];
  });
}

describe('every mail purpose has a send site (spec §8.1, property 2)', () => {
  it('has no dead registry entries', () => {
    const sources = productionTypeScriptFiles(SRC_DIR)
      .filter((absolute) => relative(SRC_DIR, absolute) !== REGISTRY_FILE)
      .map((absolute) => readFileSync(absolute, 'utf8'));

    // Control first: the corpus is real and excludes the registry, so an
    // all-green result cannot come from having scanned nothing.
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.some((s) => s.includes(`'ops.alert'`))).toBe(true);

    const unreferenced = (Object.keys(MAIL_PURPOSES) as MailPurpose[])
      .filter((purpose) => !sources.some((source) => source.includes(`'${purpose}'`)));

    // A purpose nobody sends is a classification nobody reviewed. Either wire
    // up the send site or delete the entry — do not allowlist it here.
    expect(unreferenced).toEqual([]);
  }, 30000);
});
