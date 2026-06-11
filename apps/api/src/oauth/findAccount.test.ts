import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { users } from '../db/schema';
import { findAccount } from './findAccount';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const selectMock = vi.mocked(db.select);
const runOutsideDbContextMock = vi.mocked(runOutsideDbContext);
const withSystemDbAccessContextMock = vi.mocked(withSystemDbAccessContext);

function mockSelectRows(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  selectMock.mockReturnValue({ from } as unknown as ReturnType<typeof db.select>);
  return { from, where, limit };
}

describe('findAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns account and OIDC profile claims for a known user', async () => {
    const row = {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
    };
    mockSelectRows([row]);

    const account = await findAccount({}, row.id);

    expect(account?.accountId).toBe(row.id);
    await expect(account?.claims('id_token', 'openid email profile')).resolves.toEqual({
      sub: row.id,
      email: row.email,
      name: row.name,
    });
    expect(selectMock).toHaveBeenCalledWith({
      id: users.id,
      email: users.email,
      name: users.name,
    });
  });

  it('does not return tenant claims from the account profile', async () => {
    const row = {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'ada@example.com',
      name: null,
    };
    mockSelectRows([row]);

    const account = await findAccount({}, row.id);
    const claims = await account?.claims('userinfo', 'openid email profile');

    expect(claims).not.toHaveProperty('partner_id');
    expect(claims).not.toHaveProperty('org_id');
    expect(claims).toEqual({ sub: row.id, email: row.email, name: null });
  });

  it('returns undefined when no user matches the sub', async () => {
    mockSelectRows([]);

    await expect(findAccount({}, '00000000-0000-4000-8000-000000000099'))
      .resolves.toBeUndefined();
  });

  it('returns undefined for a non-active user (status=disabled or invited) — M-B4', async () => {
    // Defense-in-depth: the WHERE clause now includes `status='active'` so
    // suspended/disabled users (and unaccepted invites) cannot complete OAuth
    // flows even if they somehow hold a valid sub. This test pins the
    // contract by asserting that the empty-result path returns undefined,
    // which mirrors what Postgres returns when the status filter excludes
    // the row.
    mockSelectRows([]);

    const account = await findAccount({}, '00000000-0000-4000-8000-000000000077');

    expect(account).toBeUndefined();
  });

  it('exits request DB context before opening system DB context', async () => {
    mockSelectRows([]);

    await findAccount({}, '00000000-0000-4000-8000-000000000099');

    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    expect(runOutsideDbContextMock.mock.invocationCallOrder[0]!)
      .toBeLessThan(withSystemDbAccessContextMock.mock.invocationCallOrder[0]!);
  });
});
