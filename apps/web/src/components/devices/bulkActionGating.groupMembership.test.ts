import { describe, expect, it } from 'vitest';
import {
  BULK_GROUP_MEMBERSHIP_CAP,
  BULK_SITE_MOVE_CAP,
  bulkGroupMembershipBlock,
  bulkMoveSiteBlock,
  DECOMMISSION_BLOCKED_BULK_ACTIONS,
  INTENTIONALLY_UNGATED_BULK_ACTIONS,
  REMOVED_ONLY_BULK_ACTIONS,
} from './bulkActionGating';

/**
 * Bulk "Add to group" / "Remove from group" (#9866): static-group membership is a DB write on
 * agent devices, scoped to ONE org (a static group belongs to one org, and the membership API
 * refuses a device from another), capped per request like the bulk site move.
 */
const agent = (id: string, orgId: string) => ({ id, orgId, deviceClass: 'agent' as const });
const many = (n: number, orgOf: (i: number) => string = () => 'org-1') =>
  Array.from({ length: n }, (_, i) => agent(`d${i}`, orgOf(i)));

describe('bulkGroupMembershipBlock', () => {
  it('mirrors the API cap (routes/groups.ts BULK_GROUP_MEMBERSHIP_CAP)', () => {
    expect(BULK_GROUP_MEMBERSHIP_CAP).toBe(500);
  });

  it('allows a single-org agent selection', () => {
    expect(bulkGroupMembershipBlock([agent('a', 'org-1'), agent('b', 'org-1')])).toBeNull();
  });

  it('blocks a selection whose agents span two orgs', () => {
    expect(bulkGroupMembershipBlock([agent('a', 'org-1'), agent('b', 'org-2')])).toBe('mixed_org');
  });

  it('ignores network and manual rows (their ids are not devices.id)', () => {
    expect(bulkGroupMembershipBlock([
      agent('a', 'org-1'),
      { id: 'n', orgId: 'org-2', deviceClass: 'network' as const },
      { id: 'm', orgId: 'org-3', deviceClass: 'manual' as const },
    ])).toBeNull();
    expect(bulkGroupMembershipBlock([{ id: 'n', orgId: 'org-1', deviceClass: 'network' as const }])).toBe('no_agents');
    expect(bulkGroupMembershipBlock([])).toBe('no_agents');
  });

  it('blocks more agents than its own cap, and allows exactly the cap', () => {
    expect(bulkGroupMembershipBlock(many(BULK_GROUP_MEMBERSHIP_CAP))).toBeNull();
    expect(bulkGroupMembershipBlock(many(BULK_GROUP_MEMBERSHIP_CAP + 1))).toBe('over_cap');
  });

  it('reports mixed orgs before the cap', () => {
    expect(bulkGroupMembershipBlock(many(BULK_GROUP_MEMBERSHIP_CAP + 1, (i) => (i === 0 ? 'org-2' : 'org-1'))))
      .toBe('mixed_org');
  });

  it('does not change the site-move cap (the two share the rule, not the number)', () => {
    expect(bulkMoveSiteBlock(many(BULK_SITE_MOVE_CAP + 1))).toBe('over_cap');
    expect(bulkGroupMembershipBlock(many(BULK_SITE_MOVE_CAP + 1))).toBeNull();
  });
});

describe('group membership classification', () => {
  it.each(['add-to-group', 'remove-from-group'])('%s is a status-ungated bulk action (a DB write, not an agent command)', (action) => {
    expect(INTENTIONALLY_UNGATED_BULK_ACTIONS.has(action)).toBe(true);
    expect(DECOMMISSION_BLOCKED_BULK_ACTIONS.has(action)).toBe(false);
    expect(REMOVED_ONLY_BULK_ACTIONS.has(action)).toBe(false);
  });
});
