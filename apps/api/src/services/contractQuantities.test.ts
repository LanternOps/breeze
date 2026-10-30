import { describe, expect, it, vi } from 'vitest';
import { and } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({ db: {} }));
vi.mock('./groupMembership', async importOriginal => ({
  ...await importOriginal<typeof import('./groupMembership')>(), resolveEffectiveGroupMembers: vi.fn(),
}));

import { GroupEvaluationError, resolveEffectiveGroupMembers } from './groupMembership';
import { billableDeviceConds, groupMembersForBilling } from './contractQuantities';

describe('billableDeviceConds', () => {
  const compiled = () => {
    const query = new PgDialect().sqlToQuery(and(...billableDeviceConds('org-1'))!);
    return `${query.sql} ${JSON.stringify(query.params)}`;
  };

  it('never bills a device parked in a holding org', () => {
    expect(compiled()).toContain("parked_org.type = 'unassigned_pool'");
    expect(compiled()).toMatch(/NOT EXISTS \(SELECT 1 FROM organizations parked_org/);
  });

  it('keeps the decommissioned and ephemeral exclusions', () => {
    const text = compiled();
    expect(text).toContain('"devices"."status" <> $');
    expect(text).toContain('decommissioned');
    expect(text).toContain('"devices"."is_ephemeral" = $');
  });
});


describe('groupMembersForBilling ownership', () => {
  const group = { id: 'group-1', orgId: null, partnerId: 'partner-1', type: 'dynamic' as const,
    siteId: null, filterConditions: { operator: 'AND', conditions: [] } };
  it('refuses a partner group with unsupported_owner, never an empty set', async () => {
    vi.mocked(resolveEffectiveGroupMembers).mockClear();
    await expect(groupMembersForBilling(group)).rejects.toBeInstanceOf(GroupEvaluationError);
    await expect(groupMembersForBilling(group)).rejects.toMatchObject({ groupId: group.id, reason: 'unsupported_owner' });
    expect(resolveEffectiveGroupMembers).not.toHaveBeenCalled();
  });
  it("passes an org group's own org to the shared resolver", async () => {
    vi.mocked(resolveEffectiveGroupMembers).mockResolvedValue({ matched: new Set(['matched']), pinned: new Set(['pinned']), filterMs: 0 });
    const owned = { ...group, orgId: 'org-1', partnerId: null };
    expect(await groupMembersForBilling(owned)).toEqual({ siteId: null, memberIds: new Set(['matched', 'pinned']) });
    expect(resolveEffectiveGroupMembers).toHaveBeenCalledWith(owned, 'org-1');
  });
});
