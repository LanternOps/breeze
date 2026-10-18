import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

// ============================================================================
// EDR W03 (#8167) — response actions have ONE door, by construction.
//
// Source scans, not a review checklist (aiDispatch.contract.test.ts template):
//   1. only services/edrProviders/actions.ts inserts into edr_actions;
//   2. only actions.ts (and the adapters that implement it) touch
//      performAction — the status/reconcile job can never re-send;
//   3. AI tool modules reach actions only through dispatchEdrAction, never an
//      adapter directly;
//   4. the customer portal never reaches EDR actions.
// Each scan asserts a non-empty file set so an empty walk cannot read green.
// ============================================================================

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(REPO_ROOT, f).split(path.sep).join('/');
const API_FILES = [...walk(path.join(REPO_ROOT, 'apps/api/src')), ...walk(path.join(REPO_ROOT, 'ee'))].map(rel);
const PORTAL_FILES = walk(path.join(REPO_ROOT, 'apps/portal/src')).map(rel);
const cache = new Map<string, string>();
const read = (f: string) => {
  let s = cache.get(f);
  if (s === undefined) {
    s = readFileSync(path.join(REPO_ROOT, f), 'utf8');
    cache.set(f, s);
  }
  return s;
};

const INSERT_DOOR = 'apps/api/src/services/edrProviders/actions.ts';
/** Files that IMPLEMENT performAction (vendor adapters). They define it; they never call another's. */
const ADAPTER_FILE = /^apps\/api\/src\/services\/edrProviders\/[^/]+\/adapter\.ts$/;

describe('EDR action chokepoints', () => {
  it('scans a real file set', () => {
    expect(API_FILES.length).toBeGreaterThan(500);
    expect(API_FILES).toContain(INSERT_DOOR);
    expect(PORTAL_FILES.length).toBeGreaterThan(10);
  });

  it('only actions.ts inserts into edr_actions', () => {
    const re = /\.\s*insert\s*\(\s*edrActions\b|INSERT\s+INTO\s+(?:public\.)?edr_actions\b/i;
    expect(re.test(read(INSERT_DOOR)), 'the door itself must match the pattern').toBe(true);
    expect(API_FILES.filter((f) => f !== INSERT_DOOR && re.test(read(f)))).toEqual([]);
  });

  it('performAction is called only from actions.ts (status/reconcile code never re-sends)', () => {
    const re = /\.performAction\b\s*(?:!\s*)?(?:\?\.)?\s*\(/;
    expect(re.test(read(INSERT_DOOR)), 'the door itself must call performAction').toBe(true);
    expect(API_FILES.filter((f) => f !== INSERT_DOOR && !ADAPTER_FILE.test(f) && re.test(read(f)))).toEqual([]);
  });

  it('the status/reconcile job never mentions performAction at all', () => {
    const f = 'apps/api/src/services/edrProviders/actionStatus.ts';
    expect(API_FILES).toContain(f);
    expect(read(f)).not.toMatch(/performAction/);
  });

  it('AI tool modules reach actions only through dispatchEdrAction', () => {
    const aiFiles = API_FILES.filter((f) => /^apps\/api\/src\/services\/aiTools[^/]*\.ts$/.test(f));
    expect(aiFiles.length).toBeGreaterThan(10);
    const offenders = aiFiles.filter((f) => {
      const s = read(f);
      return /edrProviders\/(?:registry|bitdefender|actionStatus)/.test(s) || /\bperformAction\b|\bgetEdrProvider\b/.test(s);
    });
    expect(offenders).toEqual([]);
  });

  it('W03 PR-B: the push path (webhook, hint store, verifier) can only schedule a read sync', () => {
    const pushFiles = [
      'apps/api/src/routes/webhooks/edr.ts',
      'apps/api/src/services/edrProviders/hints.ts',
      'apps/api/src/services/edrProviders/bitdefender/push.ts',
    ];
    for (const f of pushFiles) expect(API_FILES).toContain(f);
    // No action door, no adapter write, no detection persistence, no vendor client.
    const forbidden = /edrProviders\/(?:actions|actionStatus|persist)\b|dispatchEdrAction|\bperformAction\b|\bpersistDetections\b|bitdefender\/client\b|\.insert\s*\(|INSERT\s+INTO|\bedr_detections\b|\bedr_actions\b/;
    expect(pushFiles.filter((f) => forbidden.test(read(f)))).toEqual([]);
  });

  it('the portal never reaches EDR actions', () => {
    const re = /edrProviders\/actions\b|\/edr\/actions\b|dispatchEdrAction|edrActionRoutes/;
    const portalSide = [
      ...PORTAL_FILES,
      ...API_FILES.filter((f) => f.includes('/routes/portal/') || f.includes('/services/portal/')),
    ];
    expect(portalSide.length).toBeGreaterThan(10);
    expect(portalSide.filter((f) => re.test(read(f)))).toEqual([]);
  });
});
