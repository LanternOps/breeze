import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PORTAL_BASE = 'https://manage.example/portal';
const TICKET_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_ORG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const HREF = `${PORTAL_BASE}/tickets/${TICKET_ID}`;

const dialect = new PgDialect();

const { portalBaseMock, selectRowsMock, queries } = vi.hoisted(() => ({
  portalBaseMock: vi.fn(() => 'https://manage.example/portal'),
  selectRowsMock: vi.fn((): unknown[] => []),
  queries: [] as { table: unknown; where: unknown; limit?: number }[],
}));

vi.mock('../portalUrl', () => ({
  portalBase: () => portalBaseMock(),
}));

vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: (where: unknown) => {
          const entry: { table: unknown; where: unknown; limit?: number } = { table, where };
          queries.push(entry);
          return {
            limit: (n: number) => {
              entry.limit = n;
              return Promise.resolve(selectRowsMock());
            },
          };
        },
      }),
    }),
  },
}));

import { resolveCommentNotificationPortalHref } from './commentNotificationPortalHref';

const args = {
  ticketId: TICKET_ID,
  orgId: ORG_ID,
  submitterEmail: 'jane@acme.test',
};

function lastQuery() {
  const q = queries.at(-1);
  if (!q) throw new Error('expected a portal_users select');
  const compiled = dialect.sqlToQuery(q.where as never);
  return {
    table: getTableName(q.table as Parameters<typeof getTableName>[0]),
    sql: compiled.sql,
    params: compiled.params,
    limit: q.limit,
  };
}

describe('resolveCommentNotificationPortalHref', () => {
  beforeEach(() => {
    queries.length = 0;
    portalBaseMock.mockReset();
    portalBaseMock.mockReturnValue(PORTAL_BASE);
    selectRowsMock.mockReset();
    selectRowsMock.mockReturnValue([]);
  });

  it('returns ticket href and hasPortalUser true for an active same-org email', async () => {
    selectRowsMock.mockReturnValue([{ id: 'pu-1' }]);

    const out = await resolveCommentNotificationPortalHref(args);

    expect(out).toEqual({ href: HREF, hasPortalUser: true });
    expect(lastQuery().table).toBe('portal_users');
    expect(lastQuery().limit).toBe(1);
  });

  it('returns the same ticket href with hasPortalUser false when no row matches', async () => {
    const out = await resolveCommentNotificationPortalHref(args);

    expect(out).toEqual({ href: HREF, hasPortalUser: false });
    expect(out.href).not.toMatch(/login/i);
    expect(out.href).not.toMatch(/token/i);
    expect(out.href).not.toContain('?');
    expect(out.href).not.toContain(args.submitterEmail);

    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'commentNotificationPortalHref.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/ticketComments|ticket_comments/);
  });

  it('returns hasPortalUser false when status is not active', async () => {
    const out = await resolveCommentNotificationPortalHref(args);

    expect(out).toEqual({ href: HREF, hasPortalUser: false });
    const q = lastQuery();
    expect(q.sql).toMatch(/"portal_users"\."status"\s*=\s*\$\d/);
    expect(q.params).toContain('active');
    expect(q.params).not.toContain('disabled');
  });

  it('does not match a portal user in a different org (query includes orgId)', async () => {
    const out = await resolveCommentNotificationPortalHref({ ...args, orgId: ORG_ID });

    expect(out.hasPortalUser).toBe(false);
    const q = lastQuery();
    expect(q.table).toBe('portal_users');
    expect(q.sql).toMatch(/"portal_users"\."org_id"\s*=\s*\$\d/);
    expect(q.params).toContain(ORG_ID);
    expect(q.params).not.toContain(OTHER_ORG);
    expect(q.limit).toBe(1);
  });

  it('matches portal_users email case-insensitively', async () => {
    selectRowsMock.mockReturnValue([{ id: 'pu-1' }]);

    const out = await resolveCommentNotificationPortalHref({
      ...args,
      submitterEmail: '  Jane@Acme.TEST  ',
    });

    expect(out.hasPortalUser).toBe(true);
    expect(out.href).toBe(HREF);
    const q = lastQuery();
    expect(q.sql).toMatch(/lower\("portal_users"\."email"\)/i);
    expect(q.params).toContain('jane@acme.test');
    expect(q.params.some((p) => typeof p === 'string' && /Jane@/.test(p))).toBe(false);
  });

  it('throws when the constructed href is not http(s) matching portalBase origin', async () => {
    portalBaseMock.mockReturnValue('ftp://files.example/portal');
    await expect(resolveCommentNotificationPortalHref(args)).rejects.toThrow();

    portalBaseMock.mockReturnValue('javascript:alert(1)');
    await expect(resolveCommentNotificationPortalHref(args)).rejects.toThrow();
  });
});
