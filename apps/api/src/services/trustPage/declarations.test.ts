import { describe, expect, it, vi, beforeEach } from 'vitest';

const dbm = vi.hoisted(() => ({ transaction: vi.fn(), select: vi.fn() }));
vi.mock('../../db', () => ({ db: dbm, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() }));

import { declareTrustControl, listTrustDeclarations, withdrawTrustDeclaration } from './declarations';
import type { TrustPageRow } from '../../db/schema/trustPages';

const DAY_MS = 86_400_000;
const page = { id: 'page-1', orgId: 'org-1', partnerId: 'partner-1' } as unknown as TrustPageRow;

interface Op { kind: 'select' | 'update' | 'insert'; payload?: Record<string, unknown> }

/**
 * Scripted transaction: each tx.select/update/insert records an op (with its .set()/.values() payload) and,
 * when awaited, resolves to the next scripted result. Order is the service's deterministic query order,
 * starting with withTrustPageRevision's row lock and ending with its revision bump.
 */
function scriptTx(results: unknown[], ops: Op[]) {
  dbm.transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
    const builder = (op: Op): unknown => {
      ops.push(op);
      let settled: Promise<unknown> | null = null;
      const proxy: unknown = new Proxy(function () { /* target */ }, {
        get(_t, prop) {
          if (prop === 'then') {
            settled ??= Promise.resolve(results.shift());
            return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settled!.then(res, rej);
          }
          return (...args: unknown[]) => {
            if (prop === 'set' || prop === 'values') op.payload = args[0] as Record<string, unknown>;
            return proxy;
          };
        },
      });
      return proxy;
    };
    return fn({
      select: () => builder({ kind: 'select' }),
      update: () => builder({ kind: 'update' }),
      insert: () => builder({ kind: 'insert' }),
    });
  });
}

const declareArgs = (over: Partial<Parameters<typeof declareTrustControl>[0]> = {}) => ({
  page, controlId: 'incident_response_plan' as const, statement: 'We keep a tested incident response plan.',
  evidenceDocumentId: null, actorUserId: 'user-1', partnerName: 'Acme MSP', expectedRevision: 3,
  now: new Date('2026-10-17T12:00:00.000Z'), ...over,
});

beforeEach(() => { dbm.transaction.mockReset(); dbm.select.mockReset(); });

describe('declareTrustControl', () => {
  it('a first declaration expires exactly 365 days after it is declared, both from one now', async () => {
    const ops: Op[] = [];
    scriptTx([[{ rev: 3 }], [], [{ id: 'new-1', controlId: 'incident_response_plan' }], [{ publicationRevision: 4 }]], ops);
    const out = await declareTrustControl(declareArgs());
    expect(out).toMatchObject({ declaration: { id: 'new-1' }, superseded: null, publicationRevision: 4 });
    const insert = ops.find((o) => o.kind === 'insert')!;
    const declaredAt = insert.payload!.declaredAt as Date;
    const expiresAt = insert.payload!.expiresAt as Date;
    expect(declaredAt.toISOString()).toBe('2026-10-17T12:00:00.000Z');
    expect(expiresAt.getTime() - declaredAt.getTime()).toBe(365 * DAY_MS);
    expect(insert.payload).toMatchObject({
      trustPageId: 'page-1', orgId: 'org-1', controlId: 'incident_response_plan', declaredByPartnerName: 'Acme MSP',
      declaredByUserId: 'user-1', evidenceDocumentId: null, evidenceDocumentSha256: null,
    });
    // No supersede update: lock, active lookup, insert, revision bump.
    expect(ops.map((o) => o.kind)).toEqual(['select', 'select', 'insert', 'update']);
  });

  it('a re-declaration stamps superseded_at on the active row BEFORE inserting, and returns its id', async () => {
    const ops: Op[] = [];
    scriptTx([[{ rev: 3 }], [{ id: 'old-1' }], [{ id: 'old-1' }], [{ id: 'new-2' }], [{ publicationRevision: 4 }]], ops);
    const out = await declareTrustControl(declareArgs());
    expect(out.superseded).toBe('old-1');
    expect(ops.map((o) => o.kind)).toEqual(['select', 'select', 'update', 'insert', 'update']);
    expect((ops[2]!.payload!.supersededAt as Date).toISOString()).toBe('2026-10-17T12:00:00.000Z');
  });

  it('a stale revision is 409 and writes nothing', async () => {
    const ops: Op[] = [];
    scriptTx([[{ rev: 7 }]], ops);
    await expect(declareTrustControl(declareArgs())).rejects.toMatchObject({ status: 409, code: 'REVISION_MISMATCH' });
    expect(ops.map((o) => o.kind)).toEqual(['select']);
  });

  it('a superseded / deleted / foreign evidence document is 422 EVIDENCE_UNAVAILABLE', async () => {
    const ops: Op[] = [];
    scriptTx([[{ rev: 3 }], []], ops);
    await expect(declareTrustControl(declareArgs({ evidenceDocumentId: '7b0c6a52-58a2-4c8e-9d0c-1a2b3c4d5e6f' })))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_UNAVAILABLE' });
    expect(ops.some((o) => o.kind === 'insert')).toBe(false);
  });

  it('a live evidence document has its sha256 copied onto the declaration', async () => {
    const ops: Op[] = [];
    const sha = 'a'.repeat(64);
    scriptTx([[{ rev: 3 }], [{ id: 'doc-1', sha256: sha }], [], [{ id: 'new-3' }], [{ publicationRevision: 4 }]], ops);
    await declareTrustControl(declareArgs({ evidenceDocumentId: 'doc-1' }));
    expect(ops.find((o) => o.kind === 'insert')!.payload).toMatchObject({ evidenceDocumentId: 'doc-1', evidenceDocumentSha256: sha });
  });

  it('a claim that lost the race (supersede matched no row) is a 409, not a unique-index 500', async () => {
    scriptTx([[{ rev: 3 }], [{ id: 'old-1' }], []], []);
    await expect(declareTrustControl(declareArgs())).rejects.toMatchObject({ status: 409 });
  });
});

describe('withdrawTrustDeclaration', () => {
  it('withdraws the active row and its superseded predecessors, and bumps the revision', async () => {
    const ops: Op[] = [];
    scriptTx([[{ rev: 3 }], [{ id: 'd-1', controlId: 'incident_response_plan' }], [{ id: 'd-0' }], [{ publicationRevision: 4 }]], ops);
    const out = await withdrawTrustDeclaration({ page, declarationId: 'd-1', actorUserId: 'user-1', expectedRevision: 3 });
    expect(out).toEqual({ publicationRevision: 4, controlId: 'incident_response_plan', withdrawnPredecessorIds: ['d-0'] });
    expect(ops.map((o) => o.kind)).toEqual(['select', 'update', 'update', 'update']);
    expect(ops[1]!.payload).toMatchObject({ withdrawnByUserId: 'user-1' });
    expect(ops[1]!.payload!.withdrawnAt).toBeInstanceOf(Date);
    expect(ops[2]!.payload).toMatchObject({ withdrawnByUserId: 'user-1' });
  });

  it('an already-withdrawn (or superseded, or unknown) id is 404 and the revision is not bumped', async () => {
    const ops: Op[] = [];
    scriptTx([[{ rev: 3 }], []], ops);
    await expect(withdrawTrustDeclaration({ page, declarationId: 'd-1', actorUserId: 'user-1', expectedRevision: 3 }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(ops.map((o) => o.kind)).toEqual(['select', 'update']);
  });

  it('a stale revision is 409', async () => {
    scriptTx([[{ rev: 9 }]], []);
    await expect(withdrawTrustDeclaration({ page, declarationId: 'd-1', actorUserId: 'user-1', expectedRevision: 3 }))
      .rejects.toMatchObject({ status: 409 });
  });
});

describe('listTrustDeclarations', () => {
  it('reads active rows and the bounded history separately', async () => {
    const result = (rows: unknown[]) => {
      const chain: unknown = new Proxy(function () { /* target */ }, {
        get(_t, prop) {
          if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
          return () => chain;
        },
      });
      return chain;
    };
    dbm.select.mockReturnValueOnce(result([{ id: 'a' }])).mockReturnValueOnce(result([{ id: 'b' }, { id: 'c' }]));
    const out = await listTrustDeclarations(page);
    expect(out.active.map((r) => r.id)).toEqual(['a']);
    expect(out.history.map((r) => r.id)).toEqual(['b', 'c']);
  });
});
