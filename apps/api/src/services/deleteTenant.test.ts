import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
}));

vi.mock('../db/schema', () => ({
  partners: {
    id: 'p.id',
    name: 'p.name',
    status: 'p.status',
    deletedAt: 'p.deleted_at',
    updatedAt: 'p.updated_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (a: unknown, b: unknown) => ({ _op: 'eq', a, b }),
}));

vi.mock('./auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

import { runDeleteTenant } from './deleteTenant';
import { db } from '../db';
import { writeAuditEvent } from './auditEvents';
import type { AuthContext } from '../middleware/auth';

const PARTNER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_PARTNER_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const ORG_ID = '44444444-4444-4444-4444-444444444444';

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    user: { id: USER_ID, email: 'apikey@breeze.local', name: 'API Key: test', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: PARTNER_ID,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    ...overrides,
  };
}

/** Wire up the `db.select().from().where().limit()` chain. */
function mockSelectPartner(row: unknown | null): void {
  vi.mocked(db.select).mockImplementation(() => {
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(row ? [row] : []),
    };
    return chain as any;
  });
}

function mockUpdateSuccess(): ReturnType<typeof vi.fn> {
  const setFn = vi.fn().mockReturnThis();
  const whereFn = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.update).mockImplementation(
    () =>
      ({
        set: setFn,
        where: whereFn,
      }) as any,
  );
  return setFn;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('delete_tenant', () => {
  it('rejects when API key has no partner scope', async () => {
    const out = await runDeleteTenant(
      { tenant_id: PARTNER_ID, confirmation_phrase: 'delete acme permanently' },
      makeAuth({ partnerId: null }),
    );
    expect(JSON.parse(out)).toMatchObject({ code: 'PARTNER_SCOPE_REQUIRED' });
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it('rejects cross-tenant deletion (tenant_id !== auth.partnerId)', async () => {
    const out = await runDeleteTenant(
      { tenant_id: OTHER_PARTNER_ID, confirmation_phrase: 'delete acme permanently' },
      makeAuth(),
    );
    expect(JSON.parse(out)).toMatchObject({ code: 'CROSS_TENANT_FORBIDDEN' });
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it('rejects when tenant is unknown', async () => {
    mockSelectPartner(null);
    const out = await runDeleteTenant(
      { tenant_id: PARTNER_ID, confirmation_phrase: 'delete acme permanently' },
      makeAuth(),
    );
    expect(JSON.parse(out)).toMatchObject({ code: 'UNKNOWN_TENANT' });
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it('rejects when tenant is already soft-deleted', async () => {
    mockSelectPartner({
      id: PARTNER_ID,
      name: 'Acme Corp',
      deletedAt: new Date('2026-04-01T00:00:00Z'),
    });
    const out = await runDeleteTenant(
      { tenant_id: PARTNER_ID, confirmation_phrase: 'delete acme corp permanently' },
      makeAuth(),
    );
    expect(JSON.parse(out)).toMatchObject({ code: 'ALREADY_DELETED' });
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it('rejects when confirmation phrase does not match (wrong name)', async () => {
    mockSelectPartner({ id: PARTNER_ID, name: 'Acme Corp', deletedAt: null });
    const out = await runDeleteTenant(
      { tenant_id: PARTNER_ID, confirmation_phrase: 'delete acme permanently' },
      makeAuth(),
    );
    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('BAD_CONFIRMATION');
    expect(parsed.error).toContain('delete acme corp permanently');
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it('rejects when confirmation phrase is missing the "permanently" suffix', async () => {
    mockSelectPartner({ id: PARTNER_ID, name: 'Acme Corp', deletedAt: null });
    const out = await runDeleteTenant(
      { tenant_id: PARTNER_ID, confirmation_phrase: 'delete acme corp' },
      makeAuth(),
    );
    expect(JSON.parse(out)).toMatchObject({ code: 'BAD_CONFIRMATION' });
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it('soft-deletes when phrase matches exactly and is case-insensitive + trimmed', async () => {
    mockSelectPartner({ id: PARTNER_ID, name: 'Acme Corp', deletedAt: null });
    const setFn = mockUpdateSuccess();

    const out = await runDeleteTenant(
      // Mixed case + surrounding whitespace — handler normalizes.
      { tenant_id: PARTNER_ID, confirmation_phrase: '  DELETE Acme Corp PERMANENTLY  ' },
      makeAuth(),
    );

    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({
      soft_deleted: true,
      tenant_id: PARTNER_ID,
      tenant_name: 'Acme Corp',
      restore_window_days: 30,
    });
    expect(parsed.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Verify update payload: status + deletedAt + updatedAt set together.
    expect(setFn).toHaveBeenCalledTimes(1);
    const setPayload = setFn.mock.calls[0]?.[0] as {
      status: string;
      deletedAt: Date;
      updatedAt: Date;
    };
    expect(setPayload.status).toBe('churned');
    expect(setPayload.deletedAt).toBeInstanceOf(Date);
    expect(setPayload.updatedAt).toBeInstanceOf(Date);

    // Audit event written with api_key actor.
    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    const auditCall = vi.mocked(writeAuditEvent).mock.calls[0]![1];
    expect(auditCall).toMatchObject({
      actorType: 'api_key',
      actorId: USER_ID,
      action: 'partner.soft_deleted',
      resourceType: 'partner',
      resourceId: PARTNER_ID,
      resourceName: 'Acme Corp',
      result: 'success',
    });
    expect(auditCall.details).toMatchObject({
      tool_name: 'delete_tenant',
      restore_window_days: 30,
    });
  });

  it('still succeeds if audit write throws (best-effort)', async () => {
    mockSelectPartner({ id: PARTNER_ID, name: 'Acme', deletedAt: null });
    mockUpdateSuccess();
    vi.mocked(writeAuditEvent).mockImplementationOnce(() => {
      throw new Error('audit db down');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const out = await runDeleteTenant(
      { tenant_id: PARTNER_ID, confirmation_phrase: 'delete acme permanently' },
      makeAuth(),
    );
    expect(JSON.parse(out)).toMatchObject({ soft_deleted: true });
    errSpy.mockRestore();
  });
});
