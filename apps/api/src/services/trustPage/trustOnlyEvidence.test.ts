import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({ db: { select: vi.fn() } }));

import { db } from '../../db';
import { DEFAULT_TRUST_EVALUATION_POLICY, evaluateTrustControls, TRUST_CONTROL_CATALOG } from '@breeze/shared';
import { TRUST_PAGE_EVIDENCE_POLICY } from '../postureEvidence';
import { loadTrustOnlyEvidence } from './trustOnlyEvidence';

function selectChain(rows: unknown) {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit']) p[m] = () => p;
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
type SyncOpts = { lastStatus?: string | null; connectionStatus?: string; connectionErrorCode?: string | null };
/** One ca_policies sync row joined to its m365_connections row (healthy by default). */
const syncRow = (lastCompleteSnapshotAt: Date | null, o: SyncOpts = {}) => ({
  lastCompleteSnapshotAt,
  lastStatus: o.lastStatus === undefined ? 'success' : o.lastStatus,
  connectionStatus: o.connectionStatus ?? 'active',
  connectionErrorCode: o.connectionErrorCode ?? null,
});

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

  describe('connection health gates the claim (#9087)', () => {
    const NOT_ASSESSED = { eligible: 0, assessed: 0, passing: 0, aggregatePct: null, newestEvidenceAt: null };
    async function evidenceFor(sync: unknown[]) {
      mockQueries(sync, [enforcing]);
      return (await loadTrustOnlyEvidence(ORG, AS_OF, TRUST_PAGE_EVIDENCE_POLICY)).mfa_enforced_m365;
    }

    it('a suspended connection reports no data even with a fresh CA snapshot', async () => {
      expect(await evidenceFor([syncRow(FRESH, { connectionStatus: 'suspended' })])).toEqual(NOT_ASSESSED);
      mockQueries([syncRow(FRESH, { connectionStatus: 'suspended' })], [enforcing]);
      expect(await finalStatus()).toMatchObject({ status: 'not_assessed', reason: 'no_data' });
    });

    it('a degraded connection with a consent error code reports no data', async () => {
      expect(await evidenceFor([syncRow(FRESH, { connectionStatus: 'degraded', connectionErrorCode: 'grant_missing' })])).toEqual(NOT_ASSESSED);
    });

    it('ca_policies needs_consent reports no data', async () => {
      expect(await evidenceFor([syncRow(FRESH, { lastStatus: 'needs_consent' })])).toEqual(NOT_ASSESSED);
    });

    it('a revoked connection whose sync rows survived reports no data', async () => {
      expect(await evidenceFor([syncRow(FRESH, { connectionStatus: 'revoked' })])).toEqual(NOT_ASSESSED);
    });

    it('a stale revoked row beside a healthy reconnected row keeps the healthy evidence', async () => {
      const NEWER = new Date(FRESH.getTime() + 3_600_000);
      const out = await evidenceFor([
        syncRow(NEWER, { connectionStatus: 'revoked' }),
        syncRow(FRESH, { connectionStatus: 'active' }),
      ]);
      // The revoked row is newer but filtered out; the healthy row decides the date.
      expect(out).toEqual({ eligible: 1, assessed: 1, passing: 1, aggregatePct: null, newestEvidenceAt: FRESH.toISOString() });
    });

    it('a degraded connection with a transient error keeps the last snapshot', async () => {
      expect(await evidenceFor([syncRow(FRESH, { connectionStatus: 'degraded', connectionErrorCode: 'graph_unavailable' })]))
        .toMatchObject({ assessed: 1, passing: 1 });
    });

    it('throttled keeps the last snapshot', async () => {
      expect(await evidenceFor([syncRow(FRESH, { lastStatus: 'throttled' })])).toMatchObject({ assessed: 1, passing: 1 });
    });

    it('an erroring sync keeps the last snapshot (freshness still bounds it)', async () => {
      expect(await evidenceFor([syncRow(FRESH, { lastStatus: 'error' })])).toMatchObject({ assessed: 1, passing: 1 });
    });

    it('consent in progress (unknown verdict) keeps the last snapshot', async () => {
      expect(await evidenceFor([syncRow(FRESH, { connectionStatus: 'verifying' })])).toMatchObject({ assessed: 1, passing: 1 });
    });
  });
});
