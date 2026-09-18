import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAIL_PURPOSES, type MailPurpose } from './mailPurposes';

const SRC_DIR = join(__dirname, '..', '..');
const REGISTRY_FILE = `services${sep}emailDomains${sep}mailPurposes.ts`;

interface ScannedFile {
  path: string;
  source: string;
}

/**
 * The "has a send site" rule itself, as a pure function over already-read
 * sources — independent of the filesystem so it can be exercised against
 * both the real corpus and a synthetic, planted one (the negative control
 * below).
 */
function findUnreferencedPurposes(purposes: readonly MailPurpose[], files: ScannedFile[]): MailPurpose[] {
  return purposes.filter((purpose) => !files.some(({ source }) => source.includes(`'${purpose}'`)));
}

function productionTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(absolute);
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [absolute];
  });
}

function realCorpus(): ScannedFile[] {
  return productionTypeScriptFiles(SRC_DIR)
    .filter((absolute) => relative(SRC_DIR, absolute) !== REGISTRY_FILE)
    .map((absolute) => ({ path: relative(SRC_DIR, absolute), source: readFileSync(absolute, 'utf8') }));
}

describe('every mail purpose has a send site (spec §8.1, property 2)', () => {
  it('has no dead registry entries', () => {
    const files = realCorpus();

    // Control first: the corpus is real and excludes the registry, so an
    // all-green result cannot come from having scanned nothing.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.source.includes(`'ops.alert'`))).toBe(true);

    // A purpose nobody sends is a classification nobody reviewed. Either wire
    // up the send site or delete the entry — do not allowlist it here.
    expect(findUnreferencedPurposes(Object.keys(MAIL_PURPOSES) as MailPurpose[], files)).toEqual([]);
  }, 30000);

  // Negative control: a registry key present in NO source must be reported —
  // proves the matcher actually flags something rather than vacuously
  // returning [] regardless of what it's given.
  it('flags a registry key that appears in no source', () => {
    const files = [{ path: 'services/somewhere.ts', source: "purpose: 'ops.alert'" }];
    const unreferenced = findUnreferencedPurposes(['ops.alert', 'ghost.purpose'] as MailPurpose[], files);
    expect(unreferenced).toEqual(['ghost.purpose']);
  });
});
