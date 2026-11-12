/**
 * Compiled-SQL checks for `artifactSiteScopeCondition`. Row-level behaviour is
 * proven against Postgres in
 * __tests__/integration/artifactSiteAccess.integration.test.ts; this file pins
 * which arms each kind of caller gets, without a database.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { artifactSiteScopeCondition } from './artifactService';

const USER = '00000000-0000-4000-8000-0000000000b1';
const SITE = '00000000-0000-4000-8000-0000000000b2';
const DEVICE = '00000000-0000-4000-8000-0000000000b3';
const user = { id: USER, email: 'u@example.com', name: 'U', isPlatformAdmin: false };

function compile(auth: { allowedSiteIds?: string[]; allowedDeviceIds?: string[] }) {
  const condition = artifactSiteScopeCondition({ ...auth, user } as never);
  return condition ? new PgDialect().sqlToQuery(condition) : undefined;
}

describe('artifactSiteScopeCondition', () => {
  it('adds nothing for an unrestricted caller', () => {
    expect(compile({})).toBeUndefined();
  });

  it.each([[{ allowedSiteIds: [] }], [{ allowedDeviceIds: [] }]])('is false for an empty allowlist %j', (auth) => {
    expect(compile(auth)?.sql).toBe('false');
  });

  it('for a site-restricted caller covers the run device, the analysis run site and the caller own session', () => {
    const query = compile({ allowedSiteIds: [SITE] })!;
    expect(query.sql).toContain('"artifact_scope_run"."id" = "ai_run_artifacts"."run_id"');
    expect(query.sql).toContain('"artifact_scope_run"."org_id" = "ai_run_artifacts"."org_id"');
    expect(query.sql).toContain('"artifact_scope_run_device"."site_id" IN');
    expect(query.sql).toContain(`"artifact_scope_run"."profile" = 'analysis'`);
    expect(query.sql).toContain(`"artifact_scope_run"."trigger_ref"->>'siteId'`);
    expect(query.sql).toContain('"artifact_scope_session"."user_id" =');
    expect(query.sql).toContain('"artifact_scope_session"."device_id" IS NULL OR');
    expect(query.params).toEqual(expect.arrayContaining([SITE, USER]));
  });

  it('for an exact-device caller requires one of its devices and drops the analysis-site and device-less session arms', () => {
    const query = compile({ allowedDeviceIds: [DEVICE] })!;
    expect(query.sql).toContain('"artifact_scope_run_device"."id" IN');
    expect(query.sql).not.toContain('"site_id" IN');
    expect(query.sql).not.toContain('trigger_ref');
    expect(query.sql).not.toContain('"device_id" IS NULL OR');
    expect(query.params).toEqual(expect.arrayContaining([DEVICE, USER]));
  });
});
