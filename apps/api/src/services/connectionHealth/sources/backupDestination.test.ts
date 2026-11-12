import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// The mapper is pure; the queries run against a real DB in
// __tests__/integration/connectionHealthSources.integration.test.ts.
vi.mock('../../../db', () => ({ db: {} }));

import { DESTINATION_LOOKBACK_MS, type DestinationJobOutcome } from '../../backupDestinationHealth';
import { HEALTH_DETAIL_MAX, sanitizeHealthDetail } from '../sanitize';
import {
  backupDestinationObservation,
  backupDestinationSource,
  destinationConfigsQuery,
  destinationJobsQuery,
  type BackupDestinationRow,
} from './backupDestination';

const NOW = new Date('2026-11-11T12:00:00Z');
const OLD = new Date('2026-09-01T00:00:00Z');
const ID = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const O = '33333333-3333-4333-8333-333333333333';
const IDENTITY = 's3::s3.example.test::acme-backups';
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

// Raw store text carries the bucket, an endpoint and a key id; none may reach the notice.
const DENIED = 'failed to upload file to https://s3.example.test/acme-backups/x: storage session: storage answered status 403 (InvalidAccessKeyId) key AKIAEXAMPLEKEY';
const STORE_5XX = 'storage session: storage answered status 503';
const NOT_FOUND = 'storage session: storage answered status 404 (NoSuchBucket) acme-backups';

let seq = 0;
const job = (deviceId: string, h: number, status: string, errorLog: string | null = null): DestinationJobOutcome => {
  seq += 1;
  return { deviceId, status, errorLog, createdAt: new Date(hoursAgo(h).getTime() - seq), completedAt: hoursAgo(h), storageIdentity: IDENTITY };
};

const row = (jobs: DestinationJobOutcome[], over: Partial<BackupDestinationRow> = {}): BackupDestinationRow => ({
  id: ID, orgId: O, partnerId: P, name: 'Main S3', isActive: true, createdAt: OLD,
  currentStorageIdentity: IDENTITY, jobs, ...over,
});

describe('backup destination source (#11772)', () => {
  it('registers as an org-scoped 15-minute kind over configs and jobs, fixed where destinations are edited', () => {
    expect(backupDestinationSource).toMatchObject({
      kind: 'backup_destination',
      intervalMinutes: 15,
      tables: ['backup_configs', 'backup_jobs'],
      fixHrefs: ['/backup#profiles'],
    });
  });

  it('two devices refused is a permanent org incident with a generated, actionable detail', () => {
    const obs = backupDestinationObservation(row([
      job('a', 7, 'failed', DENIED), job('b', 6, 'failed', DENIED), job('c', 5, 'failed', DENIED), job('d', 1, 'completed'),
    ]), NOW);
    expect(obs).toEqual({
      sourceKind: 'backup_destination',
      sourceId: ID,
      partnerId: P,
      orgId: O,
      ownerUserId: null,
      state: 'broken',
      severity: 'permanent',
      condition: 'destination_access_denied',
      detail: '3 of 4 devices failing since 2026-11-11 05:00 UTC. The destination refused the request: check the access key, the bucket policy and the storage account\'s standing, then run Test connection.',
      displayName: 'Backup destination Main S3',
      fixHref: '/backup#profiles',
      ownerFixHref: null,
      viewPermission: { resource: 'backup', action: 'read' },
      repairPermission: { resource: 'backup', action: 'write' },
      observedAt: NOW,
    });
  });

  it('the detail never carries raw error text, hosts, buckets or keys, and survives sanitize unchanged', () => {
    for (const log of [DENIED, STORE_5XX, NOT_FOUND]) {
      const { detail } = backupDestinationObservation(row([job('a', 2, 'failed', log), job('b', 1, 'failed', log)]), NOW);
      expect(detail).not.toBeNull();
      expect(detail!.length).toBeLessThanOrEqual(HEALTH_DETAIL_MAX);
      expect(sanitizeHealthDetail(detail)).toBe(detail);
      for (const leak of ['acme-backups', 's3.example.test', 'AKIA', 'http', 'InvalidAccessKeyId', 'NoSuchBucket', '503']) {
        expect(detail, leak).not.toContain(leak);
      }
    }
  });

  it('maps causes to conditions: not found is permanent, other destination faults transient', () => {
    expect(backupDestinationObservation(row([job('a', 2, 'failed', NOT_FOUND), job('b', 1, 'failed', NOT_FOUND)]), NOW))
      .toMatchObject({ state: 'broken', severity: 'permanent', condition: 'destination_not_found' });
    const failing = backupDestinationObservation(row([job('a', 2, 'failed', STORE_5XX), job('b', 1, 'failed', STORE_5XX)]), NOW);
    expect(failing).toMatchObject({ state: 'broken', severity: 'transient', condition: 'destination_failing' });
    expect(failing.detail).toMatch(/^2 of 2 devices failing since 2026-11-11 10:00 UTC\. /);
  });

  it('a single device reads "1 of 1 device"', () => {
    expect(backupDestinationObservation(row([job('a', 1, 'failed', DENIED)]), NOW).detail).toMatch(/^1 of 1 device failing since /);
  });

  it('disabled is retired; recovered is healthy; missing evidence is unknown', () => {
    expect(backupDestinationObservation(row([job('a', 1, 'failed', DENIED)], { isActive: false }), NOW).state).toBe('retired');
    expect(backupDestinationObservation(row([job('a', 9, 'failed', DENIED), job('a', 1, 'completed')]), NOW).state).toBe('healthy');
    expect(backupDestinationObservation(row([]), NOW)).toMatchObject({ state: 'unknown', detail: null, condition: 'unknown' });
  });

  it('a new destination failing transiently is in onboarding grace; a refusal is not delayed', () => {
    const young = { createdAt: new Date(NOW.getTime() - 30 * 60_000) };
    expect(backupDestinationObservation(row([job('a', 0.4, 'failed', STORE_5XX), job('b', 0.3, 'failed', STORE_5XX)], young), NOW).state).toBe('unknown');
    expect(backupDestinationObservation(row([job('a', 0.4, 'failed', DENIED), job('b', 0.3, 'failed', DENIED)], young), NOW).state).toBe('broken');
  });

  it('the broken query reads the unsuccessful jobs of active configs, with literal predicates for the partial index', () => {
    const q = new PgDialect().sqlToQuery(backupDestinationSource.brokenQuery(NOW) as SQL);
    expect(q.sql).toContain(`j.status IN ('failed', 'partial', 'completed_with_errors')`);
    expect(q.sql).toMatch(/j\.completed_at >= \$\d+::timestamptz/);
    expect(q.sql).toContain('c.is_active');
    // The classifier needs the text; the cause is decided in TypeScript.
    expect(q.sql).toContain('j.error_log');
    expect(q.params).toContain(new Date(NOW.getTime() - DESTINATION_LOOKBACK_MS).toISOString());
  });

  it('observe loads full evidence only for configs with a destination fault (or tracked ones)', async () => {
    const OFFLINE_ONLY = '44444444-4444-4444-8444-444444444444';
    const executed: string[] = [];
    const dialect = new PgDialect();
    const { db } = await import('../../../db');
    (db as unknown as { execute: (q: SQL) => Promise<unknown[]> }).execute = async (q: SQL) => {
      const text = dialect.sqlToQuery(q).sql;
      executed.push(text);
      if (text.includes('JOIN backup_configs c ON c.id = j.config_id')) {
        return [
          { config_id: ID, status: 'failed', error_log: DENIED },
          { config_id: OFFLINE_ONLY, status: 'failed', error_log: '[stale-backup-reaper] Device went offline during backup' },
        ];
      }
      if (text.includes('FROM backup_configs c')) {
        return [{ id: ID, org_id: O, partner_id: P, name: 'Main S3', is_active: true, created_at: OLD, provider: 's3',
          identity_fields: { endpoint: 'https://s3.example.test', bucket: 'acme-backups' } }];
      }
      return [
        { config_id: ID, device_id: 'a', status: 'failed', error_log: DENIED, created_at: hoursAgo(2.1), completed_at: hoursAgo(2), storage_identity: IDENTITY },
        { config_id: ID, device_id: 'b', status: 'failed', error_log: DENIED, created_at: hoursAgo(1.1), completed_at: hoursAgo(1), storage_identity: IDENTITY },
      ];
    };
    const obs = await backupDestinationSource.observe(NOW, []);
    expect(obs.map((o) => [o.sourceId, o.state])).toEqual([[ID, 'broken']]);
    const configLookup = executed.find((t) => t.includes('FROM backup_configs c') && !t.includes('FROM backup_jobs j'));
    expect(configLookup).toBeDefined();
    // Only the destination-fault config is loaded: one id in the lookup.
    expect(configLookup!.match(/::uuid/g)).toHaveLength(1);
  });

  it('the evidence query reads terminal outcomes, successes included, for the given configs inside the lookback', () => {
    const q = new PgDialect().sqlToQuery(destinationJobsQuery([ID], NOW));
    expect(q.sql).toContain('j.config_id IN (');
    expect(q.sql).toMatch(/j\.completed_at >= \$\d+::timestamptz/);
    expect(q.sql).toContain(`'completed'`);
    expect(q.params).toContain(ID);
  });

  it('the config query attributes the partner through the org and never reads credentials', () => {
    const q = new PgDialect().sqlToQuery(destinationConfigsQuery([ID]));
    expect(q.sql).toContain('JOIN organizations o ON o.id = c.org_id');
    expect(q.sql).toContain('o.partner_id');
    expect(q.sql).not.toMatch(/c\.provider_config(?!\s*->)/);
  });
});
