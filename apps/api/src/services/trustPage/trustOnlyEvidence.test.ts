import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({ db: { select: vi.fn() } }));

import { db } from '../../db';
import { DEFAULT_TRUST_EVALUATION_POLICY, evaluateTrustControls, TRUST_CONTROL_CATALOG } from '@breeze/shared';
import { TRUST_PAGE_EVIDENCE_POLICY } from '../postureEvidence';
import { loadTrustOnlyEvidence } from './trustOnlyEvidence';

function selectChain(rows: unknown) {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'where', 'orderBy', 'limit']) p[m] = () => p;
  return p;
}
const ORG = '00000000-0000-0000-0000-000000000001';
const AS_OF = new Date('2026-10-13T12:00:00.000Z');
const FRESH = new Date('2026-10-12T12:00:00.000Z');
const STALE = new Date('2026-08-01T12:00:00.000Z'); // > maxSecurityStatusAgeDays (30)

const enforcing = {
  state: 'enabled', isStale: false,
  conditions: { users: { includeUsers: ['All'] }, applications: { includeApplications: ['All'] } },
  grantControls: { operator: 'OR', builtInControls: ['mfa'] },
};
const reportOnly = { ...enforcing, state: 'enabledForReportingButNotEnforced' };
const group = { ...enforcing, conditions: { users: { includeUsers: ['None'], includeGroups: ['g'] }, applications: { includeApplications: ['All'] } } };

/** query 1 = m365_sync_state rows, query 2 = m365_ca_policies rows. */
function mockQueries(sync: unknown[], policies: unknown[] = []) {
  const seq = [sync, policies];
  let i = 0;
  (db.select as any).mockImplementation(() => selectChain(seq[i++] ?? []));
}
const syncRow = (lastCompleteSnapshotAt: Date | null) => ({ lastCompleteSnapshotAt });

async function finalStatus() {
  const trustOnly = await loadTrustOnlyEvidence(ORG, AS_OF, TRUST_PAGE_EVIDENCE_POLICY);
  const evidence = { mfa_enforced_m365: trustOnly.mfa_enforced_m365! } as any;
  const def = TRUST_CONTROL_CATALOG.filter((d) => d.id === 'mfa_enforced_m365');
  return evaluateTrustControls(def, { ...evidence } as any, DEFAULT_TRUST_EVALUATION_POLICY, AS_OF)[0]!;
}

describe('loadTrustOnlyEvidence (mfa_enforced_m365)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no sync-state row → not assessed / no_data, and the policy table is not read', async () => {
    mockQueries([]);
    const out = await loadTrustOnlyEvidence(ORG, AS_OF, TRUST_PAGE_EVIDENCE_POLICY);
    expect(out.mfa_enforced_m365).toEqual({ eligible: 0, assessed: 0, passing: 0, aggregatePct: null, newestEvidenceAt: null });
    expect((db.select as any).mock.calls).toHaveLength(1);
    expect(await finalStatus()).toMatchObject({ status: 'not_assessed', reason: 'no_data' });
  });

  it('null lastCompleteSnapshotAt → not assessed', async () => {
    mockQueries([syncRow(null)], [enforcing]);
    expect(await finalStatus()).toMatchObject({ status: 'not_assessed', reason: 'no_data' });
  });

  it('a sync older than maxSecurityStatusAgeDays → not assessed even with an enforcing policy', async () => {
    mockQueries([syncRow(STALE)], [enforcing]);
    expect(await finalStatus()).toMatchObject({ status: 'not_assessed', reason: 'no_data' });
  });

  it('fresh sync with zero policies → eligible 1 / assessed 0 → not assessed', async () => {
    mockQueries([syncRow(FRESH)], []);
    const out = await loadTrustOnlyEvidence(ORG, AS_OF, TRUST_PAGE_EVIDENCE_POLICY);
    expect(out.mfa_enforced_m365).toMatchObject({ eligible: 1, assessed: 0, passing: 0 });
    mockQueries([syncRow(FRESH)], []);
    expect(await finalStatus()).toMatchObject({ status: 'not_assessed', reason: 'no_data' });
  });

  it('one qualifying policy among three → met, evidence dated at the sync snapshot', async () => {
    mockQueries([syncRow(FRESH)], [reportOnly, enforcing, group]);
    const out = await loadTrustOnlyEvidence(ORG, AS_OF, TRUST_PAGE_EVIDENCE_POLICY);
    expect(out.mfa_enforced_m365).toEqual({ eligible: 1, assessed: 1, passing: 1, aggregatePct: null, newestEvidenceAt: FRESH.toISOString() });
    mockQueries([syncRow(FRESH)], [reportOnly, enforcing, group]);
    expect(await finalStatus()).toMatchObject({ status: 'met', reason: null, evidenceAsOf: FRESH.toISOString() });
  });

  it('only report-only / partial policies → not met', async () => {
    mockQueries([syncRow(FRESH)], [reportOnly, group]);
    expect(await finalStatus()).toMatchObject({ status: 'not_met' });
  });

  it('several connections: the newest complete snapshot decides freshness', async () => {
    mockQueries([syncRow(STALE), syncRow(FRESH), syncRow(null)], [enforcing]);
    expect(await finalStatus()).toMatchObject({ status: 'met' });
  });
});
