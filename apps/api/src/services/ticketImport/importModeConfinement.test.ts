/**
 * #8313 (spec §4.1, §9): import mode suppresses notifications, so a live
 * write that passed it by mistake would silently drop them. Production code
 * outside services/ticketImport/ may neither build an import mode nor mint an
 * OpenWindow nor take the window's write lock.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(__dirname, '..', '..');

function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) productionSources(path, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

const FILES = productionSources(SRC_ROOT).map((path) => ({
  path: relative(SRC_ROOT, path).split(sep).join('/'),
  source: readFileSync(path, 'utf8'),
}));

function offenders(pattern: RegExp, allowed: (path: string) => boolean): string[] {
  return FILES.filter((f) => pattern.test(f.source) && !allowed(f.path)).map((f) => f.path);
}

const inTicketImport = (path: string) => path.startsWith('services/ticketImport/');

describe('import mode is reachable only through services/ticketImport/', () => {
  it('scans the API source tree', () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES.some((f) => f.path === 'services/ticketService.ts')).toBe(true);
  });

  it("confines the `kind: 'import'` literal to services/ticketImport/ (and the type's own definition)", () => {
    expect(offenders(/kind:\s*['"]import['"]/, (p) => inTicketImport(p) || p === 'services/ticketWriteMode.ts')).toEqual([]);
  });

  it('mints an OpenWindow only in the window lock', () => {
    expect(offenders(/as\s+(unknown\s+as\s+)?OpenWindow\b/, (p) => p === 'services/ticketImport/windowLock.ts')).toEqual([]);
  });

  it('takes the window write lock only from the import writer', () => {
    expect(offenders(/lockOpenWindowForWrite\s*\(/, (p) => p === 'services/ticketImport/windowLock.ts' || p === 'services/ticketImport/importWriter.ts')).toEqual([]);
  });

  it('the patterns match what they are meant to (self-check)', () => {
    expect(/kind:\s*['"]import['"]/.test("({ kind: 'import', window, at })")).toBe(true);
    expect(/as\s+(unknown\s+as\s+)?OpenWindow\b/.test('} as unknown as OpenWindow;')).toBe(true);
  });
});
