/**
 * Unit tests for the PAM evidence retention worker (PAM ownership epochs W5).
 * BullMQ + db are stubbed; real DELETE behavior (grants, trigger GUC, FK order,
 * held-shell scoping) is covered by
 * `__tests__/integration/pamEvidenceRetention.integration.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  dbExecuteMock,
  captureExceptionMock,
  captureMessageMock,
  recordRetentionRunMock,
  hasDedicatedPoolMock,
  getAuditAdminDbMock,
  capturedWorker,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  dbExecuteMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  captureMessageMock: vi.fn(),
  recordRetentionRunMock: vi.fn(),
  hasDedicatedPoolMock: vi.fn(),
  getAuditAdminDbMock: vi.fn(),
  capturedWorker: { name: null as null | string, processor: null as null | ((job: unknown) => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = (...args: unknown[]) => addMock(...(args as []));
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...(args as []));
    close = () => queueCloseMock();
  },
  Worker: class {
    constructor(name: string, processor: (job: unknown) => Promise<unknown>) {
      capturedWorker.name = name;
      capturedWorker.processor = processor;
    }
    on = vi.fn();
    close = () => workerCloseMock();
  },
  Job: class {},
}));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
    db: { execute: (...args: unknown[]) => dbExecuteMock(...(args as [])) },
  };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...(args as [])),
  captureMessage: (...args: unknown[]) => captureMessageMock(...(args as [])),
}));

vi.mock('../db/auditAdminPool', () => ({
  hasDedicatedAuditAdminPool: () => hasDedicatedPoolMock(),
  getAuditAdminDb: () => getAuditAdminDbMock(),
  logAuditAdminPoolMode: () => {},
}));

vi.mock('../services/retentionMetrics', () => ({
  recordRetentionRun: (...args: unknown[]) => recordRetentionRunMock(...(args as [])),
}));

import {
  __testOnly,
  createPamEvidenceRetentionWorker,
  initializePamEvidenceRetentionWorker,
  prunePamEvidence,
  schedulePamEvidenceRetention,
  shutdownPamEvidenceRetentionWorker,
} from './pamEvidenceRetention';

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: Array<{ value?: unknown } | string> }).queryChunks;
  if (!Array.isArray(chunks)) return String(query);
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk;
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? (value as string[]).join('') : '';
    })
    .join(' ');
}

const executed = () => dbExecuteMock.mock.calls.map((c: unknown[]) => sqlText(c[0]));

const ENV_KEYS = ['PAM_EVIDENCE_RETENTION_ENABLED', 'PAM_EVIDENCE_RETENTION_DAYS', 'AUDIT_ADMIN_DATABASE_URL'] as const;
const savedEnv: Record<string, string | undefined> = {};

describe('pamEvidenceRetention worker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    getRepeatableJobsMock.mockResolvedValue([]);
    addMock.mockResolvedValue(undefined);
    removeRepeatableByKeyMock.mockResolvedValue(undefined);
    queueCloseMock.mockResolvedValue(undefined);
    workerCloseMock.mockResolvedValue(undefined);
    dbExecuteMock.mockResolvedValue([]);
    hasDedicatedPoolMock.mockReturnValue(false);
    __testOnly.resetConfigReports();
    capturedWorker.name = null;
    capturedWorker.processor = null;
  });

  afterEach(async () => {
    await shutdownPamEvidenceRetentionWorker();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('uses a literal queue name, stable jobId and the registry cron', () => {
    expect(__testOnly.QUEUE_NAME).toBe('pam-evidence-retention');
    expect(__testOnly.REPEAT_JOB_ID).toBe('pam-evidence-retention');
    expect(__testOnly.DAILY_CRON).toBe('33 9 * * *');
    expect(__testOnly.DEFAULT_RETENTION_DAYS).toBe(400);
  });

  describe('env parsing', () => {
    it('falls back to the default for unset, blank, non-integer and non-positive values', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const parse = () => __testOnly.parsePositiveIntEnv('PAM_EVIDENCE_RETENTION_DAYS', 400);
      expect(parse()).toBe(400);
      for (const bad of ['', '  ', '1e9', 'abc', '-5', '0', '12.5']) {
        process.env.PAM_EVIDENCE_RETENTION_DAYS = bad;
        expect(parse()).toBe(400);
      }
      process.env.PAM_EVIDENCE_RETENTION_DAYS = ' 90 ';
      expect(parse()).toBe(90);
      warn.mockRestore();
    });

    it('resolveLimit rejects invalid job-data overrides', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(__testOnly.resolveLimit('x', undefined, 7)).toBe(7);
      expect(__testOnly.resolveLimit('x', 3, 7)).toBe(3);
      expect(__testOnly.resolveLimit('x', Number.NaN, 7)).toBe(7);
      expect(__testOnly.resolveLimit('x', 0, 7)).toBe(7);
      warn.mockRestore();
    });
  });

  describe('schedule registration', () => {
    it('registers a stable-jobId daily repeatable by default', async () => {
      await schedulePamEvidenceRetention();
      expect(addMock).toHaveBeenCalledTimes(1);
      const [name, data, opts] = addMock.mock.calls[0]!;
      expect(name).toBe('pam-evidence-retention');
      expect(data).toEqual({});
      expect(opts).toMatchObject({ jobId: 'pam-evidence-retention', repeat: { pattern: '33 9 * * *' } });
    });

    it('clears a stale repeatable before re-registering', async () => {
      getRepeatableJobsMock.mockResolvedValue([
        { name: 'pam-evidence-retention', key: 'old-key' },
        { name: 'other', key: 'keep' },
      ]);
      await schedulePamEvidenceRetention();
      expect(removeRepeatableByKeyMock).toHaveBeenCalledTimes(1);
      expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('old-key');
    });

    it.each(['false', 'FALSE', '0', 'no', 'off'])('kill switch %s skips registration', async (v) => {
      process.env.PAM_EVIDENCE_RETENTION_ENABLED = v;
      await schedulePamEvidenceRetention();
      expect(addMock).not.toHaveBeenCalled();
    });

    it('any other value keeps it enabled', async () => {
      process.env.PAM_EVIDENCE_RETENTION_ENABLED = 'true';
      await schedulePamEvidenceRetention();
      expect(addMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('worker', () => {
    it('is created on the literal queue and ignores unknown job names', async () => {
      createPamEvidenceRetentionWorker();
      expect(capturedWorker.name).toBe('pam-evidence-retention');
      const result = await capturedWorker.processor!({ name: 'something-else', data: {} });
      expect(result).toEqual({ skipped: true, rowsDeleted: 0 });
      expect(dbExecuteMock).not.toHaveBeenCalled();
    });

    it('initialize creates the worker and schedules', async () => {
      await initializePamEvidenceRetentionWorker();
      expect(capturedWorker.name).toBe('pam-evidence-retention');
      expect(addMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('prunePamEvidence', () => {
    const SHELL_A = '11111111-1111-4111-8111-111111111111';
    const SHELL_B = '22222222-2222-4222-8222-222222222222';

    it('reads held shells only and does nothing when there are none', async () => {
      dbExecuteMock.mockResolvedValue([]);
      const stats = await prunePamEvidence();
      expect(stats).toMatchObject({ shells: 0, shellsPruned: 0, errors: 0 });
      const sqls = executed();
      expect(sqls).toHaveLength(1);
      expect(sqls[0]).toMatch(/FROM org_evidence_holds/);
      expect(recordRetentionRunMock).toHaveBeenCalledWith('pam_evidence_retention', { rowsDeleted: 0, incomplete: false });
    });

    it('arms the role + retention GUC before any DELETE on the legacy path', async () => {
      dbExecuteMock.mockImplementation(async (q: unknown) => {
        const t = sqlText(q);
        if (/EXISTS \(SELECT 1 FROM org_evidence_holds/.test(t)) return [{ held: true }];
        if (/FROM org_evidence_holds/.test(t)) return [{ loser_org_id: SHELL_A }];
        return []; // no expired chains
      });
      await prunePamEvidence();
      const sqls = executed();
      const roleIdx = sqls.findIndex((t) => /SET LOCAL ROLE breeze_audit_admin/.test(t));
      const gucIdx = sqls.findIndex((t) => /SET LOCAL breeze\.allow_audit_retention = '1'/.test(t));
      const selectIdx = sqls.findIndex((t) => /FROM elevation_requests r/.test(t));
      expect(roleIdx).toBeGreaterThan(-1);
      expect(gucIdx).toBeGreaterThan(roleIdx);
      expect(selectIdx).toBeGreaterThan(gucIdx);
    });

    it('deletes in FK-safe order: results, actuations, audit, requests', async () => {
      let served = false;
      dbExecuteMock.mockImplementation(async (q: unknown) => {
        const t = sqlText(q);
        if (/EXISTS \(SELECT 1 FROM org_evidence_holds/.test(t)) return [{ held: true }];
        if (/FROM org_evidence_holds/.test(t)) return [{ loser_org_id: SHELL_A }];
        if (/FROM elevation_requests r/.test(t)) {
          if (served) return [];
          served = true;
          return [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }];
        }
        if (/^\s*DELETE FROM/.test(t)) return { count: 1 };
        return [];
      });
      const stats = await prunePamEvidence();
      const deletes = executed().filter((t) => /^\s*DELETE FROM/.test(t)).map((t) => /DELETE FROM (\w+)/.exec(t)![1]);
      expect(deletes).toEqual(['pam_actuation_results', 'pam_actuations', 'elevation_audit', 'elevation_requests']);
      expect(stats).toMatchObject({
        shells: 1, shellsPruned: 1, chainsDeleted: 1,
        resultsDeleted: 1, actuationsDeleted: 1, auditRowsDeleted: 1, requestsDeleted: 1,
      });
      expect(recordRetentionRunMock).toHaveBeenCalledWith('pam_evidence_retention', { rowsDeleted: 4, incomplete: false });
    });

    it('a failing shell does not abort the pass, marks the run incomplete, then fails the job', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      dbExecuteMock.mockImplementation(async (q: unknown) => {
        const t = sqlText(q);
        if (/EXISTS \(SELECT 1 FROM org_evidence_holds/.test(t)) return [{ held: true }];
        if (/FROM org_evidence_holds/.test(t)) return [{ loser_org_id: SHELL_A }, { loser_org_id: SHELL_B }];
        if (/FROM elevation_requests r/.test(t)) {
          // Shell A (first select) blows up; shell B finds nothing.
          const first = dbExecuteMock.mock.calls.filter((c: unknown[]) => /FROM elevation_requests r/.test(sqlText(c[0]))).length === 1;
          if (first) throw new Error('boom');
          return [];
        }
        return [];
      });
      await expect(prunePamEvidence()).rejects.toThrow(
        '[PamEvidenceRetention] 1 of 2 held shell(s) failed to prune',
      );
      expect(captureExceptionMock).toHaveBeenCalledWith(
        expect.any(Error),
        undefined,
        expect.objectContaining({ job: 'pam-evidence-retention', stage: 'prune', orgId: SHELL_A }),
      );
      // Shell B was still processed (its own role arming happened).
      expect(executed().filter((t) => /SET LOCAL ROLE/.test(t))).toHaveLength(2);
      expect(recordRetentionRunMock).toHaveBeenCalledWith('pam_evidence_retention', { rowsDeleted: 0, incomplete: true });
      err.mockRestore();
    });

    it('refuses an unreadable DELETE count instead of treating it as success', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      dbExecuteMock.mockImplementation(async (q: unknown) => {
        const t = sqlText(q);
        if (/EXISTS \(SELECT 1 FROM org_evidence_holds/.test(t)) return [{ held: true }];
        if (/FROM org_evidence_holds/.test(t)) return [{ loser_org_id: SHELL_A }];
        if (/FROM elevation_requests r/.test(t)) return [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }];
        if (/^\s*DELETE FROM/.test(t)) return {};
        return [];
      });
      await expect(prunePamEvidence()).rejects.toThrow(/1 of 1 held shell\(s\) failed to prune/);
      expect(recordRetentionRunMock).toHaveBeenCalledWith('pam_evidence_retention', { rowsDeleted: 0, incomplete: true });
      err.mockRestore();
    });

    it('reports a backlog when the batch ceiling is hit with full batches', async () => {
      dbExecuteMock.mockImplementation(async (q: unknown) => {
        const t = sqlText(q);
        if (/EXISTS \(SELECT 1 FROM org_evidence_holds/.test(t)) return [{ held: true }];
        if (/FROM org_evidence_holds/.test(t)) return [{ loser_org_id: SHELL_A }];
        if (/FROM elevation_requests r/.test(t)) return [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }];
        if (/^\s*DELETE FROM/.test(t)) return { count: 1 };
        return [];
      });
      const stats = await prunePamEvidence({ batchSize: 1, maxBatches: 2 });
      expect(stats.shellsWithBacklog).toBe(1);
      expect(stats.chainsDeleted).toBe(2);
      expect(recordRetentionRunMock).toHaveBeenCalledWith('pam_evidence_retention', expect.objectContaining({ incomplete: true }));
    });

    it('skips a shell whose hold vanished before the delete transaction ran', async () => {
      dbExecuteMock.mockImplementation(async (q: unknown) => {
        const t = sqlText(q);
        if (/EXISTS \(SELECT 1 FROM org_evidence_holds/.test(t)) return [{ held: false }];
        if (/FROM org_evidence_holds/.test(t)) return [{ loser_org_id: SHELL_A }];
        return [];
      });
      const stats = await prunePamEvidence();
      expect(stats).toMatchObject({ shells: 1, errors: 0, chainsDeleted: 0 });
      expect(executed().some((t) => /FROM elevation_requests r/.test(t))).toBe(false);
      expect(executed().some((t) => /^\s*DELETE FROM/.test(t))).toBe(false);
    });

    it('the expiry predicate counts from the hold creation (merge) as well as chain activity', async () => {
      dbExecuteMock.mockImplementation(async (q: unknown) => {
        const t = sqlText(q);
        if (/EXISTS \(SELECT 1 FROM org_evidence_holds/.test(t)) return [{ held: true }];
        if (/FROM org_evidence_holds/.test(t)) return [{ loser_org_id: SHELL_A }];
        return [];
      });
      await prunePamEvidence();
      const select = executed().find((t) => /FROM elevation_requests r/.test(t))!;
      expect(select).toMatch(/org_evidence_holds h/);
      expect(select).toMatch(/h\.created_at/);
    });

    describe('failure reporting', () => {
      it('all shells failing: records the run incomplete, then throws a summary', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        dbExecuteMock.mockImplementation(async (q: unknown) => {
          const t = sqlText(q);
          if (/EXISTS \(SELECT 1 FROM org_evidence_holds/.test(t)) return [{ held: true }];
          if (/FROM org_evidence_holds/.test(t)) return [{ loser_org_id: SHELL_A }, { loser_org_id: SHELL_B }];
          if (/FROM elevation_requests r/.test(t)) throw new Error('boom');
          return [];
        });
        await expect(prunePamEvidence()).rejects.toThrow(
          '[PamEvidenceRetention] 2 of 2 held shell(s) failed to prune',
        );
        expect(recordRetentionRunMock).toHaveBeenCalledTimes(1);
        expect(recordRetentionRunMock).toHaveBeenCalledWith('pam_evidence_retention', { rowsDeleted: 0, incomplete: true });
        err.mockRestore();
      });

      it('one of two failing: the other shell still deleted before the summary throw', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        let selects = 0;
        dbExecuteMock.mockImplementation(async (q: unknown) => {
          const t = sqlText(q);
          if (/EXISTS \(SELECT 1 FROM org_evidence_holds/.test(t)) return [{ held: true }];
          if (/FROM org_evidence_holds/.test(t)) return [{ loser_org_id: SHELL_A }, { loser_org_id: SHELL_B }];
          if (/FROM elevation_requests r/.test(t)) {
            selects += 1;
            if (selects === 1) throw new Error('boom'); // shell A
            return selects === 2 ? [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] : [];
          }
          if (/^\s*DELETE FROM/.test(t)) return { count: 1 };
          return [];
        });
        await expect(prunePamEvidence()).rejects.toThrow(/1 of 2 held shell\(s\) failed to prune/);
        expect(executed().filter((t) => /^\s*DELETE FROM/.test(t))).toHaveLength(4);
        expect(recordRetentionRunMock).toHaveBeenCalledWith('pam_evidence_retention', { rowsDeleted: 4, incomplete: true });
        err.mockRestore();
      });

      it('a failing held-shells query records the run incomplete, then rethrows', async () => {
        dbExecuteMock.mockRejectedValue(new Error('holds down'));
        await expect(prunePamEvidence()).rejects.toThrow('holds down');
        expect(recordRetentionRunMock).toHaveBeenCalledTimes(1);
        expect(recordRetentionRunMock).toHaveBeenCalledWith('pam_evidence_retention', { rowsDeleted: 0, incomplete: true });
      });
    });

    describe('TTL configuration', () => {
      const ttlParamSeen = (n: number) =>
        dbExecuteMock.mock.calls.some((c: unknown[]) => {
          const chunks = (c[0] as { queryChunks?: unknown[] }).queryChunks ?? [];
          return chunks.some((ch) => ch === n || (ch as { value?: unknown })?.value === n);
        });
      const oneShell = () =>
        dbExecuteMock.mockImplementation(async (q: unknown) => {
          const t = sqlText(q);
          if (/EXISTS \(SELECT 1 FROM org_evidence_holds/.test(t)) return [{ held: true }];
          if (/FROM org_evidence_holds/.test(t)) return [{ loser_org_id: SHELL_A }];
          return [];
        });

      it('an invalid env value falls back to 400 and reports once per process', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        process.env.PAM_EVIDENCE_RETENTION_DAYS = '90d';
        oneShell();
        await prunePamEvidence();
        await prunePamEvidence();
        expect(ttlParamSeen(400)).toBe(true);
        expect(captureMessageMock).toHaveBeenCalledTimes(1);
        expect(captureMessageMock).toHaveBeenCalledWith(
          expect.stringContaining('PAM_EVIDENCE_RETENTION_DAYS'),
          expect.objectContaining({ eventCode: expect.any(String) }),
        );
        warn.mockRestore();
      });

      it('a valid env value reports nothing', async () => {
        process.env.PAM_EVIDENCE_RETENTION_DAYS = '90';
        oneShell();
        await prunePamEvidence();
        expect(captureMessageMock).not.toHaveBeenCalled();
        expect(ttlParamSeen(90)).toBe(true);
      });

      it('a value below the 30-day floor is clamped to 30 and reported once', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        process.env.PAM_EVIDENCE_RETENTION_DAYS = '1';
        oneShell();
        await prunePamEvidence();
        await prunePamEvidence();
        expect(ttlParamSeen(30)).toBe(true);
        expect(ttlParamSeen(1)).toBe(false);
        expect(captureMessageMock).toHaveBeenCalledTimes(1);
        expect(captureMessageMock).toHaveBeenCalledWith(
          expect.stringContaining('30'),
          expect.objectContaining({ eventCode: expect.any(String) }),
        );
        warn.mockRestore();
      });

      it('the floor also applies to a per-run override', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        oneShell();
        await prunePamEvidence({ retentionDays: 5 });
        expect(ttlParamSeen(30)).toBe(true);
        expect(ttlParamSeen(5)).toBe(false);
        warn.mockRestore();
      });
    });

    describe('dedicated audit-admin pool path', () => {
      it('arms system scope + retention GUC before the first DELETE and never SET LOCAL ROLE', async () => {
        hasDedicatedPoolMock.mockReturnValue(true);
        dbExecuteMock.mockImplementation(async (q: unknown) => {
          if (/FROM org_evidence_holds/.test(sqlText(q))) return [{ loser_org_id: SHELL_A }];
          return [];
        });
        const txSql: string[] = [];
        let served = false;
        const tx = {
          execute: async (q: unknown) => {
            const t = sqlText(q);
            txSql.push(t);
            if (/EXISTS \(SELECT 1 FROM org_evidence_holds/.test(t)) return [{ held: true }];
            if (/FROM elevation_requests r/.test(t)) {
              if (served) return [];
              served = true;
              return [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }];
            }
            if (/^\s*DELETE FROM/.test(t)) return { count: 1 };
            return [];
          },
        };
        getAuditAdminDbMock.mockReturnValue({ transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) });

        const stats = await prunePamEvidence();

        expect(stats).toMatchObject({ shellsPruned: 1, chainsDeleted: 1, errors: 0 });
        const scopeIdx = txSql.findIndex((t) => /set_config\(\s*'breeze\.scope',\s*'system',\s*true\s*\)/.test(t));
        const gucIdx = txSql.findIndex((t) => /SET LOCAL breeze\.allow_audit_retention = '1'/.test(t));
        const firstDelete = txSql.findIndex((t) => /^\s*DELETE FROM/.test(t));
        expect(scopeIdx).toBeGreaterThan(-1);
        expect(gucIdx).toBeGreaterThan(-1);
        expect(firstDelete).toBeGreaterThan(-1);
        expect(scopeIdx).toBeLessThan(firstDelete);
        expect(gucIdx).toBeLessThan(firstDelete);
        expect(txSql.some((t) => /SET LOCAL ROLE/.test(t))).toBe(false);
        // Nothing destructive went through the app-pool mock.
        expect(executed().some((t) => /SET LOCAL ROLE|DELETE FROM/.test(t))).toBe(false);
      });
    });
  });
});
