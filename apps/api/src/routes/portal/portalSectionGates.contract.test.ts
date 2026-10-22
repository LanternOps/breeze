import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PORTAL_SECTION_GATES } from './featureFlags';

const dir = __dirname;
const indexSrc = readFileSync(join(dir, 'index.ts'), 'utf8');

// Route files that export a `portal*Routes` router but are NOT a strict-flag
// section row: each must say why, so a new section route cannot ship ungated
// by accident (#9350).
const NOT_A_GATED_SECTION: Record<string, string> = {
  'approvals.ts': 'gated by enable_tickets (portalTicketsEnabledMiddleware)',
  'network.ts': 'fail-open availability response (dataStatus not_enabled), not a 403 gate',
  'paymentMethods.ts': 'autopay surface with its own gate (requireAutopayEnabled), not a visibility flag',
  'trustPage.ts': 'permission gate (requirePortalTrustPageEditor), not a visibility flag',
  'trustPageLink.ts': 'mounted under the dashboard row (/dashboard/*)',
};

const routeFiles = readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .filter((f) => /export const portal\w+Routes\b/.test(readFileSync(join(dir, f), 'utf8')));

describe('portal section gate table (#9350)', () => {
  it('every portal section router has a gate-table row or a documented exemption', () => {
    const covered = new Set<string>(PORTAL_SECTION_GATES.map((g) => g.routeFile));
    const missing = routeFiles.filter((f) => !covered.has(f) && !(f in NOT_A_GATED_SECTION));
    expect(missing).toEqual([]);
  });

  it('every gate-table row points at a router file that exists', () => {
    for (const g of PORTAL_SECTION_GATES) {
      expect(existsSync(join(dir, g.routeFile)), g.key).toBe(true);
    }
  });

  it('exemptions do not shadow table rows', () => {
    for (const g of PORTAL_SECTION_GATES) expect(NOT_A_GATED_SECTION).not.toHaveProperty(g.routeFile);
  });

  it('keys and path prefixes are unique and every row names at least one flag', () => {
    const keys = PORTAL_SECTION_GATES.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
    const prefixes = PORTAL_SECTION_GATES.map((g) => g.pathPrefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const g of PORTAL_SECTION_GATES) expect(g.flags.length).toBeGreaterThan(0);
  });

  it('index.ts mounts gates from the table, not from hand-written strict gate calls', () => {
    const handWritten = indexSrc.match(/portalRoutes\.use\([^)]*createPortalFeatureGateStrict\(/g) ?? [];
    expect(handWritten).toEqual([]);
    expect(indexSrc).toContain('PORTAL_SECTION_GATES');
    // customMount rows are mounted by hand but must still use the table's gate.
    for (const g of PORTAL_SECTION_GATES.filter((r) => 'customMount' in r)) {
      expect(indexSrc, g.key).toContain(`portalSectionGate('${g.key}')`);
    }
    expect(indexSrc).not.toMatch(/createPortalFeatureGateStrict/);
  });
});
