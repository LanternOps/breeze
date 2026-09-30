/**
 * Fleet security reads apply the caller's site ceiling in SQL.
 *
 * `listStatusRows` and `listThreatRows` feed every fleet projection under
 * /security (status and threat lists, dashboard counts, firewall, encryption,
 * password-policy and local-admin views, recommendation inputs). Organization
 * RLS does not cover the site axis, so the predicate has to be part of the
 * query itself: `undefined` = unrestricted, `[]` = no devices, and a non-empty
 * list admits only devices whose current site is in it (a null site never
 * matches).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { eq, type SQL } from 'drizzle-orm';

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: {},
  queueCommand: vi.fn(),
}));

vi.mock('../../services/securityPosture', () => ({
  listLatestSecurityPosture: vi.fn(async () => []),
}));

import { db } from '../../db';
import { devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { listLatestSecurityPosture } from '../../services/securityPosture';
import { buildBe9Recommendations, listStatusRows, listThreatRows } from './helpers';

const dialect = new PgDialect();
const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';

function auth(allowedSiteIds?: unknown): AuthContext {
  return {
    scope: 'organization',
    orgId: ORG,
    accessibleOrgIds: [ORG],
    allowedSiteIds,
    orgCondition: (column: typeof devices.orgId) => eq(column, ORG),
    canAccessOrg: (id: string) => id === ORG,
  } as unknown as AuthContext;
}

function compiled(node: SQL): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(node);
}

describe('security fleet helper site predicates', () => {
  let captured: SQL | undefined;

  beforeEach(() => {
    captured = undefined;
    vi.clearAllMocks();
  });

  function statusRows() {
    vi.mocked(db.select).mockReturnValue({
      from: () => ({
        leftJoin: () => ({
          where: (condition: SQL) => {
            captured = condition;
            return Promise.resolve([]);
          },
        }),
      }),
    } as never);
  }

  function threatRows() {
    vi.mocked(db.select).mockReturnValue({
      from: () => ({
        innerJoin: () => ({
          where: (condition: SQL) => ({
            orderBy: () => {
              captured = condition;
              return Promise.resolve([]);
            },
          }),
        }),
      }),
    } as never);
  }

  const readers = [
    ['status', (a: AuthContext) => listStatusRows(a), statusRows],
    ['threats', (a: AuthContext) => listThreatRows(a), threatRows],
  ] as const;

  it.each(readers)('%s binds the selected-site ceiling in SQL', async (_name, read, setup) => {
    setup();
    await read(auth([SITE]));
    const query = compiled(captured!);
    expect(query.sql).toContain('"devices"."site_id" in');
    expect(query.params).toContain(SITE);
  });

  it.each(readers)('%s: an empty allowlist admits no device', async (_name, read, setup) => {
    setup();
    await read(auth([]));
    expect(compiled(captured!).sql).toContain('false');
  });

  it.each(readers)('%s: a malformed allowlist fails closed', async (_name, read, setup) => {
    setup();
    await read(auth(null));
    expect(compiled(captured!).sql).toContain('false');
  });

  it.each(readers)('%s: an undefined allowlist stays unrestricted', async (_name, read, setup) => {
    setup();
    await read(auth(undefined));
    expect(compiled(captured!).sql).not.toContain('site_id');
  });

  it('recommendation inputs carry the site ceiling into the posture read', async () => {
    threatRows();
    await buildBe9Recommendations(auth([SITE]));
    expect(vi.mocked(listLatestSecurityPosture)).toHaveBeenCalledWith(
      expect.objectContaining({ siteIds: [SITE] }),
    );
    expect(compiled(captured!).sql).toContain('"devices"."site_id" in');
  });

  it('recommendation inputs stay unrestricted without a site ceiling', async () => {
    threatRows();
    await buildBe9Recommendations(auth(undefined));
    const [filter] = vi.mocked(listLatestSecurityPosture).mock.calls[0]!;
    expect(filter.siteIds).toBeUndefined();
  });
});
