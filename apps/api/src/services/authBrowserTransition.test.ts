import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as authBrowserTransitionModule from './authBrowserTransition';
import {
  getSecretDerivedKeyMaterials,
  type SecretDerivedKeyMaterials,
} from './secretCrypto';

type TransitionState = 'active' | 'logout_pending' | 'retired';

interface TransitionRow {
  id: string;
  bindingDigest: string;
  generation: number;
  state: TransitionState;
  activeOperationId: string | null;
  activeOperationExpiresAt: Date | null;
  currentUserId: string | null;
  currentFamilyId: string | null;
  logoutId: string | null;
  completionNonceDigest: string | null;
  logoutExpiresAt: Date | null;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const harness = vi.hoisted(() => {
  const columns = {
    id: 'id',
    bindingDigest: 'bindingDigest',
    generation: 'generation',
    state: 'state',
    activeOperationId: 'activeOperationId',
    activeOperationExpiresAt: 'activeOperationExpiresAt',
    currentUserId: 'currentUserId',
    currentFamilyId: 'currentFamilyId',
    logoutId: 'logoutId',
    completionNonceDigest: 'completionNonceDigest',
    logoutExpiresAt: 'logoutExpiresAt',
    retiredAt: 'retiredAt',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  };
  return {
    columns,
    rows: new Map<string, TransitionRow>(),
    now: new Date('2026-07-12T20:00:00.000Z'),
    authorityWrites: [] as string[],
    transactionEvents: [] as string[],
    nextId: 1,
  };
});

type Predicate =
  | { eq: [string, unknown] }
  | { and: Predicate[] }
  | undefined;

function cloneRow(row: TransitionRow): TransitionRow {
  return structuredClone(row);
}

function cloneRows(): Map<string, TransitionRow> {
  return new Map([...harness.rows].map(([key, row]) => [key, cloneRow(row)]));
}

function evaluatePredicate(row: TransitionRow, predicate: Predicate): boolean {
  if (!predicate) return true;
  if ('and' in predicate) return predicate.and.every((clause) => evaluatePredicate(row, clause));
  const [column, expected] = predicate.eq;
  const actual = row[column as keyof TransitionRow];
  if (actual instanceof Date && expected instanceof Date) {
    return actual.getTime() === expected.getTime();
  }
  return actual === expected;
}

function resolveSqlValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('sql' in value)) return value;
  const expression = String((value as { sql: string }).sql);
  if (expression.includes('interval')) {
    return new Date(harness.now.getTime() + 2 * 60 * 1000);
  }
  if (expression.includes('now()')) return new Date(harness.now);
  return value;
}

function projectRow(row: TransitionRow, fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([name, field]) => {
    if (field && typeof field === 'object' && 'sql' in field) {
      return [name, new Date(harness.now)];
    }
    return [name, row[String(field) as keyof TransitionRow]];
  }));
}

function makeTransaction() {
  return {
    insert: vi.fn(() => ({
      values: (values: Partial<TransitionRow>) => ({
        onConflictDoNothing: async () => {
          const exists = [...harness.rows.values()].some(
            (row) => row.bindingDigest === values.bindingDigest,
          );
          if (!exists) {
            const id = `00000000-0000-4000-8000-${String(harness.nextId++).padStart(12, '0')}`;
            harness.rows.set(id, {
              id,
              bindingDigest: String(values.bindingDigest),
              generation: 1,
              state: 'active',
              activeOperationId: null,
              activeOperationExpiresAt: null,
              currentUserId: null,
              currentFamilyId: null,
              logoutId: null,
              completionNonceDigest: null,
              logoutExpiresAt: null,
              retiredAt: null,
              createdAt: new Date(harness.now),
              updatedAt: new Date(harness.now),
            });
          }
        },
      }),
    })),
    select: vi.fn((fields: Record<string, unknown>) => ({
      from: () => {
        let predicate: Predicate;
        const query = {
          where(next: Predicate) {
            predicate = next;
            return query;
          },
          for() {
            return query;
          },
          async limit() {
            const row = [...harness.rows.values()].find((candidate) =>
              evaluatePredicate(candidate, predicate),
            );
            return row ? [projectRow(row, fields)] : [];
          },
        };
        return query;
      },
    })),
    update: vi.fn(() => ({
      set: (values: Partial<TransitionRow>) => ({
        where: (predicate: Predicate) => ({
          returning: async (fields: Record<string, unknown>) => {
            const row = [...harness.rows.values()].find((candidate) =>
              evaluatePredicate(candidate, predicate),
            );
            if (!row) return [];
            for (const [key, value] of Object.entries(values)) {
              (row as unknown as Record<string, unknown>)[key] = resolveSqlValue(value);
            }
            return [projectRow(row, fields)];
          },
        }),
      }),
    })),
  };
}

vi.mock('drizzle-orm', () => ({
  and: (...clauses: Predicate[]) => ({ and: clauses }),
  eq: (left: string, right: unknown) => ({ eq: [left, right] }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: Array.from(strings).join('?'),
    values,
  }),
}));

vi.mock('../db/schema/authBrowserTransitions', () => ({
  authBrowserTransitions: harness.columns,
}));

vi.mock('./authLifecycle', () => ({
  withAuthLifecycleSystemTransaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    const rowSnapshot = cloneRows();
    const writeSnapshot = [...harness.authorityWrites];
    harness.transactionEvents.push('begin');
    try {
      const result = await callback(makeTransaction());
      harness.transactionEvents.push('commit');
      return result;
    } catch (error) {
      harness.rows.clear();
      for (const [id, row] of rowSnapshot) harness.rows.set(id, row);
      harness.authorityWrites.splice(0, harness.authorityWrites.length, ...writeSnapshot);
      harness.transactionEvents.push('rollback');
      throw error;
    }
  }),
}));

import {
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  AuthIssuanceCapabilityError,
  AuthIssuanceConflictError,
  beginAuthIssuance,
  cancelAuthIssuance,
  completeTerminalLogout,
  isTerminalLogoutPending,
  finishAuthIssuance,
  resolveAuthBinding,
  rotateExpiredBinding,
  type AuthBindingSource,
  type AuthIssuanceCapability,
} from './authBrowserTransition';

const BINDING_KEY = 'task-3-app-encryption-key-material-at-least-32-bytes';
const OLD_BINDING_KEY = 'task-3-old-encryption-key-material-at-least-32-bytes';

function derivedKey(source: string): Buffer {
  const encryptionKey = createHash('sha256').update(source).digest();
  return createHmac('sha256', encryptionKey)
    .update('breeze-secret-derived-key:v1\0auth-browser-binding:v1')
    .digest();
}

function signedBinding(keySource: string, payload = 'a'.repeat(32)): string {
  const tag = createHmac('sha256', derivedKey(keySource))
    .update(`auth-browser-binding-value:v1:browser:${payload}`)
    .digest('hex')
    .slice(0, 32);
  return `${payload}${tag}`;
}

const C1 = signedBinding(BINDING_KEY);

function browser(value = C1): AuthBindingSource {
  return { kind: 'browser', value };
}

function rowFor(source: AuthBindingSource): TransitionRow {
  const digest = resolveAuthBinding(source).bindingDigest;
  const row = [...harness.rows.values()].find((candidate) => candidate.bindingDigest === digest);
  if (!row) throw new Error('transition row was not created');
  return row;
}

function seedTransition(source: AuthBindingSource, overrides: Partial<TransitionRow> = {}): TransitionRow {
  const bindingDigest = resolveAuthBinding(source).bindingDigest;
  const row: TransitionRow = {
    id: `10000000-0000-4000-8000-${String(harness.nextId++).padStart(12, '0')}`,
    bindingDigest,
    generation: 1,
    state: 'active',
    activeOperationId: null,
    activeOperationExpiresAt: null,
    currentUserId: null,
    currentFamilyId: null,
    logoutId: null,
    completionNonceDigest: null,
    logoutExpiresAt: null,
    retiredAt: null,
    createdAt: new Date(harness.now),
    updatedAt: new Date(harness.now),
    ...overrides,
  };
  harness.rows.set(row.id, row);
  return row;
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  delete process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY_ID = 'current';
  process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ current: BINDING_KEY });
  harness.rows.clear();
  harness.now = new Date('2026-07-12T20:00:00.000Z');
  harness.authorityWrites.length = 0;
  harness.transactionEvents.length = 0;
  harness.nextId = 1;
  vi.clearAllMocks();
});

describe('auth browser binding', () => {
  it('uses a deterministic domain-separated HMAC and never returns the raw binding', () => {
    const first = resolveAuthBinding(browser());
    const second = resolveAuthBinding(browser());
    const expected = createHmac('sha256', derivedKey(BINDING_KEY))
      .update(`auth-browser-binding:v1:${C1}`)
      .digest('hex');

    expect(first.bindingDigest).toBe(expected);
    expect(second.bindingDigest).toBe(expected);
    expect(first.bindingDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.bindingDigest).not.toBe(C1);
    expect(first).not.toHaveProperty('source');
    expect(JSON.stringify(first)).not.toContain(C1);
  });

  it('returns a fresh 256-bit browser binding in the HTTP-428 domain outcome when missing', () => {
    expect.assertions(4);
    try {
      resolveAuthBinding(undefined);
    } catch (error) {
      expect(error).toBeInstanceOf(AuthBindingRotationRequiredError);
      expect(error).toMatchObject({ status: 428, reason: 'missing' });
      expect((error as AuthBindingRotationRequiredError).replacement).toMatchObject({
        kind: 'browser',
        value: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect((error as AuthBindingRotationRequiredError).replacement.value).not.toBe(C1);
    }
  });

  it('uses the unique retained signer key as the canonical digest key across active-key rotation', () => {
    const oldValue = signedBinding(OLD_BINDING_KEY, 'd'.repeat(32));
    process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({
      old: OLD_BINDING_KEY,
      current: BINDING_KEY,
    });

    const resolved = resolveAuthBinding(browser(oldValue));
    const expected = createHmac('sha256', derivedKey(OLD_BINDING_KEY))
      .update(`auth-browser-binding:v1:${oldValue}`)
      .digest('hex');

    expect(resolved.bindingDigest).toBe(expected);
  });

  it('fails closed when no retained key validates the binding tag', () => {
    expect(() => resolveAuthBinding(browser('f'.repeat(64)))).toThrowError(
      expect.objectContaining({
        constructor: AuthBindingRotationRequiredError,
        status: 428,
        reason: 'invalid',
      }),
    );
  });

  it('fails closed when multiple retained key IDs validate the binding tag', () => {
    process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({
      current: BINDING_KEY,
      duplicate: BINDING_KEY,
    });

    expect(() => resolveAuthBinding(browser())).toThrowError(
      expect.objectContaining({
        constructor: AuthBindingRotationRequiredError,
        status: 428,
        reason: 'invalid',
      }),
    );
  });

  it('creates isolated old-active and new-active services that resolve one signer digest', () => {
    const factory = (authBrowserTransitionModule as typeof authBrowserTransitionModule & {
      createAuthBrowserTransitionService: (
        provider: () => SecretDerivedKeyMaterials,
      ) => { resolveAuthBinding: typeof resolveAuthBinding };
    }).createAuthBrowserTransitionService;
    expect(factory).toBeTypeOf('function');

    process.env.APP_ENCRYPTION_KEY_ID = 'old';
    process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({
      old: OLD_BINDING_KEY,
      current: BINDING_KEY,
    });
    const oldActive = getSecretDerivedKeyMaterials('auth-browser-binding:v1');
    process.env.APP_ENCRYPTION_KEY_ID = 'current';
    const newActive = getSecretDerivedKeyMaterials('auth-browser-binding:v1');
    const oldService = factory(() => oldActive);
    const newService = factory(() => newActive);
    const binding = (() => {
      try {
        oldService.resolveAuthBinding(undefined);
      } catch (error) {
        if (error instanceof AuthBindingRotationRequiredError) return error.replacement;
        throw error;
      }
      throw new Error('Missing binding did not produce a replacement');
    })();

    expect(oldService.resolveAuthBinding(binding).bindingDigest).toBe(
      newService.resolveAuthBinding(binding).bindingDigest,
    );
  });
});

describe('auth issuance admission', () => {
  it('reserves one bounded operation lease on an active binding', async () => {
    const capability = await beginAuthIssuance(browser());
    const row = rowFor(browser());

    expect(capability).toMatchObject({
      transitionId: row.id,
      generation: 1,
      operationId: row.activeOperationId,
      expiresAt: row.activeOperationExpiresAt,
    });
    expect(capability.expiresAt.getTime()).toBeGreaterThan(harness.now.getTime());
    expect(capability.expiresAt.getTime()).toBeLessThanOrEqual(
      harness.now.getTime() + 5 * 60 * 1000,
    );
  });

  it('rejects a second unexpired operation without replacing the owner', async () => {
    const first = await beginAuthIssuance(browser());

    await expect(beginAuthIssuance(browser())).rejects.toBeInstanceOf(AuthIssuanceConflictError);
    expect(rowFor(browser()).activeOperationId).toBe(first.operationId);
  });

  it('replaces an expired operation and makes the stale capability unusable', async () => {
    const stale = await beginAuthIssuance(browser());
    harness.now = new Date(stale.expiresAt.getTime() + 1);

    const current = await beginAuthIssuance(browser());

    expect(current.operationId).not.toBe(stale.operationId);
    await expect(finishAuthIssuance(stale, async () => 'stale')).rejects.toBeInstanceOf(
      AuthIssuanceCapabilityError,
    );
    await expect(finishAuthIssuance(current, async () => 'current')).resolves.toBe('current');
  });

  it('rejects a live logout-pending binding', async () => {
    seedTransition(browser(), {
      state: 'logout_pending',
      generation: 2,
      logoutId: '20000000-0000-4000-8000-000000000001',
      completionNonceDigest: 'b'.repeat(64),
      logoutExpiresAt: new Date(harness.now.getTime() + 60_000),
    });

    await expect(beginAuthIssuance(browser())).rejects.toMatchObject({
      constructor: AuthBindingUnavailableError,
      reason: 'logout_pending',
    });
  });

  it('rejects a retired binding with a fresh HTTP-428 replacement', async () => {
    seedTransition(browser(), {
      state: 'retired',
      retiredAt: new Date(harness.now),
    });

    await expect(beginAuthIssuance(browser())).rejects.toMatchObject({
      constructor: AuthBindingRotationRequiredError,
      status: 428,
      reason: 'retired',
      replacement: { kind: 'browser', value: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
  });
});

describe('auth issuance finalization', () => {
  it.each([
    ['missing transition', (row: TransitionRow, capability: AuthIssuanceCapability) => {
      harness.rows.delete(capability.transitionId);
    }],
    ['wrong generation', (row: TransitionRow) => { row.generation += 1; }],
    ['expired lease', (_row: TransitionRow, capability: AuthIssuanceCapability) => {
      harness.now = new Date(capability.expiresAt.getTime() + 1);
    }],
    ['pending state', (row: TransitionRow) => {
      row.state = 'logout_pending';
      row.generation += 1;
      row.logoutId = '20000000-0000-4000-8000-000000000002';
      row.completionNonceDigest = 'c'.repeat(64);
      row.logoutExpiresAt = new Date(harness.now.getTime() + 60_000);
    }],
  ])('rejects %s before invoking the callback', async (_label, mutate) => {
    const capability = await beginAuthIssuance(browser());
    const row = rowFor(browser());
    mutate(row, capability);
    const callback = vi.fn(async () => 'should-not-run');

    await expect(finishAuthIssuance(capability, callback)).rejects.toBeInstanceOf(
      AuthIssuanceCapabilityError,
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it('commits callback writes and operation clearing in the same system transaction', async () => {
    const capability = await beginAuthIssuance(browser());

    const result = await finishAuthIssuance(capability, async () => {
      harness.authorityWrites.push('family-created');
      return 'issued';
    });

    expect(result).toBe('issued');
    expect(harness.authorityWrites).toEqual(['family-created']);
    expect(rowFor(browser())).toMatchObject({
      activeOperationId: null,
      activeOperationExpiresAt: null,
    });
    expect(harness.transactionEvents.slice(-2)).toEqual(['begin', 'commit']);
  });

  it('rolls back callback writes and retains the lease when the callback fails', async () => {
    const capability = await beginAuthIssuance(browser());

    await expect(finishAuthIssuance(capability, async () => {
      harness.authorityWrites.push('partial-family');
      throw new Error('callback failed');
    })).rejects.toThrow('callback failed');

    expect(harness.authorityWrites).toEqual([]);
    expect(rowFor(browser()).activeOperationId).toBe(capability.operationId);
    expect(harness.transactionEvents.slice(-2)).toEqual(['begin', 'rollback']);
  });

  it('rejects structurally forged capabilities without the private runtime brand', async () => {
    const forged = {
      transitionId: '00000000-0000-4000-8000-000000000001',
      generation: 1,
      operationId: '00000000-0000-4000-8000-000000000002',
      expiresAt: new Date(harness.now.getTime() + 60_000),
    } as AuthIssuanceCapability;

    await expect(finishAuthIssuance(forged, async () => 'forged')).rejects.toBeInstanceOf(
      AuthIssuanceCapabilityError,
    );
    expect(harness.transactionEvents).toEqual([]);
  });
});

describe('auth issuance cancellation', () => {
  it('clears the exact operation and permits an immediate retry', async () => {
    const abandoned = await beginAuthIssuance(browser());

    await expect(cancelAuthIssuance(abandoned)).resolves.toBe(true);
    expect(rowFor(browser())).toMatchObject({
      activeOperationId: null,
      activeOperationExpiresAt: null,
    });

    await expect(beginAuthIssuance(browser())).resolves.toMatchObject({
      transitionId: abandoned.transitionId,
      generation: abandoned.generation,
      operationId: expect.not.stringMatching(abandoned.operationId),
    });
  });

  it('cannot clear a replacement operation owned by a stale capability', async () => {
    const stale = await beginAuthIssuance(browser());
    harness.now = new Date(stale.expiresAt.getTime() + 1);
    const current = await beginAuthIssuance(browser());

    await expect(cancelAuthIssuance(stale)).resolves.toBe(false);
    expect(rowFor(browser()).activeOperationId).toBe(current.operationId);
  });

  it('does not clear a retired generation', async () => {
    const capability = await beginAuthIssuance(browser());
    const row = rowFor(browser());
    row.state = 'retired';
    row.generation += 1;

    await expect(cancelAuthIssuance(capability)).resolves.toBe(false);
    expect(row.activeOperationId).toBe(capability.operationId);
  });
});

describe('binding rotation', () => {
  it.each(['expired', 'retired'] as const)(
    'rotates an %s C1 to C2 while C1 remains permanently inadmissible',
    async (kind) => {
      seedTransition(browser(), kind === 'expired'
        ? {
            state: 'logout_pending',
            generation: 2,
            logoutId: '20000000-0000-4000-8000-000000000003',
            completionNonceDigest: 'd'.repeat(64),
            logoutExpiresAt: new Date(harness.now.getTime() - 1),
          }
        : {
            state: 'retired',
            generation: 2,
            retiredAt: new Date(harness.now),
          });

      const c2 = await rotateExpiredBinding(browser());

      expect(c2).toMatchObject({
        kind: 'browser',
        value: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(c2.value).not.toBe(C1);
      expect(rowFor(browser()).state).toBe('retired');
      await expect(beginAuthIssuance(browser())).rejects.toMatchObject({ status: 428 });
      await expect(beginAuthIssuance(c2)).resolves.toMatchObject({ generation: 1 });
    },
  );

  it('returns one deterministic C2 and creates exactly one active successor under concurrency', async () => {
    seedTransition(browser(), {
      state: 'retired',
      generation: 3,
      retiredAt: new Date(harness.now),
    });

    const [left, right] = await Promise.all([
      rotateExpiredBinding(browser()),
      rotateExpiredBinding(browser()),
    ]);

    expect(left).toEqual(right);
    expect(left.value).not.toBe(C1);
    expect([...harness.rows.values()].filter((row) => row.state === 'active')).toHaveLength(1);
    expect(harness.rows).toHaveLength(2);
  });

  it('finds and retires an old-key C1 under a new active keyring without reopening it', async () => {
    const oldValue = signedBinding(OLD_BINDING_KEY, 'b'.repeat(32));
    process.env.APP_ENCRYPTION_KEY_ID = 'old';
    process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ old: OLD_BINDING_KEY });
    const predecessor = seedTransition(browser(oldValue), {
      state: 'logout_pending',
      generation: 4,
      logoutId: '20000000-0000-4000-8000-000000000004',
      completionNonceDigest: 'e'.repeat(64),
      logoutExpiresAt: new Date(harness.now.getTime() - 1),
    });
    const oldDigest = predecessor.bindingDigest;
    process.env.APP_ENCRYPTION_KEY_ID = 'current';
    process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({
      old: OLD_BINDING_KEY,
      current: BINDING_KEY,
    });

    const successor = await rotateExpiredBinding(browser(oldValue));

    expect(successor.value).not.toBe(oldValue);
    expect(harness.rows.get(predecessor.id)).toMatchObject({
      state: 'retired',
      activeOperationId: null,
      activeOperationExpiresAt: null,
    });
    expect([...harness.rows.values()].filter((row) => row.bindingDigest === oldDigest)).toHaveLength(1);
    expect(harness.rows).toHaveLength(2);
  });

  it('fails closed instead of reopening an old C1 when its retired key is missing', async () => {
    const oldValue = signedBinding(OLD_BINDING_KEY, 'c'.repeat(32));
    process.env.APP_ENCRYPTION_KEY_ID = 'old';
    process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ old: OLD_BINDING_KEY });
    const predecessor = seedTransition(browser(oldValue), {
      state: 'retired',
      retiredAt: new Date(harness.now),
    });
    process.env.APP_ENCRYPTION_KEY_ID = 'current';
    process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ current: BINDING_KEY });

    await expect(beginAuthIssuance(browser(oldValue))).rejects.toMatchObject({
      constructor: AuthBindingRotationRequiredError,
      status: 428,
    });
    expect(harness.rows.get(predecessor.id)?.state).toBe('retired');
    expect(harness.rows).toHaveLength(1);
    const reopenedCurrentDigest = createHmac('sha256', derivedKey(BINDING_KEY))
      .update(`auth-browser-binding:v1:${oldValue}`)
      .digest('hex');
    expect([...harness.rows.values()].some(
      (row) => row.bindingDigest === reopenedCurrentDigest,
    )).toBe(false);
  });
});

describe('terminal logout completion', () => {
  const logoutId = '20000000-0000-4000-8000-000000000005';
  const nonce = 'f1'.repeat(32);

  function seedPending(generation = 2): TransitionRow {
    return seedTransition(browser(), {
      state: 'logout_pending',
      generation,
      logoutId,
      completionNonceDigest: createHash('sha256').update(nonce).digest('hex'),
      logoutExpiresAt: new Date(harness.now.getTime() + 60_000),
    });
  }

  it('consumes the exact pending nonce, retires C1, and creates active C2 atomically', async () => {
    const predecessor = seedPending();

    const result = await completeTerminalLogout({
      transitionId: predecessor.id,
      logoutId,
      generation: predecessor.generation,
      nonce,
      signingKeyId: 'current',
    });

    expect(result).toMatchObject({
      kind: 'completed',
      replacement: { kind: 'browser', value: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    if (result.kind === 'invalid') throw new Error('Expected completion to succeed');
    expect(result.replacement.value).not.toBe(C1);
    expect(harness.rows.get(predecessor.id)).toMatchObject({
      state: 'retired',
      retiredAt: harness.now,
      activeOperationId: null,
      activeOperationExpiresAt: null,
    });
    await expect(beginAuthIssuance(result.replacement)).resolves.toMatchObject({ generation: 1 });
  });

  it('authorizes navigation only for the exact live pending row', async () => {
    const predecessor = seedPending(3);
    const exact = {
      transitionId: predecessor.id,
      logoutId,
      generation: predecessor.generation,
      nonce,
    };

    await expect(isTerminalLogoutPending(exact)).resolves.toBe(true);
    await expect(isTerminalLogoutPending({ ...exact, generation: 2 })).resolves.toBe(false);
    await expect(isTerminalLogoutPending({ ...exact, nonce: 'f2'.repeat(32) })).resolves.toBe(false);

    await completeTerminalLogout({ ...exact, signingKeyId: 'current' });
    await expect(isTerminalLogoutPending(exact)).resolves.toBe(false);
  });

  it('returns one deterministic C2 for concurrent completion and mutates only once', async () => {
    const predecessor = seedPending();

    const [left, right] = await Promise.all([leftCompletion(), leftCompletion()]);

    function leftCompletion() {
      return completeTerminalLogout({
        transitionId: predecessor.id,
        logoutId,
        generation: predecessor.generation,
        nonce,
        signingKeyId: 'current',
      });
    }

    expect(new Set([left.kind, right.kind])).toEqual(new Set(['completed', 'replayed']));
    if (left.kind === 'invalid' || right.kind === 'invalid') {
      throw new Error('Expected concurrent completion and replay to succeed');
    }
    expect(left.replacement).toEqual(right.replacement);
    expect([...harness.rows.values()].filter((row) => row.state === 'active')).toHaveLength(1);
    expect(harness.rows).toHaveLength(2);
  });

  it.each([
    ['old generation', { generation: 1 }],
    ['wrong logout id', { logoutId: '30000000-0000-4000-8000-000000000001' }],
    ['wrong nonce', { nonce: 'f2'.repeat(32) }],
  ])('does not mutate for %s', async (_label, override) => {
    const predecessor = seedPending(3);

    await expect(completeTerminalLogout({
      transitionId: predecessor.id,
      logoutId,
      generation: predecessor.generation,
      nonce,
      signingKeyId: 'current',
      ...override,
    })).resolves.toEqual({ kind: 'invalid' });

    expect(harness.rows.get(predecessor.id)).toMatchObject({
      state: 'logout_pending',
      generation: 3,
      logoutId,
    });
    expect(harness.rows).toHaveLength(1);
  });
});
