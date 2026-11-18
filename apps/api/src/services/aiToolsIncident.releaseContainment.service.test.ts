import { getTableColumns, getTableName } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Network-isolation W13 (#10101) end to end, with the REAL isolation service:
 * approval-time digest → release-time recompute (the binding) → AI handler →
 * `releaseNetworkIsolation` re-checking the binding under the episode lock.
 * Only the database, trust, crypto, audit and command dispatch are faked (the
 * same seams `networkIsolation/release.gates.test.ts` uses).
 */
const h = vi.hoisted(() => ({
  device: {} as any, row: null as any, writes: [] as any[], dispatch: vi.fn(), trust: vi.fn(), audit: vi.fn(),
}));

vi.mock('../db', () => {
  const chain = (rows: () => unknown[]) => { const promise = Promise.resolve().then(rows); return { limit: () => Object.assign(promise, { for: () => promise }) }; };
  return {
    db: {
      select: () => ({ from: (table: any) => ({ where: () => chain(() => {
        const name = table[Symbol.for('drizzle:Name')];
        if (name === 'devices') return h.device ? [h.device] : [];
        if (name === 'organizations') return [{ partnerId: '44444444-4444-4444-8444-444444444444' }];
        return [];
      }) }) }),
      insert: () => ({ values: async (v: any) => { h.writes.push(v); } }),
      update: () => ({ set: (v: any) => ({ where: () => { h.writes.push(v); return { returning: async () => [{ id: h.row?.id }], then: (resolve: (value: unknown) => unknown) => Promise.resolve().then(resolve) }; } }) }),
    },
    withDbAccessContext: async (_ctx: unknown, fn: () => unknown) => fn(),
    withDbTransaction: async (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => unknown) => fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    runAfterDbContextCommit: vi.fn(),
  };
});
vi.mock('../middleware/auth', () => ({ dbAccessContextFromAuth: () => ({ scope: 'organization' }) }));
vi.mock('./partnerTrust.commands', () => ({
  assertDeviceExecuteAllowed: (...args: unknown[]) => h.trust(...args),
  deviceExecuteAllowedForOrg: async () => true,
  TrustDeniedError: class extends Error {},
}));
vi.mock('./dispatchDeviceCommand', () => ({ dispatchDeviceCommand: (...args: unknown[]) => h.dispatch(...args) }));
vi.mock('./sensitiveCommandPayload', () => ({ encryptSensitivePayloadFields: (_type: string, payload: unknown) => payload }));
vi.mock('./secretCrypto', () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }));
vi.mock('./auditEvents', () => ({ writeRouteAudit: (...args: unknown[]) => h.audit(...args), requestLikeFromSnapshot: () => ({ req: { header: () => undefined } }) }));
vi.mock('./networkIsolation/reconcile', () => ({ ISOLATION_SECRET_COLUMN: { table: 'device_network_isolations', column: 'break_glass_secret_enc', kind: 'text', aadBinding: 'row', description: 'Test' } }));
vi.mock('./networkIsolation/episodeStore', async (original) => {
  const actual = await original<typeof import('./networkIsolation/episodeStore')>();
  return {
    ...actual,
    withEpisodeLock: async (_tx: unknown, id: string, fn: (row: any) => Promise<unknown>) => h.row?.id === id ? { found: true, value: await fn(h.row) } : { found: false },
    writeEpisodeSnapshot: async (tx: any, id: string, prev: any, next: any) => { const written = await actual.writeEpisodeSnapshot(tx, id, prev, next); if (written) h.row = { ...h.row, ...next }; return written; },
  };
});
// aiToolsIncident's own collaborators, none of which the release path may touch.
vi.mock('./aiDispatch', () => ({ aiQueueCommandForExecution: vi.fn() }));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn(async () => undefined) }));
vi.mock('../routes/remote/screenAccessConsentGate', () => ({ checkScreenAccessConsentGate: vi.fn(async () => ({ ok: true })) }));
vi.mock('./aiTools', () => ({ resolveWritableToolOrgId: vi.fn(), verifyDeviceAccess: vi.fn() }));

import type { Database } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { aiQueueCommandForExecution } from './aiDispatch';
import { registerIncidentTools } from './aiToolsIncident';
import { computeEffectDigestForRelease, computeEffectDigestOutcome } from './actionIntents/effectDigest';
import type { ToolExecutionContext } from './toolExecutionContext';

const deviceId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const movedOrgId = '88888888-8888-4888-8888-888888888888';
const isolationId = '33333333-3333-4333-8333-333333333333';
const intentId = '66666666-6666-4666-8666-666666666666';
// A partner technician who can reach both orgs, so an org move is refused for
// the binding and not merely hidden as `device_not_found`.
const auth = {
  user: { id: '55555555-5555-4555-8555-555555555555' },
  canAccessOrg: (id: string) => id === orgId || id === movedOrgId,
  canAccessSite: () => true,
} as unknown as AuthContext;
const args = { deviceId, isolationId, reason: 'Incident contained and cleaned' };

function episode(extra: Record<string, unknown> = {}) {
  return { id: isolationId, deviceId, orgId, state: 'verified', desiredState: 'isolated', generation: 3, lastJournalSeq: 5,
    expiresAt: new Date(Date.now() + 3_600_000), breakGlassSecretEnc: 'enc:stored', breakGlassAckSeq: 2,
    lastAgentReport: { generation: 3 }, releaseConfirmedAt: null, failureCode: null, releaseKind: null, ...extra };
}

/** The digest resolvers' view of the episode table (system context, no RLS). */
const digestDb = {
  select: (shape?: Record<string, unknown>) => {
    let table: any;
    const c: Record<string, unknown> = {};
    c.from = (t: unknown) => { table = t; return c; };
    c.where = () => c;
    c.limit = () => c;
    c.then = (resolve: (value: unknown) => unknown) => {
      const columns = getTableColumns(table);
      const source = getTableName(table) === 'device_network_isolations' && h.row ? [h.row] : [];
      return resolve(source.map((row: Record<string, unknown>) => shape
        ? Object.fromEntries(Object.entries(shape).map(([key, col]) => [key, row[Object.keys(columns).find((n) => columns[n] === col)!]]))
        : row));
    };
    return c;
  },
} as unknown as Database;

function releaseTool(): AiTool {
  const map = new Map<string, AiTool>();
  registerIncidentTools(map);
  return map.get('release_containment')!;
}

/** What the inline chat release / durable worker hand the handler after a MATCHING recompute. */
async function releasePathContext(approvedDigest: string): Promise<ToolExecutionContext | 'content_changed'> {
  const recomputed = await computeEffectDigestForRelease('release_containment', args, digestDb);
  if (recomputed.digest !== approvedDigest) return 'content_changed';
  return { ...recomputed.context, actionIntentId: intentId };
}

async function approve(): Promise<string> {
  const outcome = await computeEffectDigestOutcome('release_containment', args, digestDb);
  if (outcome.kind !== 'pinned') throw new Error('approval must pin the episode');
  return outcome.digest;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.device = { id: deviceId, orgId, siteId: 'site-1', status: 'online' };
  h.row = episode();
  h.writes = [];
  h.trust.mockResolvedValue(undefined);
  h.dispatch.mockImplementation(async (input: { commandId: string }) => ({ ok: true, command: { id: input.commandId }, delivery: 'queued_offline' }));
});

describe('AI release_containment through the real isolation service (W13 #10101)', () => {
  it('an approved release for the current generation queues exactly one release_containment, from the service', async () => {
    const context = await releasePathContext(await approve());
    expect(context).not.toBe('content_changed');
    const out = JSON.parse(await releaseTool().handler(args, auth, context as ToolExecutionContext));
    expect(out).toMatchObject({ success: true });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'release_containment', deviceId, expectedOrgId: orgId,
      payload: { isolationId, generation: 4, reason: 'Incident contained and cleaned' },
    }));
    expect(h.row).toMatchObject({ desiredState: 'released', state: 'release_requested', generation: 4, releaseKind: 'ai' });
    expect(aiQueueCommandForExecution).not.toHaveBeenCalled();
  });

  it('works with NETWORK_ISOLATION_ENABLED off: the flag only ever blocks start (ai.mdx)', async () => {
    vi.stubEnv('NETWORK_ISOLATION_ENABLED', 'false');
    try {
      const context = await releasePathContext(await approve());
      const out = JSON.parse(await releaseTool().handler(args, auth, context as ToolExecutionContext));
      expect(out).toMatchObject({ success: true });
      expect(h.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('an approval for generation N fails closed once an extend made it N+1 (release-path recompute)', async () => {
    const approved = await approve();
    h.row = episode({ generation: 4 }); // extended after approval
    expect(await releasePathContext(approved)).toBe('content_changed');
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('an extend that lands between the recompute and the service call is refused under the episode lock', async () => {
    const context = await releasePathContext(await approve()); // binding for generation 3
    h.row = episode({ generation: 4 });
    const out = JSON.parse(await releaseTool().handler(args, auth, context as ToolExecutionContext));
    expect(out).toEqual({ error: 'approval_mismatch' });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.row).toMatchObject({ desiredState: 'isolated', state: 'verified', generation: 4 });
  });

  it('an approval issued before an org move fails after it (release-path recompute)', async () => {
    const approved = await approve();
    h.row = episode({ orgId: movedOrgId });
    h.device = { ...h.device, orgId: movedOrgId };
    expect(await releasePathContext(approved)).toBe('content_changed');
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('an org move that lands between the recompute and the service call is refused under the episode lock', async () => {
    const context = await releasePathContext(await approve()); // binding for the original org
    h.row = episode({ orgId: movedOrgId });
    h.device = { ...h.device, orgId: movedOrgId };
    const out = JSON.parse(await releaseTool().handler(args, auth, context as ToolExecutionContext));
    expect(out).toEqual({ error: 'approval_mismatch' });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('a second release from the same approval is refused: the first release bumped the generation', async () => {
    const context = await releasePathContext(await approve());
    expect(JSON.parse(await releaseTool().handler(args, auth, context as ToolExecutionContext))).toMatchObject({ success: true });
    expect(JSON.parse(await releaseTool().handler(args, auth, context as ToolExecutionContext))).toEqual({ error: 'approval_mismatch' });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('an episode that disappeared surfaces isolation_not_found as a tool error', async () => {
    const context = await releasePathContext(await approve());
    h.row = null;
    const out = JSON.parse(await releaseTool().handler(args, auth, context as ToolExecutionContext));
    expect(out).toEqual({ error: 'isolation_not_found' });
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});
