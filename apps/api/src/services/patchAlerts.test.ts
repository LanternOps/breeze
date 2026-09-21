import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// AI patch agent W04 (#5750) — server-side patch alert sources. Both emitters
// MUST write through createAlert (the shared cooldown/dedupe/publish path),
// never a bare insert into `alerts` — see #5241 (rule-less inbox-only alerts
// with no notification) and the CLAUDE.md `createAlert` contract.

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  getCurrentDbAccessContext: vi.fn(() => null),
}));

vi.mock('../db/schema', () => ({
  alertTemplates: {
    id: 'id',
    orgId: 'org_id',
    partnerId: 'partner_id',
    name: 'name',
    createdAt: 'created_at',
  },
  alertRules: {
    retiredAt: 'retired_at',
    id: 'id',
    orgId: 'org_id',
    name: 'name',
  },
  alerts: {
    id: 'id',
    ruleId: 'rule_id',
  },
  devices: {
    id: 'id',
    orgId: 'org_id',
    hostname: 'hostname',
  },
  patchJobResults: {
    id: 'id',
    jobId: 'job_id',
    deviceId: 'device_id',
    status: 'status',
    rebootRequired: 'reboot_required',
    completedAt: 'completed_at',
  },
  patchJobs: {
    id: 'id',
    orgId: 'org_id',
  },
}));

vi.mock('./alertService', () => ({
  createAlert: vi.fn().mockResolvedValue('alert-1'),
}));

vi.mock('./featureConfigResolver', () => ({
  checkDeviceMaintenanceWindow: vi.fn().mockResolvedValue({
    active: false,
    source: 'none',
    suppressAlerts: false,
    suppressPatching: false,
    suppressAutomations: false,
    suppressScripts: false,
  }),
}));

vi.mock('./sentry', () => ({
  captureException: vi.fn(),
}));

import { db } from '../db';
import { alertTemplates, alertRules, alerts } from '../db/schema';
import { createAlert } from './alertService';
import { checkDeviceMaintenanceWindow } from './featureConfigResolver';
import { captureException } from './sentry';
import {
  PATCH_ALERT_CATEGORY,
  REBOOT_PENDING_ALERT_THRESHOLD_DAYS,
  ensurePatchJobFailureRule,
  ensureRebootPendingRule,
  emitPatchJobFailureAlert,
  emitRebootPendingAlert,
  rebootPendingSince,
  rebootPendingDays,
} from './patchAlerts';

const ORG_ID = 'org-1';
const DEVICE_ID = 'device-1';
const JOB_ID = 'job-1';

/** A select().from().where().orderBy().limit() / .limit() chain double. */
function mockSelectOnce(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit,
        orderBy: vi.fn().mockReturnValue({ limit }),
      }),
    }),
  } as any);
}

type InsertCall = { table: unknown; values: Record<string, unknown> };
let insertCalls: InsertCall[];

function primeInserts(rowsByTable: Map<unknown, Record<string, unknown>>) {
  insertCalls = [];
  vi.mocked(db.insert).mockImplementation((table: unknown) => ({
    values: vi.fn((values: Record<string, unknown>) => {
      insertCalls.push({ table, values });
      const row = rowsByTable.get(table) ?? {};
      return {
        returning: vi.fn().mockResolvedValue([row]),
      };
    }),
  }) as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.select).mockReset();
  insertCalls = [];
  vi.mocked(createAlert).mockResolvedValue('alert-1');
  vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
    active: false,
    source: 'none',
    suppressAlerts: false,
    suppressPatching: false,
    suppressAutomations: false,
    suppressScripts: false,
  } as any);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('PATCH_ALERT_CATEGORY', () => {
  it('re-exports the shared category spelling', () => {
    expect(PATCH_ALERT_CATEGORY).toBe('patching');
  });
});

describe.each([ensurePatchJobFailureRule, ensureRebootPendingRule])('patch rule provisioning: %s', (ensureRule) => {
  it.each([false, true])('only reuses live rules (existing retired: %s)', async (retired) => {
    const existing = { id: 'existing-rule', retiredAt: retired ? new Date() : null };
    let lookup: ReturnType<PgDialect['sqlToQuery']> | undefined;
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn((condition: SQL) => {
          lookup = new PgDialect().sqlToQuery(condition);
          const retiredParameter = lookup.params.indexOf('retired_at') + 1;
          const excludesRetired = lookup.sql.includes(`$${retiredParameter} is null`);
          return { limit: vi.fn().mockResolvedValue(retired && excludesRetired ? [] : [existing]) };
        }),
      }),
    } as any);
    if (retired) mockSelectOnce([{ id: 'template-1' }]);
    primeInserts(new Map([[alertRules, { id: 'fresh-rule' }]]));

    expect(await ensureRule(ORG_ID)).toBe(retired ? 'fresh-rule' : 'existing-rule');
    expect(lookup?.params).toContain(ORG_ID);
    expect(lookup?.params).toContain('retired_at');
    expect(insertCalls.filter((call) => call.table === alertRules)).toHaveLength(retired ? 1 : 0);
  });
});

describe('emitPatchJobFailureAlert', () => {
  it('raises through createAlert with a ruleId, never inserting into alerts directly', async () => {
    mockSelectOnce([{ hostname: 'HOST-01' }]); // hostname lookup
    mockSelectOnce([{ id: 'rule-1' }]); // ensureRule: existing rule

    const alertId = await emitPatchJobFailureAlert({
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      patchJobId: JOB_ID,
      failedCount: 2,
      errorExcerpt: 'disk full',
    });

    expect(alertId).toBe('alert-1');
    expect(vi.mocked(createAlert)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createAlert)).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleId: 'rule-1',
        deviceId: DEVICE_ID,
        orgId: ORG_ID,
        severity: 'high',
      }),
    );
    // The alert row itself is only ever written by createAlert (mocked away);
    // this module never inserts into `alerts` directly.
    for (const call of vi.mocked(db.insert).mock.calls) {
      expect(call[0]).not.toBe(alerts);
    }
  });

  it('creates a GLOBAL template (orgId/partnerId null, isBuiltIn true, category patching) when none exists yet', async () => {
    primeInserts(new Map<unknown, Record<string, unknown>>([
      [alertTemplates, { id: 'template-1' }],
      [alertRules, { id: 'rule-1' }],
    ]));
    mockSelectOnce([{ hostname: 'HOST-01' }]); // hostname lookup
    mockSelectOnce([]); // ensureRule: no existing rule
    mockSelectOnce([]); // ensureGlobalTemplate: no existing global template

    await emitPatchJobFailureAlert({
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      patchJobId: JOB_ID,
      failedCount: 1,
      errorExcerpt: null,
    });

    const templateInsert = insertCalls.find((c) => c.table === alertTemplates);
    expect(templateInsert).toBeDefined();
    expect(templateInsert!.values).toMatchObject({
      orgId: null,
      partnerId: null,
      isBuiltIn: true,
      category: PATCH_ALERT_CATEGORY,
    });
  });

  it('respects an active maintenance window with suppressAlerts (createAlert not called)', async () => {
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
      active: true,
      source: 'standalone',
      suppressAlerts: true,
      suppressPatching: false,
      suppressAutomations: false,
      suppressScripts: false,
    } as any);

    const result = await emitPatchJobFailureAlert({
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      patchJobId: JOB_ID,
      failedCount: 1,
      errorExcerpt: null,
    });

    expect(result).toBeNull();
    expect(vi.mocked(createAlert)).not.toHaveBeenCalled();
  });

  it('does not suppress when maintenance is active but does not suppress alerts', async () => {
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
      active: true,
      source: 'standalone',
      suppressAlerts: false,
      suppressPatching: true,
      suppressAutomations: false,
      suppressScripts: false,
    } as any);
    mockSelectOnce([{ hostname: 'HOST-01' }]);
    mockSelectOnce([{ id: 'rule-1' }]);

    const result = await emitPatchJobFailureAlert({
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      patchJobId: JOB_ID,
      failedCount: 1,
      errorExcerpt: null,
    });

    expect(result).toBe('alert-1');
    expect(vi.mocked(createAlert)).toHaveBeenCalledTimes(1);
  });

  it('honours cooldown — createAlert returning null makes the emitter return null without throwing', async () => {
    mockSelectOnce([{ hostname: 'HOST-01' }]);
    mockSelectOnce([{ id: 'rule-1' }]);
    vi.mocked(createAlert).mockResolvedValue(null);

    await expect(
      emitPatchJobFailureAlert({
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        patchJobId: JOB_ID,
        failedCount: 1,
        errorExcerpt: null,
      }),
    ).resolves.toBeNull();
  });

  it('swallows an exception from createAlert and reports it via captureException', async () => {
    mockSelectOnce([{ hostname: 'HOST-01' }]);
    mockSelectOnce([{ id: 'rule-1' }]);
    vi.mocked(createAlert).mockRejectedValue(new Error('boom'));

    const result = await emitPatchJobFailureAlert({
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      patchJobId: JOB_ID,
      failedCount: 1,
      errorExcerpt: null,
    });

    expect(result).toBeNull();
    expect(vi.mocked(captureException)).toHaveBeenCalled();
  });

  it('uses the given hostname without a DB lookup when provided', async () => {
    mockSelectOnce([{ id: 'rule-1' }]);

    await emitPatchJobFailureAlert({
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      patchJobId: JOB_ID,
      hostname: 'GIVEN-HOST',
      failedCount: 1,
      errorExcerpt: null,
    });

    expect(vi.mocked(createAlert)).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('GIVEN-HOST') }),
    );
    // Only the rule lookup ran — no separate hostname select.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });
});

describe('rebootPendingSince', () => {
  const now = new Date('2026-09-15T00:00:00.000Z');

  it('returns null when uptime is unknown', () => {
    expect(
      rebootPendingSince({ uptimeSeconds: null, oldestRebootRequiredSince: null, now }),
    ).toBeNull();
  });

  it('returns the patch-result timestamp when it is AFTER last boot', () => {
    const lastBoot = new Date(now.getTime() - 5 * 86400_000); // up 5 days
    const resultAfterBoot = new Date(now.getTime() - 3 * 86400_000); // reboot-required flagged 3 days ago
    const since = rebootPendingSince({
      uptimeSeconds: 5 * 86400,
      oldestRebootRequiredSince: resultAfterBoot,
      now,
    });
    expect(since?.getTime()).toBe(resultAfterBoot.getTime());
    expect(since?.getTime()).not.toBe(lastBoot.getTime());
  });

  it('falls back to last boot when the patch result predates it (stale)', () => {
    const staleResult = new Date(now.getTime() - 30 * 86400_000);
    const since = rebootPendingSince({
      uptimeSeconds: 5 * 86400,
      oldestRebootRequiredSince: staleResult,
      now,
    });
    expect(since?.getTime()).toBe(now.getTime() - 5 * 86400_000);
  });

  it('falls back to last boot when there is no patch result at all', () => {
    const since = rebootPendingSince({
      uptimeSeconds: 5 * 86400,
      oldestRebootRequiredSince: null,
      now,
    });
    expect(since?.getTime()).toBe(now.getTime() - 5 * 86400_000);
  });
});

describe('rebootPendingDays', () => {
  it('floors whole days between since and now', () => {
    const now = new Date('2026-09-15T00:00:00.000Z');
    const since = new Date('2026-09-08T12:00:00.000Z'); // 6.5 days
    expect(rebootPendingDays(since, now)).toBe(6);
  });
});

describe('emitRebootPendingAlert', () => {
  const now = new Date('2026-09-15T00:00:00.000Z');

  it('does not alert below the threshold', async () => {
    const result = await emitRebootPendingAlert({
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      hostname: 'HOST-01',
      uptimeSeconds: (REBOOT_PENDING_ALERT_THRESHOLD_DAYS - 1) * 86400,
      oldestRebootRequiredSince: null,
      now,
    });

    expect(result).toBeNull();
    expect(vi.mocked(createAlert)).not.toHaveBeenCalled();
  });

  it('alerts once at/above the threshold with severity medium', async () => {
    mockSelectOnce([{ id: 'rule-1' }]);

    const result = await emitRebootPendingAlert({
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      hostname: 'HOST-01',
      uptimeSeconds: (REBOOT_PENDING_ALERT_THRESHOLD_DAYS + 1) * 86400,
      oldestRebootRequiredSince: null,
      now,
    });

    expect(result).toBe('alert-1');
    expect(vi.mocked(createAlert)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createAlert)).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'medium', deviceId: DEVICE_ID, orgId: ORG_ID }),
    );
  });

  it('returns null when uptime is unknown, without calling createAlert', async () => {
    const result = await emitRebootPendingAlert({
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      hostname: 'HOST-01',
      uptimeSeconds: null,
      oldestRebootRequiredSince: null,
      now,
    });
    expect(result).toBeNull();
    expect(vi.mocked(createAlert)).not.toHaveBeenCalled();
  });

  it('respects maintenance suppressAlerts even above threshold', async () => {
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({
      active: true,
      source: 'standalone',
      suppressAlerts: true,
      suppressPatching: false,
      suppressAutomations: false,
      suppressScripts: false,
    } as any);

    const result = await emitRebootPendingAlert({
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      hostname: 'HOST-01',
      uptimeSeconds: (REBOOT_PENDING_ALERT_THRESHOLD_DAYS + 5) * 86400,
      oldestRebootRequiredSince: null,
      now,
    });

    expect(result).toBeNull();
    expect(vi.mocked(createAlert)).not.toHaveBeenCalled();
  });
});
