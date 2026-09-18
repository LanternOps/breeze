import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(__dirname, '..');

/**
 * `deliverRaw` takes an explicit From and asks no questions. It exists for the
 * partner-lane adapters (`static`, `fake`) and the domain test send, which
 * legitimately hand a custom sender to the platform transport (plan index
 * amendment 2). Anywhere else it is a hole straight through the sender
 * contract: a call site that picks its own From has not been classified, and
 * G5's compile-time guard stops meaning anything.
 *
 * Test files are exempt: a suite that mocks or asserts on deliverRaw is not a
 * production sender.
 */
const ALLOWED = new Set(['services/email.ts']);
const ALLOWED_PREFIX = `services${sep}emailDomains${sep}`;

interface ScannedFile {
  path: string;
  source: string;
}

/**
 * The scope rule itself, as a pure function over already-read sources — kept
 * independent of the filesystem so it can be exercised against both the real
 * corpus and a synthetic, planted one (the negative control below).
 */
function findDeliverRawScopeViolations(files: ScannedFile[]): string[] {
  return files.flatMap(({ path, source }) => {
    if (ALLOWED.has(path.split(sep).join('/')) || path.startsWith(ALLOWED_PREFIX)) return [];
    return /\bdeliverRaw\s*\(/.test(source) ? [path] : [];
  });
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
  return productionTypeScriptFiles(SRC_DIR).map((absolute) => ({
    path: relative(SRC_DIR, absolute),
    source: readFileSync(absolute, 'utf8'),
  }));
}

describe('deliverRaw scope contract', () => {
  it('is called from services/email.ts and services/emailDomains/** and nowhere else', () => {
    expect(findDeliverRawScopeViolations(realCorpus())).toEqual([]);
  }, 30000);

  // Control: the scan actually reads files and the pattern actually matches,
  // so an empty result means "nobody calls it", not "nothing was scanned".
  it('does find deliverRaw where it is allowed to be', () => {
    const emailService = readFileSync(join(SRC_DIR, 'services', 'email.ts'), 'utf8');
    expect(/\bdeliverRaw\s*\(/.test(emailService)).toBe(true);
    expect(productionTypeScriptFiles(SRC_DIR).length).toBeGreaterThan(100);
  }, 30000);

  // Negative control: a planted violation in a disallowed file must be
  // caught by the matcher ITSELF, not just by the absence of one in the real
  // corpus — proves the guard is actually looking for violations rather than
  // vacuously passing because nothing happens to trip it today.
  it('reports a planted deliverRaw call outside the allowed paths', () => {
    const planted = [
      { path: 'services/opsAlerts.ts', source: "await this.deliverRaw({ from: 'x' });" },
      { path: 'services/email.ts', source: "await this.deliverRaw({ from: 'x' });" },
      { path: `services${sep}emailDomains${sep}adapters${sep}resend.ts`, source: 'deliverRaw(msg);' },
    ];
    expect(findDeliverRawScopeViolations(planted)).toEqual(['services/opsAlerts.ts']);
  });
});
