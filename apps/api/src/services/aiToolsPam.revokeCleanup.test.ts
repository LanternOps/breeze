/**
 * W04-D10 (#6758): `revoke_elevation` must request device-side PAM cleanup in
 * the same transaction as the revoke, exactly as `POST /pam/elevation-requests
 * /:id/revoke` does (routes/pam.ts, requestPamCleanup cause 'revoked').
 * Without it the chat tool marked a grant revoked while any admin membership
 * already actuated on the device got no server-initiated cleanup — and the
 * expiry sweep skips `revoked` rows, so nothing ever cleaned it up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('./pamRuleEngine', () => ({ evaluatePamRules: vi.fn() }));
vi.mock('./pamActuationLifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pamActuationLifecycle')>();
  return { ...actual, requestPamCleanup: vi.fn() };
});

import { db } from '../db';
import { registerPamTools } from './aiToolsPam';
import { PamActuationNotFoundError, requestPamCleanup } from './pamActuationLifecycle';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { transaction: ReturnType<typeof vi.fn> };
const ROW = { id: 'er-1', orgId: 'org-1', siteId: 'site-1', deviceId: 'dev-1', flowType: 'tech_jit_admin', status: 'approved' };

function handler(): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerPamTools(reg);
  return reg.get('revoke_elevation')!.handler;
}

function auth(): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    canAccessSite: () => true,
  } as unknown as AuthContext;
}

let txHandle: unknown;
let updated: Array<{ id: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  updated = [{ id: 'er-1' }];
  mockDb.transaction.mockImplementation(async (fn: any) => {
    txHandle = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([ROW]) }) }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve(updated) }) }) }),
      insert: () => ({ values: () => Promise.resolve(undefined) }),
    };
    return fn(txHandle);
  });
});

describe('revoke_elevation requests PAM cleanup (W04-D10, #6758)', () => {
  it('requests cleanup for the revoked request inside the revoke transaction', async () => {
    vi.mocked(requestPamCleanup).mockResolvedValue({} as any);

    const out = JSON.parse(await handler()({ elevationRequestId: 'er-1', reason: 'done' }, auth()));

    expect(requestPamCleanup).toHaveBeenCalledTimes(1);
    expect(requestPamCleanup).toHaveBeenCalledWith(txHandle, { elevationRequestId: 'er-1', cause: 'revoked' });
    expect(out).toMatchObject({ status: 'revoked', enforcementStatus: 'cleanup_pending' });
  });

  it('treats "nothing was ever dispatched" as no cleanup needed, not a failure', async () => {
    vi.mocked(requestPamCleanup).mockRejectedValue(new PamActuationNotFoundError('er-1'));

    const out = JSON.parse(await handler()({ elevationRequestId: 'er-1', reason: 'done' }, auth()));

    expect(out).toMatchObject({ status: 'revoked', enforcementStatus: 'none_dispatched' });
  });

  it('a genuine cleanup failure aborts the revoke (the transaction rejects)', async () => {
    vi.mocked(requestPamCleanup).mockRejectedValue(new Error('PAM cleanup generation lost its lock'));

    await expect(handler()({ elevationRequestId: 'er-1', reason: 'done' }, auth())).resolves.toMatch(/error/i);
  });

  it('control: a request that was not active requests no cleanup', async () => {
    updated = [];

    const out = JSON.parse(await handler()({ elevationRequestId: 'er-1', reason: 'done' }, auth()));

    expect(out.error).toMatch(/not active/i);
    expect(requestPamCleanup).not.toHaveBeenCalled();
  });
});
