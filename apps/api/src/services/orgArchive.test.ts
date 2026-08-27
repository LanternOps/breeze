import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  selectRows: [] as unknown[][],
  updateRows: [] as unknown[][],
  updates: [] as Array<{ values: Record<string, unknown>; where: unknown }>,
  // Restore now ships raw CASes through db.execute (it needs a CASE-validated
  // enum cast and RETURNING status), so those are captured separately.
  executeRows: [] as unknown[][],
  executed: [] as unknown[],
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => state.selectRows.shift() ?? []),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn((where: unknown) => {
          state.updates.push({ values, where });
          return {
            returning: vi.fn(async () => state.updateRows.shift() ?? []),
          };
        }),
      })),
    })),
    execute: vi.fn(async (query: unknown) => {
      state.executed.push(query);
      return state.executeRows.shift() ?? [];
    }),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

// Review hardening (M6, round 2): spread the REAL module's exports (via
// importActual) and override only the two functions this suite needs
// stubbed. The prior version re-declared the marker key strings as literals
// here, so the "imported constants" the assertions below read were actually
// this mock's own copy — a rename of the real constant would have left this
// suite green while every other consumer broke. Spreading `actual` means the
// constants come from the one real source of truth, and a rename reddens
// this file too.
vi.mock('./tenantOffboarding', async () => {
  const actual = await vi.importActual<typeof import('./tenantOffboarding')>('./tenantOffboarding');
  return {
    ...actual,
    beginOrganizationOffboarding: vi.fn(async () => ({
      revocation: {},
      devicesTargeted: 0,
      uninstallsQueued: 0,
      otherCommandsCancelled: 0,
    })),
    finalizeOrganizationOffboarding: vi.fn(async () => ({ scopeType: 'organization' })),
    abortOrganizationOffboarding: vi.fn(async () => ({ aborted: true, uninstallsCancelled: 3 })),
  };
});

vi.mock('./tenantLifecycle', () => ({
  liftArchiveSuspension: vi.fn(async () => ({ agentTokensRestored: 1 })),
}));

import {
  ARCHIVE_PURGE_WARN_14_SENT_AT_KEY,
  ARCHIVE_PURGE_WARN_1_SENT_AT_KEY,
  ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY,
  abortOrganizationOffboarding,
  beginOrganizationOffboarding,
  finalizeOrganizationOffboarding,
} from './tenantOffboarding';
import { liftArchiveSuspension } from './tenantLifecycle';
import { db } from '../db';
import {
  ARCHIVE_PRIOR_STATUS_KEY,
  beginOrgArchive,
  buildArchiveDrainAbortCas,
  buildArchiveRestoreCas,
  computePurgeAt,
  OrgArchiveStateError,
  restoreOrgFromArchive,
  REVERSIBILITY_NOTES,
} from './orgArchive';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-08-26T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  state.selectRows = [];
  state.updateRows = [];
  state.updates = [];
  state.executeRows = [];
  state.executed = [];
});

describe('computePurgeAt', () => {
  it('returns null for keep-forever retention', () => {
    expect(computePurgeAt(null, NOW)).toBeNull();
  });

  it('adds an explicit number of whole days', () => {
    expect(computePurgeAt(30, NOW)).toEqual(new Date('2026-09-25T12:00:00.000Z'));
  });

  it('uses ORG_ARCHIVE_DEFAULT_RETENTION_DAYS through envInt when omitted', () => {
    process.env.ORG_ARCHIVE_DEFAULT_RETENTION_DAYS = '45';
    expect(computePurgeAt(undefined, NOW)).toEqual(new Date('2026-10-10T12:00:00.000Z'));
    delete process.env.ORG_ARCHIVE_DEFAULT_RETENTION_DAYS;
  });
});

describe('beginOrgArchive', () => {
  it.each(['active', 'trial'] as const)('CAS-enters the drain from %s and starts archive-target offboarding', async (status) => {
    const purgeAt = new Date('2026-11-24T12:00:00.000Z');
    state.selectRows.push([{ status, type: 'customer' }]);
    state.updateRows.push([{ id: ORG_ID }]);

    const result = await beginOrgArchive({
      orgId: ORG_ID,
      retentionDays: 90,
      actor: ACTOR_ID,
      now: NOW,
    });

    expect(result).toEqual({ status: 'offboarding', purgeAt });
    expect(beginOrganizationOffboarding).toHaveBeenCalledWith(ORG_ID, ACTOR_ID, {
      target: 'archive',
      purgeAt,
    });
    expect(finalizeOrganizationOffboarding).not.toHaveBeenCalled();

    const update = state.updates[0]!;
    expect(update.values).toMatchObject({
      status: 'offboarding',
      offboardingTarget: 'archive',
      purgeAt,
    });
    // Review fix I-3: the PRE-archive status is stashed in the SAME
    // status-guarded CAS, as one atomic jsonb_set (never read-modify-write).
    const settingsSql = new PgDialect().sqlToQuery(update.values.settings as SQL);
    expect(settingsSql.sql).toContain('jsonb_set');
    expect(settingsSql.sql).toContain(`'{${ARCHIVE_PRIOR_STATUS_KEY}}'`);
    // Review r3: every engine-owned key is DROPPED before the stamp, so a
    // stale marker or a preseeded recovery counter cannot ride into this
    // archive from a previous cycle or from a client PATCH.
    expect(settingsSql.params).toEqual([
      ARCHIVE_PURGE_WARN_14_SENT_AT_KEY,
      ARCHIVE_PURGE_WARN_1_SENT_AT_KEY,
      ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY,
      status,
    ]);

    const compiled = new PgDialect().sqlToQuery(update.where as SQL);
    expect(compiled.sql).toBe('("organizations"."id" = $1 and "organizations"."status" = $2)');
    expect(compiled.params).toEqual([ORG_ID, status]);
  });

  // Review fix I-7: archiving the hidden per-partner Quick Support org is a
  // one-way door — every archived READ filters it out ("archiving is not a way
  // to surface it") while the purge sweeper, which looks only at status +
  // purge_at, would still erase it. orgMerge already refuses the same type.
  it('refuses a quick_support organization before any write', async () => {
    state.selectRows.push([{ status: 'active', type: 'quick_support' }]);

    await expect(beginOrgArchive({
      orgId: ORG_ID,
      retentionDays: 90,
      actor: ACTOR_ID,
      now: NOW,
    })).rejects.toBeInstanceOf(OrgArchiveStateError);

    expect(state.updates).toHaveLength(0);
    expect(beginOrganizationOffboarding).not.toHaveBeenCalled();
  });

  it('skips the drain for suspended and finalizes archive immediately', async () => {
    state.selectRows.push([{ status: 'suspended', type: 'customer' }]);
    state.updateRows.push([{ id: ORG_ID }]);

    const result = await beginOrgArchive({
      orgId: ORG_ID,
      retentionDays: null,
      actor: ACTOR_ID,
      now: NOW,
    });

    expect(result).toEqual({ status: 'archived', purgeAt: null });
    expect(beginOrganizationOffboarding).not.toHaveBeenCalled();
    expect(finalizeOrganizationOffboarding).toHaveBeenCalledWith(
      ORG_ID,
      { forcedByDeadline: false }
    );
  });

  it('rejects any entry status outside active, trial, or suspended', async () => {
    state.selectRows.push([{ status: 'archived', type: 'customer' }]);

    await expect(beginOrgArchive({
      orgId: ORG_ID,
      retentionDays: 90,
      actor: ACTOR_ID,
      now: NOW,
    })).rejects.toBeInstanceOf(OrgArchiveStateError);

    expect(state.updates).toHaveLength(0);
  });

  it('reports a lost entry CAS instead of starting a drain', async () => {
    state.selectRows.push([{ status: 'active', type: 'customer' }]);
    state.updateRows.push([]);

    await expect(beginOrgArchive({
      orgId: ORG_ID,
      retentionDays: 90,
      actor: ACTOR_ID,
      now: NOW,
    })).rejects.toBeInstanceOf(OrgArchiveStateError);

    expect(beginOrganizationOffboarding).not.toHaveBeenCalled();
  });
});

describe('restoreOrgFromArchive', () => {
  const dialect = new PgDialect();

  it('reports only material that archive can actually require recreating', () => {
    expect(REVERSIBILITY_NOTES).toEqual([
      'Agents that completed the archive uninstall must be re-enrolled.',
    ]);
  });

  // ── I-3: status-preserving restore ────────────────────────────────────────
  // Restore used to hard-code `status: 'active'`, so archive→restore was a
  // two-call SUSPENSION RESET: a customer suspended for non-payment came back
  // fully active with no record it had ever been suspended.
  it('restores the STASHED prior status, not a hard-coded active (compiled SQL)', () => {
    const { sql, params } = dialect.sqlToQuery(buildArchiveRestoreCas(ORG_ID));

    expect(sql).toContain(`settings->>$1 IN ($2, $3, $4)`);
    expect(sql).toContain('::org_status');
    expect(sql).not.toMatch(/SET\s+status = 'active'/);
    // Allowlisted prior statuses + the fallback for a missing/edited value.
    expect(params.slice(0, 4)).toEqual([
      ARCHIVE_PRIOR_STATUS_KEY, 'active', 'trial', 'suspended',
    ]);
    expect(sql).toContain("ELSE 'active'");
  });

  it('clears every archive marker AND the prior-status key in one jsonb expression', () => {
    const { sql, params } = dialect.sqlToQuery(buildArchiveRestoreCas(ORG_ID));

    expect(sql).toContain('archived_at = NULL');
    expect(sql).toContain('purge_at = NULL');
    expect(sql).toContain("offboarding_target = 'churn'");
    expect(sql).toContain("COALESCE(settings, '{}'::jsonb)");
    expect(params).toEqual(expect.arrayContaining([
      ARCHIVE_PURGE_WARN_14_SENT_AT_KEY,
      ARCHIVE_PURGE_WARN_1_SENT_AT_KEY,
      ARCHIVE_PRIOR_STATUS_KEY,
      // Review r3: the purge-retry counter is reset on the way out too, so a
      // re-archive always starts from a clean ceiling.
      ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY,
    ]));
  });

  it('CASes only an archived row, and reports the restored status', async () => {
    state.executeRows.push([{ id: ORG_ID, status: 'suspended' }]);

    const result = await restoreOrgFromArchive({ orgId: ORG_ID, actor: ACTOR_ID });

    expect(result).toEqual({
      status: 'suspended',
      recreateRequired: REVERSIBILITY_NOTES,
      aborted: false,
      uninstallsCancelled: 0,
    });
    expect(state.executed).toHaveLength(1);
    expect(dialect.sqlToQuery(state.executed[0] as SQL).sql).toContain("status = 'archived'");
    expect(liftArchiveSuspension).toHaveBeenCalledWith(ORG_ID);
    expect(abortOrganizationOffboarding).not.toHaveBeenCalled();
  });

  // ── I-4: abort the in-flight drain ────────────────────────────────────────
  // Between `beginOrgArchive` and the finalize the org is `offboarding`, which
  // is outside accessibleOrgIds and outside the archived reads — so before this
  // a mis-clicked archive was uncancellable for up to 72h while self_uninstall
  // was delivered to the customer's entire fleet.
  it('aborts an archive-target drain: cancels uninstalls FIRST, then CASes back', async () => {
    state.executeRows.push([]); // archived CAS loses — the org is still draining
    state.selectRows.push([{ status: 'offboarding', offboardingTarget: 'archive' }]);
    state.executeRows.push([{ id: ORG_ID, status: 'trial' }]);

    const result = await restoreOrgFromArchive({ orgId: ORG_ID, actor: ACTOR_ID });

    expect(result).toEqual({
      status: 'trial',
      recreateRequired: REVERSIBILITY_NOTES,
      aborted: true,
      uninstallsCancelled: 3,
    });
    expect(abortOrganizationOffboarding).toHaveBeenCalledWith(ORG_ID);
    // Order matters: an uncollected self_uninstall must never survive into a
    // reactivated tenant, so the cancellation precedes the status flip.
    const abortOrder = vi.mocked(abortOrganizationOffboarding).mock.invocationCallOrder[0]!;
    const casOrder = vi.mocked(db.execute).mock.invocationCallOrder[1]!;
    expect(abortOrder).toBeLessThan(casOrder);
  });

  it('scopes the abort CAS to offboarding_target=archive (compiled SQL)', () => {
    const { sql } = dialect.sqlToQuery(buildArchiveDrainAbortCas(ORG_ID));
    expect(sql).toContain("status = 'offboarding'");
    expect(sql).toContain("offboarding_target = 'archive'");
  });

  it('does NOT restore a churn-target offboarding org', async () => {
    state.executeRows.push([]); // archived CAS loses
    state.selectRows.push([{ status: 'offboarding', offboardingTarget: 'churn' }]);

    await expect(
      restoreOrgFromArchive({ orgId: ORG_ID, actor: ACTOR_ID })
    ).rejects.toBeInstanceOf(OrgArchiveStateError);

    expect(abortOrganizationOffboarding).not.toHaveBeenCalled();
    expect(liftArchiveSuspension).not.toHaveBeenCalled();
    expect(state.executed).toHaveLength(1); // no abort CAS was even attempted
  });

  it('does not lift suspensions when the org is in neither restorable state', async () => {
    state.executeRows.push([]);
    state.selectRows.push([{ status: 'purging', offboardingTarget: 'archive' }]);

    await expect(
      restoreOrgFromArchive({ orgId: ORG_ID, actor: ACTOR_ID })
    ).rejects.toMatchObject({ name: 'OrgArchiveStateError', currentStatus: 'purging' });

    expect(liftArchiveSuspension).not.toHaveBeenCalled();
  });

  it('throws when the abort CAS loses the race after the uninstall cancellation', async () => {
    state.executeRows.push([]); // archived CAS loses
    state.selectRows.push([{ status: 'offboarding', offboardingTarget: 'archive' }]);
    state.executeRows.push([]); // abort CAS loses too

    // The throw rolls back the surrounding system transaction, so the
    // cancellation is undone with it — the org stays draining rather than
    // going live with uncollected uninstalls.
    await expect(
      restoreOrgFromArchive({ orgId: ORG_ID, actor: ACTOR_ID })
    ).rejects.toBeInstanceOf(OrgArchiveStateError);
  });
});
