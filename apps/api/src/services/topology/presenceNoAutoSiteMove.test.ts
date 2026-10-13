import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Hard rule (spec S§2, Global Constraints): no automatic site reassignment, ever. Wrong-site suggestions are
 * suggestions; the only write to devices.site_id is a technician's explicit PATCH /devices/:id. This pins, at source
 * level, that none of the presence/suggestion modules (evaluator, eligibility, worker, read, confirmation route, demo
 * seed library, W2/W3 migrations) writes devices.site_id: no `UPDATE devices ... SET site_id`, no Drizzle
 * `.update(devices).set({ siteId })`, and no trigger assignment to NEW.site_id.
 */
const API = resolve(__dirname, '../../..');
const MODULES = [
  'src/services/topology/presenceEvaluator.ts',
  'src/services/topology/presenceEligibility.ts',
  'src/services/topology/presenceClassifier.ts',
  'src/services/topology/presenceInputs.ts',
  'src/services/topology/presenceRead.ts',
  'src/jobs/topologyPresenceWorker.ts',
  'src/routes/devices/siteAssignmentConfirmation.ts',
  'scripts/seed-topology-demo.lib.ts',
  'migrations/2026-12-25-140000-topology-presence-read-model.sql',
  'migrations/2026-12-26-190000-topology-presence-days-and-confirmation.sql',
];

/** Every SET clause of an UPDATE on devices, up to its WHERE/RETURNING/statement end. */
function deviceUpdateSetClauses(source: string): string[] {
  const out: string[] = [];
  const re = /UPDATE\s+(?:public\.)?devices\b(?:\s+(?:AS\s+)?\w+)?\s+SET\s+([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|;|`)/gi;
  for (let m = re.exec(source); m; m = re.exec(source)) out.push(m[1]!);
  return out;
}

export function findSiteIdWrites(source: string): string[] {
  const hits: string[] = [];
  for (const clause of deviceUpdateSetClauses(source)) if (/\bsite_id\s*=/i.test(clause)) hits.push(`UPDATE devices SET ${clause.trim()}`);
  for (const m of source.matchAll(/\.update\(\s*devices\s*\)\s*\.set\(\s*\{([^}]*)\}/g)) if (/\bsiteId\b/.test(m[1]!)) hits.push(m[0]);
  for (const m of source.matchAll(/NEW\.site_id\s*:=/gi)) hits.push(m[0]);
  return hits;
}

describe('presence modules never write devices.site_id', () => {
  it('the detector finds each write shape (control)', () => {
    expect(findSiteIdWrites('UPDATE devices SET site_id = $1 WHERE id = $2')).toHaveLength(1);
    expect(findSiteIdWrites('UPDATE public.devices d SET hostname = x, site_id = y;')).toHaveLength(1);
    expect(findSiteIdWrites('db.update(devices).set({ displayName: null, siteId: target })')).toHaveLength(1);
    expect(findSiteIdWrites('NEW.site_id := OLD.site_id;')).toHaveLength(1);
    // Not writes: a confirmation-only update guarded on site_id, a join, the reset trigger.
    expect(findSiteIdWrites('UPDATE devices SET site_assignment_confirmed_at = now() WHERE site_id = $1')).toEqual([]);
    expect(findSiteIdWrites('db.update(devices).set({ siteAssignmentConfirmedAt: null }).where(eq(devices.siteId, s))')).toEqual([]);
    expect(findSiteIdWrites('JOIN devices d ON d.site_id = b.site_id')).toEqual([]);
    expect(findSiteIdWrites('NEW.site_assignment_confirmed_at := NULL;')).toEqual([]);
  });

  it.each(MODULES)('%s', (file) => {
    expect(findSiteIdWrites(readFileSync(resolve(API, file), 'utf8'))).toEqual([]);
  });
});
