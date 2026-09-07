import { describe, it, expect, vi, beforeEach } from 'vitest';

// `loadPolicyLocalPatchConfig` becomes an EFFECTIVE loader (#5080 W02): once the
// patch scheduler enumerates through the view, a child policy that inherits its
// parent's patch link is discovered as a candidate — and then this loader,
// reading the authored table, would return null and silently skip it. The whole
// point of the wave is that it must return the parent's patch config, under the
// child's policy id.
//
// Deliberately NOT mocking '../db/schema', so the join target is asserted by
// object identity against the real view.

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  // Required by readWithPartnerAxisVisibility, which the ring lookup runs
  // through. 'system' makes the partner-axis widening a no-op here.
  getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' as const })),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('../routes/patches/helpers', () => ({
  resolvePartnerIdForOrg: vi.fn(async () => 'partner-1'),
}));

import { loadPolicyLocalPatchConfig } from './configPolicyPatching';
import { db } from '../db';
import {
  configPolicyEffectiveFeatureLinks,
  configPolicyFeatureLinks,
} from '../db/schema';

const joined: unknown[] = [];

function chain(rows: unknown[]) {
  const c: any = { then: (resolve: (v: unknown) => void) => resolve(rows) };
  c.from = (t: unknown) => {
    joined.push(t);
    return c;
  };
  for (const m of ['innerJoin', 'leftJoin']) {
    c[m] = (t: unknown) => {
      joined.push(t);
      return c;
    };
  }
  for (const m of ['where', 'orderBy']) c[m] = () => c;
  c.limit = () => Promise.resolve(rows);
  return c;
}

// The parent authored the patch link; the child has none of its own, so through
// the view the child's effective patch link IS the parent's row — same link id,
// which is what keeps the config_policy_patch_settings join working.
const INHERITED_ROW = {
  configPolicyId: 'child-1',
  configPolicyName: 'A1 Child',
  orgId: 'org-a',
  partnerId: null,
  featureLinkId: 'fl-parent',
  featurePolicyId: 'ring-1',
  sourcePolicyId: 'parent-1',
  inherited: true,
  storedInlineSettings: null,
  patchSettings: null,
};

// resolvePatchPolicyReference issues its own lookup for the update ring.
const RING_ROW = {
  id: 'ring-1',
  partnerId: 'partner-1',
  kind: 'ring',
  name: 'Standard Ring',
  categoryRules: [],
  autoApprove: {},
};

beforeEach(() => {
  joined.length = 0;
  vi.mocked(db.select).mockReset();
});

describe('loadPolicyLocalPatchConfig — effective, not authored', () => {
  it('reads the effective view, never the authored table', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(chain([INHERITED_ROW]) as any)
      .mockReturnValueOnce(chain([RING_ROW]) as any);

    await loadPolicyLocalPatchConfig('child-1');

    expect(joined).toContain(configPolicyEffectiveFeatureLinks);
    expect(joined).not.toContain(configPolicyFeatureLinks);
  });

  it("returns the parent's patch link under the CHILD's policy id, flagged inherited", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(chain([INHERITED_ROW]) as any)
      .mockReturnValueOnce(chain([RING_ROW]) as any);

    const config = await loadPolicyLocalPatchConfig('child-1');

    expect(config).not.toBeNull();
    // The policy the scheduler is acting for is the child — that is whose
    // assignments resolve devices and whose id lands on the patch job.
    expect(config!.configPolicyId).toBe('child-1');
    // …but the settings came from the parent, and the link id is the parent's
    // so the normalized settings join still resolves.
    expect(config!.sourcePolicyId).toBe('parent-1');
    expect(config!.inherited).toBe(true);
    expect(config!.featureLinkId).toBe('fl-parent');
  });

  it('reports an authored link as not inherited, sourced from itself', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(
        chain([{ ...INHERITED_ROW, sourcePolicyId: 'child-1', inherited: false }]) as any,
      )
      .mockReturnValueOnce(chain([RING_ROW]) as any);

    const config = await loadPolicyLocalPatchConfig('child-1');
    expect(config!.inherited).toBe(false);
    expect(config!.sourcePolicyId).toBe('child-1');
  });

  it('returns null when the policy has no effective patch link at all', async () => {
    vi.mocked(db.select).mockReturnValueOnce(chain([]) as any);
    expect(await loadPolicyLocalPatchConfig('child-1')).toBeNull();
  });
});
