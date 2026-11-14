import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_USERS_MAX_PAGES,
  GOOGLE_USERS_PAGE_TIMEOUT_MS,
  GOOGLE_USERS_PASS_DEADLINE_MS,
  listGoogleDirectoryUsers,
  type DirectoryUsersReader,
} from './googleSource';

const ADMIN = 'admin@example.com';
const CUST = 'C0123';

type Page = { users?: unknown[]; nextPageToken?: unknown };

function u(id: string, over: Record<string, unknown> = {}) {
  return { id, customerId: CUST, ...over };
}

function reader(pages: Array<Page | Error>, anchor: unknown = { id: 'admin-id', customerId: CUST, isAdmin: true, suspended: false }) {
  const calls: Array<string | undefined> = [];
  const r: DirectoryUsersReader = {
    getUser: vi.fn(async () => {
      if (anchor instanceof Error) throw anchor;
      return anchor as never;
    }),
    listUsersPage: vi.fn(async (token) => {
      calls.push(token);
      const next = pages[calls.length - 1];
      if (next === undefined) throw new Error('unexpected extra page');
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  return { r, calls };
}

const okPage = (extra: Page = {}): Page => ({ users: [u('admin-id'), u('g2')], ...extra });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('constants', () => {
  it('match D11', () => {
    expect(GOOGLE_USERS_PAGE_TIMEOUT_MS).toBe(10_000);
    expect(GOOGLE_USERS_PASS_DEADLINE_MS).toBe(600_000);
    expect(GOOGLE_USERS_MAX_PAGES).toBe(400);
  });
});

describe('listGoogleDirectoryUsers', () => {
  it('asks the anchor for exactly the D11 fields', async () => {
    const { r } = reader([okPage()]);
    await listGoogleDirectoryUsers(r, ADMIN);
    expect(r.getUser).toHaveBeenCalledWith(ADMIN, 'id,customerId,isAdmin,suspended', expect.any(AbortSignal));
  });

  it('the admin anchor must be an admin and not suspended; its customerId becomes the chain\'s', async () => {
    for (const anchor of [
      { id: 'a', customerId: CUST, isAdmin: false },
      { id: 'a', customerId: CUST, isAdmin: undefined },
      { id: 'a', customerId: CUST, isAdmin: true, suspended: true },
    ]) {
      const { r } = reader([okPage()], anchor);
      expect(await listGoogleDirectoryUsers(r, ADMIN)).toEqual({ kind: 'incomplete', reason: 'admin_not_admin' });
      expect(r.listUsersPage).not.toHaveBeenCalled();
    }
    const { r } = reader([okPage()]);
    const out = await listGoogleDirectoryUsers(r, ADMIN);
    expect(out).toMatchObject({ kind: 'complete', customerId: CUST });
  });

  it('an anchor without a usable id or customerId is malformed', async () => {
    const { r } = reader([okPage()], { id: '', customerId: CUST, isAdmin: true });
    expect(await listGoogleDirectoryUsers(r, ADMIN)).toEqual({ kind: 'incomplete', reason: 'malformed' });
    const b = reader([okPage()], { id: 'admin-id', isAdmin: true });
    expect(await listGoogleDirectoryUsers(b.r, ADMIN)).toEqual({ kind: 'incomplete', reason: 'malformed' });
  });

  it('pages to the end and returns a complete listing', async () => {
    const { r, calls } = reader([
      { users: [u('admin-id'), u('g2', { suspended: true })], nextPageToken: 't2' },
      { users: [u('g3', { archived: true }), u('g4')] },
    ]);
    const out = await listGoogleDirectoryUsers(r, ADMIN);
    expect(calls).toEqual([undefined, 't2']);
    expect(out.kind).toBe('complete');
    if (out.kind !== 'complete') return;
    expect(out.users.size).toBe(4);
  });

  it('suspended and archived map to their reasons; a missing flag is false', async () => {
    const { r } = reader([{ users: [
      u('admin-id'),
      u('s', { suspended: true }),
      u('a', { archived: true }),
      u('both', { suspended: true, archived: true }),
      u('f', { suspended: false, archived: false }),
    ] }]);
    const out = await listGoogleDirectoryUsers(r, ADMIN);
    if (out.kind !== 'complete') throw new Error('expected complete');
    expect(out.users.get('admin-id')).toEqual({ suspended: false, archived: false });
    expect(out.users.get('s')).toEqual({ suspended: true, archived: false });
    expect(out.users.get('a')).toEqual({ suspended: false, archived: true });
    expect(out.users.get('both')).toEqual({ suspended: true, archived: true });
    expect(out.users.get('f')).toEqual({ suspended: false, archived: false });
    expect(out.users.get('absent')).toBeUndefined();
  });

  it('a page error is incomplete, with the mapped reason', async () => {
    const cases: Array<[unknown, string]> = [
      [new Error('unauthorized_client: Client is unauthorized'), 'scope_missing'],
      [Object.assign(new Error('x'), { code: 403 }), 'access_denied'],
      [Object.assign(new Error('x'), { response: { status: 401 } }), 'access_denied'],
      [Object.assign(new Error('x'), { code: 503 }), 'unavailable'],
      [new Error('socket hang up'), 'unavailable'],
    ];
    for (const [err, reason] of cases) {
      const { r } = reader([okPage({ nextPageToken: 't2' }), err as Error]);
      expect(await listGoogleDirectoryUsers(r, ADMIN)).toEqual({ kind: 'incomplete', reason });
    }
  });

  it('an anchor error maps the same way and bad key JSON is connection_invalid', async () => {
    const a = reader([okPage()], Object.assign(new Error('x'), { code: 403 }));
    expect(await listGoogleDirectoryUsers(a.r, ADMIN)).toEqual({ kind: 'incomplete', reason: 'access_denied' });
    const b = reader([okPage()], Object.assign(new Error('Service-account key is not valid JSON.'), { code: 'invalid_service_account' }));
    expect(await listGoogleDirectoryUsers(b.r, ADMIN)).toEqual({ kind: 'incomplete', reason: 'connection_invalid' });
  });

  it('a repeated page token is incomplete', async () => {
    const { r } = reader([
      okPage({ nextPageToken: 't2' }),
      { users: [u('g3')], nextPageToken: 't2' },
    ]);
    const out = await listGoogleDirectoryUsers(r, ADMIN);
    expect(out).toEqual({ kind: 'incomplete', reason: 'unavailable' });
  });

  it('a non-string or empty nextPageToken is malformed', async () => {
    const { r } = reader([okPage({ nextPageToken: 42 })]);
    expect(await listGoogleDirectoryUsers(r, ADMIN)).toEqual({ kind: 'incomplete', reason: 'malformed' });
  });

  it('the page cap is incomplete', async () => {
    let n = 0;
    const r: DirectoryUsersReader = {
      getUser: vi.fn(async () => ({ id: 'admin-id', customerId: CUST, isAdmin: true })),
      listUsersPage: vi.fn(async () => ({
        users: n === 0 ? [u('admin-id')] : [],
        nextPageToken: `t${++n}`,
      })),
    };
    const out = await listGoogleDirectoryUsers(r, ADMIN);
    expect(out).toEqual({ kind: 'incomplete', reason: 'unavailable' });
    expect(r.listUsersPage).toHaveBeenCalledTimes(GOOGLE_USERS_MAX_PAGES);
  });

  it('the pass deadline is incomplete', async () => {
    let t = 0;
    const { r } = reader([okPage({ nextPageToken: 't2' }), { users: [u('g3')] }]);
    (r.listUsersPage as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      t += GOOGLE_USERS_PASS_DEADLINE_MS + 1;
      return okPage({ nextPageToken: 't2' });
    });
    const out = await listGoogleDirectoryUsers(r, ADMIN, { now: () => t });
    expect(out).toEqual({ kind: 'incomplete', reason: 'unavailable' });
    expect(r.listUsersPage).toHaveBeenCalledTimes(1);
  });

  it('a hung page is aborted at the per-page timeout', async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const r: DirectoryUsersReader = {
        getUser: vi.fn(async () => ({ id: 'admin-id', customerId: CUST, isAdmin: true })),
        listUsersPage: vi.fn((_t, signal) => new Promise((_res, rej) => {
          seen = signal;
          signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })),
      };
      const pending = listGoogleDirectoryUsers(r, ADMIN);
      await vi.advanceTimersByTimeAsync(GOOGLE_USERS_PAGE_TIMEOUT_MS + 1);
      expect(await pending).toEqual({ kind: 'incomplete', reason: 'unavailable' });
      expect(seen?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a customerId mismatch or missing customerId is mixed_customer', async () => {
    const a = reader([{ users: [u('admin-id'), u('g2', { customerId: 'C999' })] }]);
    expect(await listGoogleDirectoryUsers(a.r, ADMIN)).toEqual({ kind: 'incomplete', reason: 'mixed_customer' });
    const b = reader([{ users: [u('admin-id'), { id: 'g2' }] }]);
    expect(await listGoogleDirectoryUsers(b.r, ADMIN)).toEqual({ kind: 'incomplete', reason: 'mixed_customer' });
  });

  it('a listing without the admin itself is incomplete', async () => {
    const { r } = reader([{ users: [u('g2')] }]);
    expect(await listGoogleDirectoryUsers(r, ADMIN)).toEqual({ kind: 'incomplete', reason: 'mixed_customer' });
  });

  it('a non-string id, an empty id, a duplicate id or a non-boolean flag is malformed', async () => {
    const bad: unknown[][] = [
      [u('admin-id'), { customerId: CUST }],
      [u('admin-id'), u('')],
      [u('admin-id'), u(7 as unknown as string)],
      [u('admin-id'), u('admin-id')],
      [u('admin-id'), u('g2', { suspended: 'true' })],
      [u('admin-id'), u('g2', { archived: 1 })],
      [u('admin-id'), null],
    ];
    for (const users of bad) {
      const { r } = reader([{ users }]);
      expect(await listGoogleDirectoryUsers(r, ADMIN)).toEqual({ kind: 'incomplete', reason: 'malformed' });
    }
  });

  it('a duplicate across pages is malformed', async () => {
    const { r } = reader([
      okPage({ nextPageToken: 't2' }),
      { users: [u('g2')] },
    ]);
    expect(await listGoogleDirectoryUsers(r, ADMIN)).toEqual({ kind: 'incomplete', reason: 'malformed' });
  });

  it('no subject, email or key reaches a log line', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
    ];
    const secret = Object.assign(new Error(`boom for ${ADMIN} -----BEGIN PRIVATE KEY-----`), { code: 503 });
    await listGoogleDirectoryUsers(reader([okPage({ nextPageToken: 't2' }), secret]).r, ADMIN);
    await listGoogleDirectoryUsers(reader([{ users: [u('admin-id'), u('admin-id')] }]).r, ADMIN);
    await listGoogleDirectoryUsers(reader([okPage()]).r, ADMIN);
    const text = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain('admin-id');
    expect(text).not.toContain(CUST);
  });
});
