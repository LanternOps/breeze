import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({
  db: {},
  getCurrentDbAccessContext: vi.fn(() => undefined),
  runOutsideDbContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
}));
vi.mock('../jobs/tenantErasure', () => ({ enqueueTenantErasure: vi.fn() }));
vi.mock('../jobs/orgMerge', () => ({ getOrgMergeQueue: vi.fn() }));
vi.mock('./auditEvents', () => ({
  ANONYMOUS_ACTOR_ID: '00000000-0000-0000-0000-000000000000',
  requestLikeFromSnapshot: vi.fn(),
  writeAuditEvent: vi.fn(),
}));
vi.mock('./tenantLifecycle', () => ({}));
vi.mock('./tenantStatus', () => ({}));

import { buildOrganizationFinalizeCas } from './tenantOffboarding';

describe('organization offboarding finalize CAS (compiled SQL)', () => {
  const dialect = new PgDialect();
  const orgId = '11111111-1111-4111-8111-111111111111';

  it.each(['archive', 'churn'] as const)('guards id, offboarding status, and %s target', (target) => {
    const compiled = dialect.sqlToQuery(buildOrganizationFinalizeCas(orgId, target));

    expect(compiled.sql).toBe(
      '("organizations"."id" = $1 and "organizations"."status" = $2 and "organizations"."offboarding_target" = $3)'
    );
    expect(compiled.params).toEqual([orgId, 'offboarding', target]);
  });
});
