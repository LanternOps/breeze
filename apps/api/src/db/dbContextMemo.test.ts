/**
 * getDbContextMemo: a map that lives exactly as long as the OUTERMOST DB
 * context in this async scope (one request transaction, one job context).
 * Joined inner contexts and savepoints share it; a separate context (another
 * request, or a nested escalation opened through runOutsideDbContext) gets its
 * own; outside any context there is none. That is what makes it a per-request
 * memo and never a cross-request cache.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { drizzleFactory } = vi.hoisted(() => {
  const tx = {
    execute: () => Promise.resolve([]),
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
  const drizzleFactory = vi.fn(() => ({
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  }));
  return { drizzleFactory };
});

vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: drizzleFactory }));
vi.mock('postgres', () => ({
  default: vi.fn(() => Object.assign(vi.fn(), { options: { parsers: {}, serializers: {} } })),
}));

const originalEnv = { ...process.env };
const ORG = '44444444-4444-4444-8444-444444444444';
const NS = Symbol('dbContextMemo.test');
const OTHER_NS = Symbol('dbContextMemo.test.other');

describe('getDbContextMemo', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
    process.env.DATABASE_URL_APP = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('is shared by joined inner contexts and savepoints of one outermost context', async () => {
    const db = await import('./index');
    await db.withSystemDbAccessContext(async () => {
      const outer = db.getDbContextMemo(NS);
      expect(outer).toBeInstanceOf(Map);
      await db.withDbAccessContext({ scope: 'organization', orgId: ORG, accessibleOrgIds: [ORG] }, async () => {
        expect(db.getDbContextMemo(NS)).toBe(outer);
        await db.withDbTransaction(async () => {
          expect(db.getDbContextMemo(NS)).toBe(outer);
        });
      });
      expect(db.getDbContextMemo(OTHER_NS)).not.toBe(outer);
    });
  });

  it('is a new map for each outermost context, so nothing carries across requests', async () => {
    const db = await import('./index');
    const first = await db.withSystemDbAccessContext(async () => {
      const memo = db.getDbContextMemo<string>(NS)!;
      memo.set('k', 'remembered');
      return memo;
    });
    const second = await db.withSystemDbAccessContext(async () => db.getDbContextMemo<string>(NS)!);
    expect(second).not.toBe(first);
    expect(second.has('k')).toBe(false);
  });

  it('a context opened through runOutsideDbContext gets its own map, and the outer one is intact after', async () => {
    const db = await import('./index');
    await db.withSystemDbAccessContext(async () => {
      const outer = db.getDbContextMemo(NS);
      const nested = await db.runOutsideDbContext(() =>
        db.withSystemDbAccessContext(async () => db.getDbContextMemo(NS)),
      );
      expect(nested).toBeInstanceOf(Map);
      expect(nested).not.toBe(outer);
      expect(db.getDbContextMemo(NS)).toBe(outer);
    });
  });

  it('is undefined outside any context and inside runOutsideDbContext', async () => {
    const db = await import('./index');
    expect(db.getDbContextMemo(NS)).toBeUndefined();
    await db.withSystemDbAccessContext(async () => {
      expect(db.runOutsideDbContext(() => db.getDbContextMemo(NS))).toBeUndefined();
    });
  });
});
