import { beforeEach, describe, expect, it, vi } from 'vitest';

const jwtCalls: Array<{ scopes: string[]; subject: string }> = [];
const usersGet = vi.fn();
const usersList = vi.fn();

vi.mock('@googleapis/admin', async (orig) => {
  const real = await orig<typeof import('@googleapis/admin')>();
  class FakeJWT {
    constructor(opts: { scopes: string[]; subject: string }) {
      jwtCalls.push({ scopes: opts.scopes, subject: opts.subject });
    }
  }
  return {
    ...real,
    auth: { ...real.auth, JWT: FakeJWT },
    admin: () => ({
      users: { get: usersGet, list: usersList, update: vi.fn(), delete: vi.fn(), signOut: vi.fn() },
      domains: {},
    }),
  };
});

import {
  DIRECTORY_SCOPES,
  ALL_DWD_SCOPES_CSV,
  getDirectoryUsersReader,
} from './googleClient';

const KEY = JSON.stringify({
  client_email: 'sa@proj.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----\n',
});

beforeEach(() => {
  jwtCalls.length = 0;
  usersGet.mockReset();
  usersList.mockReset();
});

describe('getDirectoryUsersReader', () => {
  it('requests only admin.directory.user, impersonates adminEmail, and exposes no write call', () => {
    const reader = getDirectoryUsersReader(KEY, 'admin@example.com');
    expect(jwtCalls).toEqual([
      { scopes: ['https://www.googleapis.com/auth/admin.directory.user'], subject: 'admin@example.com' },
    ]);
    expect(Object.keys(reader).sort()).toEqual(['getUser', 'listUsersPage']);
  });

  it('DIRECTORY_SCOPES and ALL_DWD_SCOPES_CSV are unchanged', () => {
    expect([...DIRECTORY_SCOPES]).toEqual([
      'https://www.googleapis.com/auth/admin.directory.user',
      'https://www.googleapis.com/auth/admin.directory.user.security',
      'https://www.googleapis.com/auth/admin.directory.user.alias',
      'https://www.googleapis.com/auth/admin.directory.group',
      'https://www.googleapis.com/auth/admin.directory.group.member',
      'https://www.googleapis.com/auth/admin.directory.device.mobile.action',
    ]);
    expect(ALL_DWD_SCOPES_CSV.split(',')).toContain('https://www.googleapis.com/auth/admin.directory.user');
    expect(ALL_DWD_SCOPES_CSV).not.toContain('admin.directory.user.readonly');
  });

  it('getUser passes the userKey, field mask and abort signal and returns the data', async () => {
    usersGet.mockResolvedValue({ data: { id: 'g1', isAdmin: true } });
    const reader = getDirectoryUsersReader(KEY, 'admin@example.com');
    const ac = new AbortController();
    await expect(reader.getUser('admin@example.com', 'id,isAdmin', ac.signal)).resolves.toEqual({ id: 'g1', isAdmin: true });
    expect(usersGet).toHaveBeenCalledWith(
      { userKey: 'admin@example.com', fields: 'id,isAdmin' },
      { signal: ac.signal },
    );
  });

  it('listUsersPage lists the whole customer with the exact field mask', async () => {
    usersList.mockResolvedValue({ data: { users: [], nextPageToken: 't2' } });
    const reader = getDirectoryUsersReader(KEY, 'admin@example.com');
    const ac = new AbortController();
    await expect(reader.listUsersPage('t1', ac.signal)).resolves.toEqual({ users: [], nextPageToken: 't2' });
    expect(usersList).toHaveBeenCalledWith(
      {
        customer: 'my_customer',
        maxResults: 500,
        projection: 'basic',
        fields: 'nextPageToken,users(id,customerId,suspended,archived)',
        pageToken: 't1',
      },
      { signal: ac.signal },
    );
  });

  it('a first page sends no pageToken', async () => {
    usersList.mockResolvedValue({ data: {} });
    await getDirectoryUsersReader(KEY, 'a@example.com').listUsersPage(undefined, new AbortController().signal);
    expect(usersList.mock.calls[0]![0]).not.toHaveProperty('pageToken');
  });
});
