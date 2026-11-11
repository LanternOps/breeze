import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Portal registration W5 (#11382, plan D3). `breeze.org_merge = on` exempts a
 * repoint from the customer_email_domains clear-on-repoint trigger, so it keeps
 * a domain verification across an org move. Only the org merge Phase B
 * transaction may set it; any other writer would carry a proof to an org that
 * never earned it.
 */
const SRC = join(__dirname, '..');
const ALLOWED = ['services/orgMerge.ts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      walk(p, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('breeze.org_merge GUC', () => {
  it('only services/orgMerge.ts sets breeze.org_merge', () => {
    const setters = walk(SRC)
      .filter((file) => readFileSync(file, 'utf8').includes('breeze.org_merge'))
      .map((file) => relative(SRC, file).split('\\').join('/'));
    expect(setters).toEqual(ALLOWED);
  });
});
