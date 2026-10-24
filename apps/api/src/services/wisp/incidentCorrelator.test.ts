/**
 * Wisp W05b Task 14 — correlateIncidents. `db.execute` answers by the
 * `/* wisp:… *\/` marker each query carries; concerns / ceilings / delivery /
 * threads are mocked. The window and auto-close decisions are re-checked in
 * TS on the returned rows, so the fixtures below exercise them directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const h = vi.hoisted(() => ({
  enabled: true,
  state: { inSystem: false },
  executes: [] as Array<{ query: unknown; inSystem: boolean }>,
  handler: (_q: unknown): unknown[] => [],
  upsertConcern: vi.fn(),
  updateConcern: vi.fn(async () => undefined),
  resolveConcern: vi.fn(async () => undefined),
  recipientState: vi.fn(async (_concernId: string, _grantId: string): Promise<{
    nudgeCount: number; nextEligibleNudgeAt: Date | null; snoozedUntil: Date | null; dismissedAt: Date | null;
  }> => ({ nudgeCount: 0, nextEligibleNudgeAt: null, snoozedUntil: null, dismissedAt: null })),
  recordNudge: vi.fn(async () => ({ nudgeCount: 1, nextEligibleNudgeAt: new Date() })),
  resolveGrantCeiling: vi.fn(),
  deliverInApp: vi.fn(async () => ({ created: true })),
  getOrCreateThread: vi.fn(async (grantId: string) => ({ id: `thread-${grantId}` })),
  captureException: vi.fn(),
  writesInsideSystem: [] as boolean[],
}));

vi.mock('../../db', () => ({
  db: {
    execute: vi.fn(async (query: unknown) => {
      h.executes.push({ query, inSystem: h.state.inSystem });
      return h.handler(query);
    }),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    h.state.inSystem = true;
    try { return await fn(); } finally { h.state.inSystem = false; }
  }),
}));
vi.mock('../../config/env', () => ({ wispEnabled: () => h.enabled }));
vi.mock('../eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../sentry', () => ({ captureException: h.captureException }));
const track = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => {
  h.writesInsideSystem.push(h.state.inSystem);
  return fn(...a);
};
vi.mock('./concerns', () => ({
  upsertConcern: (...a: unknown[]) => track(h.upsertConcern)(...a),
  updateConcern: (...a: unknown[]) => track(h.updateConcern as (...x: unknown[]) => unknown)(...a),
  resolveConcern: (...a: unknown[]) => track(h.resolveConcern as (...x: unknown[]) => unknown)(...a),
  recipientState: (...a: unknown[]) => (h.recipientState as (...x: unknown[]) => unknown)(...a),
  recordNudge: (...a: unknown[]) => (h.recordNudge as (...x: unknown[]) => unknown)(...a),
}));
vi.mock('./grantAuthority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./grantAuthority')>();
  class GrantInactiveError extends Error {
    constructor(public readonly grantId: string) { super(`grant ${grantId} inactive`); }
  }
  return {
    GrantInactiveError,
    CeilingViolationError: actual.CeilingViolationError,
    assertWithinCeiling: actual.assertWithinCeiling,
    resolveGrantCeiling: (...a: unknown[]) => h.resolveGrantCeiling(...a),
  };
});
vi.mock('./deliver', () => ({ deliverInApp: (...a: unknown[]) => track(h.deliverInApp as (...x: unknown[]) => unknown)(...a) }));
vi.mock('./threads', () => ({ getOrCreateThread: (g: string) => h.getOrCreateThread(g) }));

import { GrantInactiveError } from './grantAuthority';
import { clusterSignature } from './pollers';
import { correlateIncidents } from './incidentCorrelator';

const dialect = new PgDialect();
const NOW = new Date('2026-10-24T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = uid(1);
const P2 = uid(2);
const OA = uid(11);
const OB = uid(12);
const OC = uid(13);
const G1 = uid(21);
const G2 = uid(22);
const G3 = uid(23);
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const TOKENS = ['asking', 'keeps', 'outlook', 'password'];

type OrgConcern = { id: string; partner_id: string; org_id: string; evidence: Record<string, unknown>; created_at: string };
type PartnerLive = { id: string; partner_id: string; signature: string | null; status: string; evidence: Record<string, unknown>; child_concern_ids: string[] };
type Candidate = { id: string; org_id: string | null; created_at: string; last_ticket_at: string | null; child_count: number; live_children: number | null };

let grants: Array<{ id: string; partner_id: string; current_revision_id: string }>;
let ceilings: Map<string, { grantId: string; partnerId: string; grantorUserId: string; scopeOrgId: null; partnerWide: boolean; orgIds: Set<string> }>;
let orgConcerns: OrgConcern[];
let partnerLive: PartnerLive[];
let health: Array<{ id: string; partner_id: string }>;
let candidates: Candidate[];

const render = (q: unknown) => dialect.sqlToQuery(q as Parameters<PgDialect['sqlToQuery']>[0]);
const queryWith = (marker: string) => h.executes.map((e) => render(e.query)).filter((r) => r.sql.includes(marker));

function orgConcern(n: number, orgId: string, ticketNos: number[], over: Partial<OrgConcern> & { tokens?: string[]; lastTicketAt?: string } = {}): OrgConcern {
  return {
    id: uid(100 + n),
    partner_id: P,
    org_id: orgId,
    created_at: ago(20 * MIN),
    evidence: {
      ticketIds: ticketNos.map((t) => uid(1000 + t)),
      ticketCount: ticketNos.length,
      tokens: over.tokens ?? TOKENS,
      windowMinutes: 15,
      firstSeenAt: ago(20 * MIN),
      lastTicketAt: over.lastTicketAt ?? ago(5 * MIN),
    },
    ...over,
  };
}

function ceiling(grantId: string, partnerId: string, orgIds: string[], partnerWide = true, o: Record<string, unknown> = {}) {
  return {
    grantId, partnerId, grantorUserId: `user-${grantId}`, scopeOrgId: null, partnerWide, orgIds: new Set(orgIds),
    siteIds: null, orgTerms: new Map(), permissionKeys: new Set(['*:*']), toolAllowlist: null, deniedTools: new Set(), status: 'active', ...o,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.enabled = true;
  h.executes = [];
  h.writesInsideSystem = [];
  h.state.inSystem = false;
  grants = [{ id: G1, partner_id: P, current_revision_id: uid(31) }];
  ceilings = new Map([[G1, ceiling(G1, P, [OA, OB, OC])]]);
  orgConcerns = [];
  partnerLive = [];
  health = [];
  candidates = [];
  let next = 500;
  h.upsertConcern.mockImplementation(async () => ({ id: uid(next++), created: true }));
  h.deliverInApp.mockImplementation(async () => ({ created: true }));
  h.recipientState.mockImplementation(async () => ({ nudgeCount: 0, nextEligibleNudgeAt: null, snoozedUntil: null, dismissedAt: null }));
  h.resolveConcern.mockImplementation(async () => undefined);
  h.resolveGrantCeiling.mockImplementation(async (grantId: string) => {
    const c = ceilings.get(grantId);
    if (!c) throw new GrantInactiveError(grantId, 'paused');
    return c;
  });
  h.handler = (q) => {
    const { sql: text, params } = render(q);
    const forPartner = <T extends { partner_id: string }>(rows: T[]) => rows.filter((r) => params.includes(r.partner_id));
    if (text.includes('wisp:incident-grants')) return grants;
    if (text.includes('wisp:incident-org-concerns')) return forPartner(orgConcerns);
    if (text.includes('wisp:incident-partner-live')) return forPartner(partnerLive);
    if (text.includes('wisp:incident-health')) return forPartner(health);
    if (text.includes('wisp:incident-autoclose')) return candidates;
    throw new Error(`unexpected query: ${text.slice(0, 80)}`);
  };
});

describe('correlateIncidents', () => {
  it('returns zeros without touching the DB when Wisp is off', async () => {
    h.enabled = false;
    await expect(correlateIncidents(NOW)).resolves.toEqual({ partnerIncidentsOpened: 0, updated: 0, autoClosed: 0 });
    expect(h.executes).toHaveLength(0);
  });

  it('opens one partner-level concern for two orgs sharing a signature, with health evidence, and nudges each partner-wide grantor', async () => {
    grants.push({ id: G2, partner_id: P, current_revision_id: uid(32) });
    ceilings.set(G2, ceiling(G2, P, [OA, OB, OC]));
    orgConcerns = [orgConcern(1, OA, [1, 2, 3]), orgConcern(2, OB, [4, 5, 6])];
    health = [{ id: uid(700), partner_id: P }];

    const res = await correlateIncidents(NOW);
    expect(res).toEqual({ partnerIncidentsOpened: 1, updated: 0, autoClosed: 0 });
    expect(h.upsertConcern).toHaveBeenCalledTimes(1);
    const input = h.upsertConcern.mock.calls[0]![0] as Record<string, any>;
    expect(input).toMatchObject({
      partnerId: P,
      orgId: null,
      subject: { kind: 'incident' },
      severity: 'high',
      signature: clusterSignature(P, TOKENS),
      childConcernIds: [uid(101), uid(102)],
      summary: 'Possible incident across 2 customers: asking keeps outlook password',
    });
    expect(input.evidence).toMatchObject({
      orgIds: [OA, OB],
      childConcernIds: [uid(101), uid(102)],
      healthIncidentIds: [uid(700)],
      ticketCount: 6,
      lastTicketAt: ago(5 * MIN),
      firstSeenAt: NOW.toISOString(),
    });
    expect(input.evidence.ticketIds).toHaveLength(6);

    const concernId = uid(500);
    expect(h.deliverInApp).toHaveBeenCalledTimes(2);
    expect(h.deliverInApp).toHaveBeenCalledWith(expect.objectContaining({
      userId: `user-${G1}`,
      orgId: null,
      grantId: G1,
      concernId,
      threadId: `thread-${G1}`,
      link: `/ai/wisp/thread/thread-${G1}#concern=${concernId}`,
      dedupeKey: `wisp-incident-${concernId}-${G1}`,
      priority: 'high',
    }));
    expect(h.deliverInApp).toHaveBeenCalledWith(expect.objectContaining({ userId: `user-${G2}`, dedupeKey: `wisp-incident-${concernId}-${G2}` }));
    expect(h.recordNudge).toHaveBeenCalledWith(concernId, G1, NOW);
    expect(h.recordNudge).toHaveBeenCalledWith(concernId, G2, NOW);
    // Reads ran in system context; every write ran after the read block returned.
    expect(h.executes.every((e) => e.inSystem)).toBe(true);
    expect(h.writesInsideSystem.every((x) => x === false)).toBe(true);
  });

  it('opens nothing for one org with 3 tickets', async () => {
    orgConcerns = [orgConcern(1, OA, [1, 2, 3])];
    await expect(correlateIncidents(NOW)).resolves.toEqual({ partnerIncidentsOpened: 0, updated: 0, autoClosed: 0 });
    expect(h.upsertConcern).not.toHaveBeenCalled();
    expect(h.deliverInApp).not.toHaveBeenCalled();
  });

  it('opens one for a single org with 8 tickets', async () => {
    orgConcerns = [orgConcern(1, OA, [1, 2, 3, 4, 5, 6, 7, 8])];
    const res = await correlateIncidents(NOW);
    expect(res.partnerIncidentsOpened).toBe(1);
    const input = h.upsertConcern.mock.calls[0]![0] as Record<string, any>;
    expect(input.summary).toBe('Possible incident across 1 customer: asking keeps outlook password');
    expect(input.evidence.orgIds).toEqual([OA]);
  });

  it('correlates orgs whose cluster names overlap (Jaccard ≥ 0.5) without being identical', async () => {
    orgConcerns = [
      orgConcern(1, OA, [1, 2, 3], { tokens: ['outlook', 'password', 'prompt'] }),
      orgConcern(2, OB, [4, 5, 6], { tokens: ['outlook', 'password', 'asking'] }),
      orgConcern(3, OC, [7, 8, 9], { tokens: ['printer', 'offline'] }),
    ];
    await correlateIncidents(NOW);
    expect(h.upsertConcern).toHaveBeenCalledTimes(1);
    expect((h.upsertConcern.mock.calls[0]![0] as Record<string, any>).childConcernIds).toEqual([uid(101), uid(102)]);
  });

  it('updates (not duplicates) the live partner-level concern when another org joins', async () => {
    orgConcerns = [orgConcern(1, OA, [1, 2, 3]), orgConcern(2, OB, [4, 5, 6]), orgConcern(3, OC, [7, 8, 9])];
    partnerLive = [{
      id: uid(600), partner_id: P, status: 'open', signature: clusterSignature(P, TOKENS), child_concern_ids: [uid(101), uid(102)],
      evidence: {
        orgIds: [OA, OB], childConcernIds: [uid(101), uid(102)], ticketIds: [1, 2, 3, 4, 5, 6].map((t) => uid(1000 + t)),
        ticketCount: 6, healthIncidentIds: [], tokens: TOKENS, firstSeenAt: ago(30 * MIN), lastTicketAt: ago(5 * MIN),
      },
    }];
    h.deliverInApp.mockImplementation(async () => ({ created: false }));
    const res = await correlateIncidents(NOW);
    expect(res).toEqual({ partnerIncidentsOpened: 0, updated: 1, autoClosed: 0 });
    expect(h.upsertConcern).not.toHaveBeenCalled();
    const [id, patch] = h.updateConcern.mock.calls[0]! as unknown as [string, Record<string, any>];
    expect(id).toBe(uid(600));
    expect(patch.childConcernIds).toEqual([uid(101), uid(102), uid(103)]);
    expect(patch.evidence.orgIds).toEqual([OA, OB, OC]);
    expect(patch.evidence.ticketCount).toBe(9);
    expect(patch.evidence.firstSeenAt).toBe(ago(30 * MIN));
    expect(patch.summary).toBe('Possible incident across 3 customers: asking keeps outlook password');
    // The dedupe key already exists: nothing new delivered, no nudge counted.
    expect(h.recordNudge).not.toHaveBeenCalled();
  });

  it('a rescan with nothing new writes and delivers nothing once every grantor was nudged', async () => {
    orgConcerns = [orgConcern(1, OA, [1, 2, 3]), orgConcern(2, OB, [4, 5, 6])];
    partnerLive = [{
      id: uid(600), partner_id: P, status: 'open', signature: clusterSignature(P, TOKENS), child_concern_ids: [uid(101), uid(102)],
      evidence: {
        orgIds: [OA, OB], childConcernIds: [uid(101), uid(102)], ticketIds: [1, 2, 3, 4, 5, 6].map((t) => uid(1000 + t)),
        ticketCount: 6, healthIncidentIds: [], tokens: TOKENS, lastTicketAt: ago(5 * MIN),
      },
    }];
    h.recipientState.mockImplementation(async () => ({ nudgeCount: 1, nextEligibleNudgeAt: null, snoozedUntil: null, dismissedAt: null }));
    await expect(correlateIncidents(NOW)).resolves.toEqual({ partnerIncidentsOpened: 0, updated: 0, autoClosed: 0 });
    expect(h.updateConcern).not.toHaveBeenCalled();
    expect(h.deliverInApp).not.toHaveBeenCalled();
    expect(h.recipientState).toHaveBeenCalledWith(uid(600), G1);
  });

  it('retries a failed nudge on the next tick even though nothing new arrived', async () => {
    orgConcerns = [orgConcern(1, OA, [1, 2, 3]), orgConcern(2, OB, [4, 5, 6])];
    let nudged = 0;
    h.recordNudge.mockImplementation(async () => { nudged += 1; return { nudgeCount: nudged, nextEligibleNudgeAt: new Date() }; });
    h.recipientState.mockImplementation(async () => ({ nudgeCount: nudged, nextEligibleNudgeAt: null, snoozedUntil: null, dismissedAt: null }));
    h.deliverInApp.mockImplementationOnce(async () => { throw new Error('insert failed'); });

    // Tick 1: the incident opens, its one nudge fails.
    await expect(correlateIncidents(NOW)).resolves.toMatchObject({ partnerIncidentsOpened: 1 });
    expect(h.deliverInApp).toHaveBeenCalledTimes(1);
    expect(h.recordNudge).not.toHaveBeenCalled();
    expect(h.captureException).toHaveBeenCalledTimes(1);

    // Tick 2: the concern is stored with the same evidence; no new tickets.
    const input = h.upsertConcern.mock.calls[0]![0] as Record<string, any>;
    partnerLive = [{
      id: uid(500), partner_id: P, status: 'open', signature: input.signature,
      child_concern_ids: input.childConcernIds, evidence: input.evidence,
    }];
    await expect(correlateIncidents(NOW)).resolves.toEqual({ partnerIncidentsOpened: 0, updated: 0, autoClosed: 0 });
    expect(h.upsertConcern).toHaveBeenCalledTimes(1);
    expect(h.updateConcern).not.toHaveBeenCalled();
    expect(h.deliverInApp).toHaveBeenCalledTimes(2);
    expect(h.deliverInApp).toHaveBeenLastCalledWith(expect.objectContaining({
      grantId: G1,
      concernId: uid(500),
      dedupeKey: `wisp-incident-${uid(500)}-${G1}`,
      body: 'Possible incident across 2 customers: asking keeps outlook password',
    }));
    expect(h.recordNudge).toHaveBeenCalledTimes(1);
    expect(h.recordNudge).toHaveBeenCalledWith(uid(500), G1, NOW);

    // Tick 3: the nudge is recorded — nothing more is delivered.
    await correlateIncidents(NOW);
    expect(h.deliverInApp).toHaveBeenCalledTimes(2);
  });

  it('nudges a live partner-level incident whose children went quiet, but never one naming an org outside the ceilings', async () => {
    // No fresh child concerns this tick; two live incidents from earlier.
    partnerLive = [
      {
        id: uid(610), partner_id: P, status: 'open', signature: 'sig-a', child_concern_ids: [uid(101)],
        evidence: { orgIds: [OA, OB], childConcernIds: [uid(101)], tokens: TOKENS },
      },
      {
        id: uid(611), partner_id: P, status: 'open', signature: 'sig-b', child_concern_ids: [uid(102)],
        evidence: { orgIds: [OA, uid(99)], childConcernIds: [uid(102)], tokens: TOKENS },
      },
      {
        id: uid(612), partner_id: P, status: 'dismissed', signature: 'sig-c', child_concern_ids: [uid(103)],
        evidence: { orgIds: [OA, OB], childConcernIds: [uid(103)], tokens: TOKENS },
      },
    ];
    await correlateIncidents(NOW);
    expect(h.deliverInApp).toHaveBeenCalledTimes(1);
    expect(h.deliverInApp).toHaveBeenCalledWith(expect.objectContaining({ concernId: uid(610), grantId: G1 }));
  });

  it('does not re-open a partner-level incident a person closed recently for the same children', async () => {
    orgConcerns = [orgConcern(1, OA, [1, 2, 3]), orgConcern(2, OB, [4, 5, 6])];
    partnerLive = [{
      id: uid(601), partner_id: P, status: 'dismissed', signature: clusterSignature(P, TOKENS), child_concern_ids: [uid(101), uid(102)],
      evidence: { orgIds: [OA, OB], childConcernIds: [uid(101), uid(102)], tokens: TOKENS },
    }];
    await expect(correlateIncidents(NOW)).resolves.toEqual({ partnerIncidentsOpened: 0, updated: 0, autoClosed: 0 });
    expect(h.upsertConcern).not.toHaveBeenCalled();
    expect(h.updateConcern).not.toHaveBeenCalled();
    expect(h.deliverInApp).not.toHaveBeenCalled();
    expect(queryWith('wisp:incident-partner-live')[0]!.sql).toMatch(/status IN \('resolved', 'dismissed'\) AND c\.updated_at >=/);
  });

  it('a partner with only org-scoped grants gets no partner-level concern', async () => {
    // The grant query only returns partner-wide (org_id IS NULL) grants.
    grants = [];
    orgConcerns = [orgConcern(1, OA, [1, 2, 3]), orgConcern(2, OB, [4, 5, 6])];
    await expect(correlateIncidents(NOW)).resolves.toEqual({ partnerIncidentsOpened: 0, updated: 0, autoClosed: 0 });
    expect(h.upsertConcern).not.toHaveBeenCalled();
    const q = queryWith('wisp:incident-grants')[0]!;
    expect(q.sql).toMatch(/g\.org_id IS NULL/);
    expect(q.sql).toMatch(/g\.status = 'active'/);
    expect(q.sql).toMatch(/LIMIT/);
    expect(queryWith('wisp:incident-org-concerns')).toHaveLength(0);
  });

  it('a partner-wide grant whose grantor lost org_access all (partnerWide false) or went inactive opens nothing', async () => {
    ceilings.set(G1, ceiling(G1, P, [OA, OB], false));
    grants.push({ id: G3, partner_id: P, current_revision_id: uid(33) }); // no ceiling → inactive
    orgConcerns = [orgConcern(1, OA, [1, 2, 3]), orgConcern(2, OB, [4, 5, 6])];
    await correlateIncidents(NOW);
    expect(h.upsertConcern).not.toHaveBeenCalled();
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('only correlates orgs inside every partner-wide ceiling', async () => {
    grants.push({ id: G2, partner_id: P, current_revision_id: uid(32) });
    ceilings.set(G2, ceiling(G2, P, [OA]));
    orgConcerns = [orgConcern(1, OA, [1, 2, 3]), orgConcern(2, OB, [4, 5, 6])];
    await correlateIncidents(NOW);
    expect(h.upsertConcern).not.toHaveBeenCalled();
  });

  it('never correlates an org a partner-wide grantor reaches only through sites, and a site-restricted ceiling opens nothing', async () => {
    ceilings.set(G1, ceiling(G1, P, [OA, OB, OC], true, {
      orgTerms: new Map([[OB, { permissionKeys: new Set(['*:*']), siteIds: new Set(['site-1']) }]]),
    }));
    orgConcerns = [orgConcern(1, OA, [1, 2, 3]), orgConcern(2, OB, [4, 5, 6])];
    await correlateIncidents(NOW);
    expect(h.upsertConcern).not.toHaveBeenCalled();

    ceilings.set(G1, ceiling(G1, P, [OA, OB, OC], true, { siteIds: new Set(['site-1']) }));
    orgConcerns = [orgConcern(1, OA, [1, 2, 3]), orgConcern(2, OC, [4, 5, 6])];
    await correlateIncidents(NOW);
    expect(h.upsertConcern).not.toHaveBeenCalled();
  });

  it('a site-restricted partner-wide grant neither blocks nor joins another grantor\'s partner-level incident', async () => {
    grants.push({ id: G2, partner_id: P, current_revision_id: uid(32) });
    ceilings.set(G2, ceiling(G2, P, [OA, OB, OC], true, { siteIds: new Set(['site-1']) }));
    orgConcerns = [orgConcern(1, OA, [1, 2, 3]), orgConcern(2, OB, [4, 5, 6])];
    await correlateIncidents(NOW);
    expect(h.upsertConcern).toHaveBeenCalledTimes(1);
    const grantIds = h.deliverInApp.mock.calls.map((c) => ((c as unknown[])[0] as { grantId?: string }).grantId);
    expect(grantIds).toContain(G1);
    expect(grantIds).not.toContain(G2);
  });

  // The incident summary quotes cluster tokens (words from ticket subjects):
  // an org a grantor may not read tickets in is never correlated.
  it('never correlates an org where a partner-wide grantor lacks tickets:read', async () => {
    ceilings.set(G1, ceiling(G1, P, [OA, OB, OC], true, {
      orgTerms: new Map([[OB, { permissionKeys: new Set(['devices:read']), siteIds: null }]]),
    }));
    orgConcerns = [orgConcern(1, OA, [1, 2, 3]), orgConcern(2, OB, [4, 5, 6])];
    await correlateIncidents(NOW);
    expect(h.upsertConcern).not.toHaveBeenCalled();
  });

  it('keeps partners apart', async () => {
    grants.push({ id: G2, partner_id: P2, current_revision_id: uid(32) });
    ceilings.set(G2, ceiling(G2, P2, [OC]));
    orgConcerns = [orgConcern(1, OA, [1, 2, 3]), { ...orgConcern(3, OC, [7, 8, 9]), partner_id: P2 }];
    await correlateIncidents(NOW);
    expect(h.upsertConcern).not.toHaveBeenCalled();
  });

  it('keys the window on evidence.lastTicketAt, not updated_at: a stale concern is not correlated', async () => {
    // An assessment just touched updated_at; its last ticket is 25 h old.
    orgConcerns = [
      orgConcern(1, OA, [1, 2, 3]),
      orgConcern(2, OB, [4, 5, 6], { lastTicketAt: ago(25 * HOUR), created_at: ago(26 * HOUR), updated_at: NOW.toISOString() } as Partial<OrgConcern>),
    ];
    await correlateIncidents(NOW);
    expect(h.upsertConcern).not.toHaveBeenCalled();
    const q = queryWith('wisp:incident-org-concerns')[0]!;
    expect(q.sql).toMatch(/evidence->>'lastTicketAt'/);
    expect(q.sql).not.toMatch(/updated_at/);
    expect(q.params).toContain(ago(60 * MIN));
  });

  it('does not nudge a grantor who dismissed or snoozed the concern', async () => {
    grants.push({ id: G2, partner_id: P, current_revision_id: uid(32) });
    ceilings.set(G2, ceiling(G2, P, [OA, OB, OC]));
    orgConcerns = [orgConcern(1, OA, [1, 2, 3]), orgConcern(2, OB, [4, 5, 6])];
    h.recipientState.mockImplementation(async (_c: string, grantId: string) => (grantId === G2
      ? { nudgeCount: 0, nextEligibleNudgeAt: null, snoozedUntil: new Date(NOW.getTime() + HOUR), dismissedAt: null }
      : { nudgeCount: 0, nextEligibleNudgeAt: null, snoozedUntil: null, dismissedAt: null }));
    await correlateIncidents(NOW);
    expect(h.deliverInApp).toHaveBeenCalledTimes(1);
    expect(h.deliverInApp).toHaveBeenCalledWith(expect.objectContaining({ grantId: G1 }));
  });

  it('a failed delivery is captured and the next grantor is still nudged', async () => {
    grants.push({ id: G2, partner_id: P, current_revision_id: uid(32) });
    ceilings.set(G2, ceiling(G2, P, [OA, OB, OC]));
    orgConcerns = [orgConcern(1, OA, [1, 2, 3]), orgConcern(2, OB, [4, 5, 6])];
    h.deliverInApp.mockImplementationOnce(async () => { throw new Error('insert failed'); });
    const res = await correlateIncidents(NOW);
    expect(res.partnerIncidentsOpened).toBe(1);
    expect(h.deliverInApp).toHaveBeenCalledTimes(2);
    expect(h.recordNudge).toHaveBeenCalledTimes(1);
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('correlateIncidents — auto-close', () => {
  beforeEach(() => { grants = []; });

  it('closes a partner-level incident once every child is resolved or dismissed', async () => {
    candidates = [
      { id: uid(801), org_id: null, created_at: ago(2 * HOUR), last_ticket_at: ago(HOUR), child_count: 2, live_children: 0 },
      { id: uid(802), org_id: null, created_at: ago(2 * HOUR), last_ticket_at: ago(HOUR), child_count: 2, live_children: 1 },
    ];
    await expect(correlateIncidents(NOW)).resolves.toEqual({ partnerIncidentsOpened: 0, updated: 0, autoClosed: 1 });
    expect(h.resolveConcern).toHaveBeenCalledTimes(1);
    expect(h.resolveConcern).toHaveBeenCalledWith(uid(801), {}, 'auto_closed');
  });

  it('closes an incident whose last ticket is older than 24 h even though updated_at is fresh', async () => {
    candidates = [
      { id: uid(803), org_id: null, created_at: ago(30 * HOUR), last_ticket_at: ago(25 * HOUR), child_count: 2, live_children: 2 },
      { id: uid(804), org_id: OA, created_at: ago(30 * HOUR), last_ticket_at: ago(25 * HOUR), child_count: 0, live_children: null },
      { id: uid(805), org_id: OA, created_at: ago(30 * HOUR), last_ticket_at: ago(23 * HOUR), child_count: 0, live_children: null },
      { id: uid(806), org_id: null, created_at: ago(30 * HOUR), last_ticket_at: null, child_count: 1, live_children: 1 },
    ];
    const res = await correlateIncidents(NOW);
    expect(res.autoClosed).toBe(3);
    expect(h.resolveConcern.mock.calls.map((c) => (c as unknown[])[0])).toEqual([uid(803), uid(804), uid(806)]);
    const q = queryWith('wisp:incident-autoclose')[0]!;
    expect(q.sql).toMatch(/subject_kind = 'incident'/);
    expect(q.sql).toMatch(/LIMIT/);
    expect(q.params).toContain(ago(24 * HOUR));
  });

  it('runs even for a partner without a partner-wide grant, and a failed resolve does not stop the pass', async () => {
    candidates = [
      { id: uid(807), org_id: null, created_at: ago(2 * HOUR), last_ticket_at: ago(HOUR), child_count: 1, live_children: 0 },
      { id: uid(808), org_id: null, created_at: ago(2 * HOUR), last_ticket_at: ago(HOUR), child_count: 1, live_children: 0 },
    ];
    h.resolveConcern.mockImplementationOnce(async () => { throw new Error('boom'); });
    await expect(correlateIncidents(NOW)).resolves.toMatchObject({ autoClosed: 1 });
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });
});
