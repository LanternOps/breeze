import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  selectRows: [] as unknown[][],
  updateRows: [] as unknown[][],
  updates: [] as Array<{ values: Record<string, unknown>; where: unknown }>,
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
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('./tenantOffboarding', () => ({
  ARCHIVE_PURGE_WARN_14_SENT_AT_KEY: 'archivePurgeWarn14SentAt',
  ARCHIVE_PURGE_WARN_1_SENT_AT_KEY: 'archivePurgeWarn1SentAt',
  beginOrganizationOffboarding: vi.fn(async () => ({
    revocation: {},
    devicesTargeted: 0,
    uninstallsQueued: 0,
    otherCommandsCancelled: 0,
  })),
  finalizeOrganizationOffboarding: vi.fn(async () => ({ scopeType: 'organization' })),
}));

vi.mock('./tenantLifecycle', () => ({
  liftArchiveSuspension: vi.fn(async () => ({ agentTokensRestored: 1 })),
}));

import { beginOrganizationOffboarding, finalizeOrganizationOffboarding } from './tenantOffboarding';
import { liftArchiveSuspension } from './tenantLifecycle';
import {
  beginOrgArchive,
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
    state.selectRows.push([{ status }]);
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
    const compiled = new PgDialect().sqlToQuery(update.where as SQL);
    expect(compiled.sql).toBe('("organizations"."id" = $1 and "organizations"."status" = $2)');
    expect(compiled.params).toEqual([ORG_ID, status]);
  });

  it('skips the drain for suspended and finalizes archive immediately', async () => {
    state.selectRows.push([{ status: 'suspended' }]);
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
    state.selectRows.push([{ status: 'archived' }]);

    await expect(beginOrgArchive({
      orgId: ORG_ID,
      retentionDays: 90,
      actor: ACTOR_ID,
      now: NOW,
    })).rejects.toBeInstanceOf(OrgArchiveStateError);

    expect(state.updates).toHaveLength(0);
  });

  it('reports a lost entry CAS instead of starting a drain', async () => {
    state.selectRows.push([{ status: 'active' }]);
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
  it('reports only material that archive can actually require recreating', () => {
    expect(REVERSIBILITY_NOTES).toEqual([
      'Agents that completed the archive uninstall must be re-enrolled.',
    ]);
  });

  it('ships one atomic archived-only CAS that clears archive lifecycle columns', async () => {
    state.updateRows.push([{ id: ORG_ID }]);

    const result = await restoreOrgFromArchive({ orgId: ORG_ID, actor: ACTOR_ID });

    expect(result).toEqual({ recreateRequired: REVERSIBILITY_NOTES });
    expect(state.updates).toHaveLength(1);
    const update = state.updates[0]!;
    expect(update.values).toMatchObject({
      status: 'active',
      archivedAt: null,
      purgeAt: null,
      offboardingTarget: 'churn',
    });
    const settingsSql = new PgDialect().sqlToQuery(update.values.settings as SQL);
    expect(settingsSql.sql).toBe(
      `coalesce("organizations"."settings", '{}'::jsonb) - $1 - $2`
    );
    expect(settingsSql.params).toEqual([
      'archivePurgeWarn14SentAt',
      'archivePurgeWarn1SentAt',
    ]);

    const compiled = new PgDialect().sqlToQuery(update.where as SQL);
    expect(compiled.sql).toBe('("organizations"."id" = $1 and "organizations"."status" = $2)');
    expect(compiled.params).toEqual([ORG_ID, 'archived']);
    expect(liftArchiveSuspension).toHaveBeenCalledWith(ORG_ID);
  });

  it('does not lift suspensions when the archived-only CAS loses', async () => {
    state.updateRows.push([]);

    await expect(
      restoreOrgFromArchive({ orgId: ORG_ID, actor: ACTOR_ID })
    ).rejects.toBeInstanceOf(OrgArchiveStateError);

    expect(liftArchiveSuspension).not.toHaveBeenCalled();
  });
});
