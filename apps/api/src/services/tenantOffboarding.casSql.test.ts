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

import {
  ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY,
  ARCHIVE_PURGING_RECOVERY_MAX_ATTEMPTS,
  buildArchivePurgeCas,
  buildArchivePurgingRecoveryAttemptIncrement,
  buildArchivePurgingRecoveryCandidatesWhere,
  buildArchiveWarningMarkerCas,
  buildArchiveWarningMarkerRelease,
  buildOrganizationFinalizeCas,
} from './tenantOffboarding';

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

describe('archive purge sweeper CAS statements (compiled SQL)', () => {
  const dialect = new PgDialect();
  const orgId = '11111111-1111-4111-8111-111111111111';

  it('transitions only a still-archived org to purging and returns the claimed row', () => {
    const compiled = dialect.sqlToQuery(buildArchivePurgeCas(orgId));

    expect(compiled.sql).toMatch(/UPDATE organizations\s+SET status = 'purging', updated_at = now\(\)/);
    expect(compiled.sql).toMatch(/WHERE id = \$1::uuid\s+AND status = 'archived'/);
    expect(compiled.sql).toMatch(/RETURNING id/);
    expect(compiled.params).toEqual([orgId]);
  });

  it.each([
    'archivePurgeWarn14SentAt',
    'archivePurgeWarn1SentAt',
  ] as const)('atomically claims the absent %s jsonb marker', (marker) => {
    const compiled = dialect.sqlToQuery(buildArchiveWarningMarkerCas(orgId, marker));

    expect(compiled.sql).toMatch(/jsonb_set\(\s*COALESCE\(settings, '\{\}'::jsonb\)/);
    expect(compiled.sql).toMatch(/WHERE id = \$2::uuid\s+AND status = 'archived'/);
    expect(compiled.sql).toContain('settings->>$3 IS NULL');
    expect(compiled.sql).toContain('RETURNING id');
    expect(compiled.sql).toContain('settings->>$4 AS claimed_value');
    expect(compiled.params).toEqual([marker, orgId, marker, marker]);
  });

  it.each([
    'archivePurgeWarn14SentAt',
    'archivePurgeWarn1SentAt',
  ] as const)('releases only the matching failed-send claim for %s', (marker) => {
    const claimedValue = '2026-07-24T12:00:00.000000+00:00';
    const compiled = dialect.sqlToQuery(
      buildArchiveWarningMarkerRelease(orgId, marker, claimedValue)
    );

    expect(compiled.sql).toMatch(/settings = COALESCE\(settings, '\{\}'::jsonb\) - \$1/);
    expect(compiled.sql).toMatch(/WHERE id = \$2::uuid\s+AND status = 'archived'/);
    expect(compiled.sql).toContain('settings->>$3 = $4');
    expect(compiled.sql).toContain('RETURNING id');
    expect(compiled.params).toEqual([marker, orgId, marker, claimedValue]);
  });
});

describe('archive purging-recovery candidate predicate (compiled SQL)', () => {
  const dialect = new PgDialect();

  // Review hardening (I3): a unit test that injects rows straight past the
  // WHERE clause can't tell a 15-minute floor apart from no floor at all —
  // this pins the actual predicate the sweep's recovery loop filters with.
  it('only recovers purging rows whose CAS committed at least 15 minutes ago', () => {
    const compiled = dialect.sqlToQuery(buildArchivePurgingRecoveryCandidatesWhere());

    expect(compiled.sql).toContain('"organizations"."status" = $1');
    expect(compiled.sql).toContain(`"organizations"."updated_at" < now() - interval '15 minutes'`);
    expect(compiled.params[0]).toBe('purging');
  });

  // Review fix I-5: the 15-minute grace bounds when retrying STARTS, not how
  // long it continues — a permanently failing cascade looped the erasure every
  // 5 minutes forever. The attempt ceiling is what drops the row out.
  it('excludes rows past the attempt ceiling', () => {
    const compiled = dialect.sqlToQuery(buildArchivePurgingRecoveryCandidatesWhere());

    expect(compiled.sql).toContain(`jsonb_typeof("organizations"."settings"->$2) = 'number'`);
    expect(compiled.sql).toContain('<= $5');
    expect(compiled.params).toEqual([
      'purging',
      ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY,
      1000, // clamp ceiling
      ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY,
      ARCHIVE_PURGING_RECOVERY_MAX_ATTEMPTS,
    ]);
  });

  // Review r3: this key lives in a CLIENT-WRITABLE blob and is read by the
  // FLEET-WIDE candidate snapshot, which is taken before the sweep's per-org
  // try/catch — so a single bad value used to be able to abort the sweep for
  // every tenant. `jsonb_typeof` alone was insufficient: it admits fractional
  // and out-of-range numbers, and `'0.5'::int` / `'1e400'::int` still raise.
  it('cannot raise on ANY jsonb value: numeric route, floor, and a two-sided clamp before ::int', () => {
    const compiled = dialect.sqlToQuery(buildArchivePurgingRecoveryCandidatesWhere());

    // Non-numbers never reach a cast at all.
    expect(compiled.sql).toContain('ELSE 0');
    // Numbers go via numeric (any magnitude), floor (no fractional), then a
    // clamp on BOTH sides — so the ::int can never be out of range.
    expect(compiled.sql).toContain('::numeric');
    expect(compiled.sql).toContain('floor(');
    expect(compiled.sql).toContain('GREATEST(0, LEAST(');
    // The ::int must come AFTER the clamp, never straight off the raw value.
    expect(compiled.sql).not.toMatch(/->>\$\d+\)::int/);
    expect(compiled.sql).toMatch(/\)\)::int/);
  });
});

describe('archive purging-recovery attempt increment (compiled SQL)', () => {
  const dialect = new PgDialect();
  const orgId = '11111111-1111-4111-8111-111111111111';

  it('increments atomically, status-guarded, and returns the NEW count', () => {
    const compiled = dialect.sqlToQuery(
      buildArchivePurgingRecoveryAttemptIncrement(orgId)
    );

    expect(compiled.sql).toContain('jsonb_set');
    expect(compiled.sql).toContain(`'{${ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY}}'`);
    expect(compiled.sql).toContain(`status = 'purging'`);
    expect(compiled.sql).toContain('RETURNING');
    expect(compiled.params).toContain(orgId);
  });

  // Bumping updated_at would push the row past the 15-minute age guard and
  // silently turn the 5-minute recovery cadence into a 15-minute backoff.
  it('does NOT touch updated_at', () => {
    const compiled = dialect.sqlToQuery(
      buildArchivePurgingRecoveryAttemptIncrement(orgId)
    );
    expect(compiled.sql).not.toContain('updated_at');
  });
});
