import './setup';
import postgres, { type Sql } from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAppDb } from './setup';
import { recordRunningVersion, runUpgradePreflight } from '../../upgrade/upgradePreflightRunner';
import { readRequestDeploymentState } from '../../upgrade/deprecationsReport';
import { closeDb, db, withDbAccessContext } from '../../db';

/**
 * #6605 against real Postgres: the version-history table the migration creates,
 * the boot-time recorder, the preflight's reads of it and of the migration
 * ledger, and the request role's SELECT-only access (the migration REVOKE plus
 * ensureAppRole's per-boot re-revoke, which globalSetup's autoMigrate ran).
 */

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

const quiet = () => ({ log: vi.fn(), warn: vi.fn() });

let owner: Sql;

beforeAll(() => {
  owner = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await owner.unsafe('DELETE FROM breeze_version_history');
  await owner.end({ timeout: 5 });
  await closeDb();
});

beforeEach(async () => {
  await owner.unsafe('DELETE FROM breeze_version_history');
});

describe('breeze_version_history', () => {
  it('records the first sighting of a version once, across repeated boots', async () => {
    await recordRunningVersion({ databaseUrl: DATABASE_URL, currentVersion: 'v0.116.0', logger: quiet() });
    const [first] = await owner`SELECT version, first_seen_at FROM breeze_version_history`;
    expect(first?.version).toBe('0.116.0');

    const logger = quiet();
    await recordRunningVersion({ databaseUrl: DATABASE_URL, currentVersion: '0.116.0', logger });
    const rows = await owner`SELECT version, first_seen_at FROM breeze_version_history`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.first_seen_at).toEqual(first?.first_seen_at);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('does not record a non-release version', async () => {
    await recordRunningVersion({ databaseUrl: DATABASE_URL, currentVersion: 'release-build-check', logger: quiet() });
    await recordRunningVersion({ databaseUrl: DATABASE_URL, currentVersion: '0.2.0', logger: quiet() });
    expect(await owner`SELECT 1 FROM breeze_version_history`).toHaveLength(0);
  });

  it('is readable but not writable by the request role', async () => {
    await owner`INSERT INTO breeze_version_history (version) VALUES ('0.115.0')`;
    const app = getAppDb();
    const read = await app.execute(dsql`SELECT version FROM breeze_version_history`);
    expect(Array.from(read as unknown as Array<{ version: string }>).map((r) => r.version)).toEqual(['0.115.0']);

    for (const statement of [
      dsql`INSERT INTO breeze_version_history (version) VALUES ('9.9.9')`,
      dsql`UPDATE breeze_version_history SET version = '9.9.9'`,
      dsql`DELETE FROM breeze_version_history`,
    ]) {
      const err = await app.execute(statement).then(() => null, (e: unknown) => e as { cause?: { code?: string }; code?: string });
      expect(err?.cause?.code ?? err?.code).toBe('42501');
    }
  });
});

describe('runUpgradePreflight', () => {
  it('reports a definite removal crossing from the recorded history, with no pending migrations', async () => {
    await owner`INSERT INTO breeze_version_history (version) VALUES ('0.114.0'), ('0.115.0')`;
    const logger = quiet();
    const { report, exitCode } = await runUpgradePreflight({
      databaseUrl: DATABASE_URL,
      currentVersion: '0.116.0',
      logger,
      strict: true,
    });
    expect(report.lastRecordedVersion).toBe('0.115.0');
    expect(report.ledger).toMatchObject({ status: 'ok', pendingCount: 0 });
    expect(report.crossing.map((c) => [c.entry.id, c.milestone, c.certainty])).toContainEqual([
      'ticket-labour-pricing-fields',
      'removal',
      'definite',
    ]);
    expect(exitCode).toBe(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain('defaultHourlyRate');
  });

  it('reports broadly when the deployment has no recorded history', async () => {
    const { report } = await runUpgradePreflight({ databaseUrl: DATABASE_URL, currentVersion: '0.116.0', logger: quiet() });
    expect(report.historyKnown).toBe(false);
    expect(report.crossing.map((c) => c.certainty)).toContain('possible');
  });

  it('turns an unreachable database into a broad report instead of throwing', async () => {
    const { report, exitCode } = await runUpgradePreflight({
      databaseUrl: 'postgresql://nobody:nothing@127.0.0.1:1/none',
      currentVersion: '0.116.0',
      logger: quiet(),
      timeoutMs: 5_000,
    });
    expect(report.historyKnown).toBe(false);
    expect(report.ledger.status).toBe('missing');
    expect(exitCode).toBe(0);
  });
});

describe('readRequestDeploymentState (Settings → System → Deprecations, #6605 wave 2)', () => {
  it('reads history and the ledger on the request role inside a request transaction, without writing', async () => {
    await owner`INSERT INTO breeze_version_history (version) VALUES ('0.115.0'), ('0.116.0')`;
    const orgId = '00000000-0000-4000-8000-000000006605';
    const context = { scope: 'organization' as const, orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
    const state = await withDbAccessContext(context, async () => {
      const read = await readRequestDeploymentState('0.116.0');
      // The request transaction is still usable after the savepointed reads.
      const [row] = (await db.execute(dsql`SELECT 1 AS ok`)) as unknown as Array<{ ok: number }>;
      expect(row?.ok).toBe(1);
      return read;
    });
    expect(state.history.status).toBe('ok');
    expect(state.history.status === 'ok' && state.history.versions.map((v) => v.version).sort()).toEqual([
      '0.115.0',
      '0.116.0',
    ]);
    expect(state.ledger).toMatchObject({ status: 'ok', pendingCount: 0 });
    const rows = await owner`SELECT version FROM breeze_version_history ORDER BY version`;
    expect(rows.map((r) => r.version)).toEqual(['0.115.0', '0.116.0']);
  });

  it('degrades a failed history read to "missing" without poisoning the request transaction', async () => {
    await owner`INSERT INTO breeze_version_history (version) VALUES ('0.116.0')`;
    await owner.unsafe('REVOKE SELECT ON breeze_version_history FROM breeze_app');
    try {
      const orgId = '00000000-0000-4000-8000-000000006606';
      const context = { scope: 'organization' as const, orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
      const state = await withDbAccessContext(context, async () => {
        const read = await readRequestDeploymentState('0.116.0');
        const [row] = (await db.execute(dsql`SELECT 1 AS ok`)) as unknown as Array<{ ok: number }>;
        expect(row?.ok).toBe(1);
        return read;
      });
      expect(state.history.status).toBe('missing');
      expect(state.history.status === 'missing' && state.history.reason).toMatch(/permission denied/);
      // The other half is read independently and still succeeds.
      expect(state.ledger).toMatchObject({ status: 'ok', pendingCount: 0 });
    } finally {
      await owner.unsafe('GRANT SELECT ON breeze_version_history TO breeze_app');
    }
  });
});
