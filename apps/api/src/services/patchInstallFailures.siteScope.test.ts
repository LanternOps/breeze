import { beforeEach, describe, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => ({ queries: [] as { sql: string; params: unknown[] }[] }));
// Real Drizzle builders and schema through the PostgreSQL proxy driver: this
// pins the emitted SQL. Row filtering itself needs a live database.
vi.mock('../db', async () => {
  const { drizzle } = await import('drizzle-orm/pg-proxy');
  return {
    db: drizzle(async (sql, params) => {
      capture.queries.push({ sql, params });
      return { rows: [] };
    }),
  };
});

import { loadPatchInstallFailures } from './patchInstallFailures';

const ORG = '00000000-0000-4000-8000-000000000001';
const SITE = '00000000-0000-4000-8000-000000000002';
const PATCH = '00000000-0000-4000-8000-000000000003';

beforeEach(() => { capture.queries.length = 0; });

describe('patch install failure summaries and site restrictions', () => {
  it('limits both the device command and the patch job sources to the allowed sites', async () => {
    await loadPatchInstallFailures([PATCH], { orgId: ORG, allowedSiteIds: [SITE] });
    expect(capture.queries).toHaveLength(2);
    for (const query of capture.queries) {
      expect(query.sql).toContain('"devices"."site_id" in');
      expect(query.sql).toContain('"devices"."org_id" =');
      expect(query.params).toContain(SITE);
      expect(query.params).toContain(ORG);
    }
    expect(capture.queries.some((q) => q.sql.includes('device_commands'))).toBe(true);
    expect(capture.queries.some((q) => q.sql.includes('patch_job_results'))).toBe(true);
  });

  it('returns no failures and reads nothing when no site is allowed', async () => {
    expect(await loadPatchInstallFailures([PATCH], { allowedSiteIds: [] })).toEqual(new Map());
    expect(capture.queries).toHaveLength(0);
  });

  it('keeps organization-wide summaries for unrestricted callers', async () => {
    await loadPatchInstallFailures([PATCH], { orgId: ORG });
    expect(capture.queries).toHaveLength(2);
    for (const query of capture.queries) expect(query.sql).not.toContain('"site_id"');
  });
});
