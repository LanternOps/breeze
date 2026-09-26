import { describe, expect, it } from 'vitest';
import { classifyMemoryRows, type MemoryCandidateRow } from './lookup';

const K = 'k'.repeat(64);
const B = 'b'.repeat(64);
const ctx = { orgId: 'org-a', partnerId: 'p-1', signatureKey: K, broadKey: B, broad: false, osFamily: 'windows' };
const row = (over: Partial<MemoryCandidateRow> = {}): MemoryCandidateRow => ({
  id: 'm-1', orgId: null, partnerId: 'p-1', signatureKey: K, broadKey: B, osType: 'windows', fixKind: 'partner_script',
  scriptId: 's-1', scriptVersionId: 'v-1', builtinAction: null, playbookId: null,
  attempts: 4, verifiedCount: 4, failedCount: 0, recurredCount: 0, upVotes: 1, downVotes: 0,
  rollingSuccessRate: 1, recentOutcomes: ['verified', 'verified', 'verified', 'verified'], status: 'active',
  staleSince: null, lastVerifiedAt: new Date('2026-11-01T00:00:00Z'),
  script: { name: 'Restart spooler', deletedAt: null, osTypes: ['windows'], headVersion: 3, isSystem: false, orgId: null, partnerId: 'p-1' }, scriptVersionNumber: 3,
  ...over,
});

describe('classifyMemoryRows', () => {
  it('a proven partner row is proven with an "all clients" scope', () => {
    const { proven, similar } = classifyMemoryRows([row()], ctx, 5);
    expect(proven).toHaveLength(1);
    expect(proven[0]).toMatchObject({ scope: 'all_clients', verified: 4, attempts: 4, successRate: 1, scriptName: 'Restart spooler' });
    expect(similar).toEqual([]);
  });

  it('defence in depth: another org’s private row is dropped even if RLS let it through (Review Focus 4)', () => {
    expect(classifyMemoryRows([row({ orgId: 'org-b', partnerId: null })], ctx, 5)).toEqual({ proven: [], similar: [] });
    expect(classifyMemoryRows([row({ partnerId: 'p-2' })], ctx, 5)).toEqual({ proven: [], similar: [] });
  });

  it('script edited after proof: an old version is neither proven nor similar (Review Focus 5)', () => {
    expect(classifyMemoryRows([row({ scriptVersionNumber: 2 })], ctx, 5)).toEqual({ proven: [], similar: [] });
    const script = row().script!;
    expect(classifyMemoryRows([row({ script: { ...script, deletedAt: new Date() } })], ctx, 5).proven).toEqual([]);
    expect(classifyMemoryRows([row({ script: { ...script, osTypes: ['linux'] } })], ctx, 5).proven).toEqual([]);
    expect(classifyMemoryRows([row({ script: null })], ctx, 5).proven).toEqual([]);
  });

  it('a proven PARTNER entry whose script was re-scoped to org A is never offered to org B (Review Focus 5, system-scope attach)', () => {
    const rescoped = row({ script: { ...row().script!, orgId: 'org-a', partnerId: 'p-1' } });
    expect(classifyMemoryRows([rescoped], { ...ctx, orgId: 'org-b' }, 5)).toEqual({ proven: [], similar: [] });
    // Nor is the partner-wide track record presented to org A as "all clients" once the script is private to A.
    expect(classifyMemoryRows([rescoped], ctx, 5)).toEqual({ proven: [], similar: [] });
  });

  it('an org entry whose script moved org A → org B is hidden from both orgs', () => {
    const moved = row({ orgId: 'org-a', partnerId: null, fixKind: 'org_script', script: { ...row().script!, orgId: 'org-b', partnerId: 'p-1' } });
    expect(classifyMemoryRows([moved], ctx, 5)).toEqual({ proven: [], similar: [] });
    expect(classifyMemoryRows([moved], { ...ctx, orgId: 'org-b' }, 5)).toEqual({ proven: [], similar: [] });
  });

  it('system scripts stay shareable across the partner’s orgs', () => {
    const system = row({ fixKind: 'system_script', script: { ...row().script!, isSystem: true, partnerId: null } });
    expect(classifyMemoryRows([system], { ...ctx, orgId: 'org-z' }, 5).proven).toHaveLength(1);
  });

  it('demoted, stale or under-proven exact matches fall back to similar', () => {
    for (const over of [{ status: 'demoted' as const }, { staleSince: new Date() }, { verifiedCount: 2 }]) {
      const out = classifyMemoryRows([row(over)], ctx, 5);
      expect(out.proven).toEqual([]);
      expect(out.similar).toHaveLength(1);
    }
  });

  it('a broad signature never yields a proven fix', () => {
    const out = classifyMemoryRows([row({ signatureKey: B })], { ...ctx, signatureKey: B, broad: true }, 5);
    expect(out.proven).toEqual([]);
    expect(out.similar).toHaveLength(1);
  });

  it('org-private rows are labelled "this client"', () => {
    const own = row({ orgId: 'org-a', partnerId: null, fixKind: 'org_script', script: { ...row().script!, orgId: 'org-a' } });
    expect(classifyMemoryRows([own], ctx, 5).proven[0]!.scope).toBe('this_client');
  });
});
