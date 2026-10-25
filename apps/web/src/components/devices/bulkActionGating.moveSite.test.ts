import { describe, expect, it } from 'vitest';
import {
  BULK_SITE_MOVE_CAP,
  bulkMoveSiteBlock,
  bulkMoveSiteAgents,
  DECOMMISSION_BLOCKED_BULK_ACTIONS,
  INTENTIONALLY_UNGATED_BULK_ACTIONS,
  REMOVED_ONLY_BULK_ACTIONS,
} from './bulkActionGating';

/**
 * Bulk "Move to site" (#9796, spec §4.4): offered for agent devices only, only when every selected
 * agent is in ONE org, and never for more than the API's per-request cap (the web disables a larger
 * selection rather than chunking it — chunking is the client loop Decision 5 rejected).
 */
const agent = (id: string, orgId: string) => ({ id, orgId, deviceClass: 'agent' as const });

describe('bulkMoveSiteBlock', () => {
  it('mirrors the API cap (routes/devices/schemas.ts BULK_SITE_MOVE_CAP)', () => {
    expect(BULK_SITE_MOVE_CAP).toBe(100);
  });

  it('allows a single-org agent selection', () => {
    expect(bulkMoveSiteBlock([agent('a', 'org-1'), agent('b', 'org-1')])).toBeNull();
  });

  it('blocks a selection whose agents span two orgs', () => {
    expect(bulkMoveSiteBlock([agent('a', 'org-1'), agent('b', 'org-2')])).toBe('mixed_org');
  });

  it('ignores network and manual rows: only agents move, and only agents decide the org', () => {
    const selection = [
      agent('a', 'org-1'),
      { id: 'n', orgId: 'org-2', deviceClass: 'network' as const },
      { id: 'm', orgId: 'org-3', deviceClass: 'manual' as const },
    ];
    expect(bulkMoveSiteBlock(selection)).toBeNull();
    expect(bulkMoveSiteAgents(selection).map((d) => d.id)).toEqual(['a']);
  });

  it('treats a row with no deviceClass as an agent (the list default)', () => {
    expect(bulkMoveSiteAgents([{ id: 'x', orgId: 'org-1' }]).map((d) => d.id)).toEqual(['x']);
  });

  it('blocks a selection with no agent at all', () => {
    expect(bulkMoveSiteBlock([{ id: 'n', orgId: 'org-1', deviceClass: 'network' as const }])).toBe('no_agents');
    expect(bulkMoveSiteBlock([])).toBe('no_agents');
  });

  it('blocks more agents than the cap, and allows exactly the cap', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => agent(`d${i}`, 'org-1'));
    expect(bulkMoveSiteBlock(many(BULK_SITE_MOVE_CAP))).toBeNull();
    expect(bulkMoveSiteBlock(many(BULK_SITE_MOVE_CAP + 1))).toBe('over_cap');
  });

  it('reports mixed orgs before the cap (the more actionable reason)', () => {
    const many = Array.from({ length: BULK_SITE_MOVE_CAP + 1 }, (_, i) => agent(`d${i}`, i === 0 ? 'org-2' : 'org-1'));
    expect(bulkMoveSiteBlock(many)).toBe('mixed_org');
  });
});

describe('move-site classification', () => {
  it('is a status-ungated bulk action (a DB write, not an agent command; the API refuses no status)', () => {
    expect(INTENTIONALLY_UNGATED_BULK_ACTIONS.has('move-site')).toBe(true);
    expect(DECOMMISSION_BLOCKED_BULK_ACTIONS.has('move-site')).toBe(false);
    expect(REMOVED_ONLY_BULK_ACTIONS.has('move-site')).toBe(false);
  });
});
