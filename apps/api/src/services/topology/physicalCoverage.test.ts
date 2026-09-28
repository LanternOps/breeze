import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { graphResponseSchema } from '@breeze/shared';
import { readGraphCoverage, summarizePhysicalCoverage, type PhysicalCoverageInput, type CoverageSourceRow } from './physicalCoverage';

const NOW = new Date('2026-09-26T12:00:00.000Z');
const DEVICE = '60000000-0000-4000-8000-000000000001';
const COLLECTOR = '70000000-0000-4000-8000-000000000001';
const ORG = '10000000-0000-4000-8000-000000000001';
const SITE = '20000000-0000-4000-8000-000000000001';
const empty: PhysicalCoverageInput = { physicalExposed: true, dispatches: [], sources: [], mappings: [], controllerNotes: [], unresolvedCount: 0, now: NOW };
const source = (over: Partial<CoverageSourceRow>): CoverageSourceRow => ({ producerKind: 'discovery', producerId: DEVICE, protocol: 'lldp', contextKey: 'snmp:192.0.2.10/default',
  lastOutcome: 'complete', reasonCode: null, rowCount: 3, freshUntil: '2026-09-26T13:00:00.000Z', lastReceivedAt: '2026-09-26T11:59:00.000Z', ...over });
const codes = (input: Partial<PhysicalCoverageInput>) => summarizePhysicalCoverage({ ...empty, ...input }).reasons.map((r) => r.code);
const valid = (coverage: ReturnType<typeof summarizePhysicalCoverage>) => graphResponseSchema.shape.coverage.safeParse(coverage).success;

describe('summarizePhysicalCoverage (D11)', () => {
  it('reports no collector (unknown) when no expected scope exists at all', () => {
    const coverage = summarizePhysicalCoverage(empty);
    expect(coverage).toMatchObject({ state: 'unknown', reasons: [{ code: 'no_collector' }] });
    expect(valid(coverage)).toBe(true);
  });

  it('reports physical_disabled instead of collection state when exposure is off', () => {
    expect(summarizePhysicalCoverage({ ...empty, physicalExposed: false, sources: [source({})] })).toMatchObject({ state: 'unknown', reasons: [{ code: 'physical_disabled' }] });
  });

  it('is complete only when every expected scope completed with positive rows', () => {
    expect(summarizePhysicalCoverage({ ...empty, sources: [source({}), source({ protocol: 'fdb' })] })).toEqual({ state: 'complete', reasons: [] });
  });

  it('never treats a complete-empty scope as whole-site completeness', () => {
    const coverage = summarizePhysicalCoverage({ ...empty, sources: [source({ rowCount: 0 })] });
    expect(coverage.state).toBe('limited');
    expect(coverage.reasons.map((r) => r.code)).toEqual(['collection_complete_empty']);
  });

  it('keeps each failure mode a distinct reason with a scope count', () => {
    const coverage = summarizePhysicalCoverage({ ...empty, sources: [
      source({ lastOutcome: 'unsupported', reasonCode: 'not_supported', rowCount: 0 }),
      source({ lastOutcome: 'failed', reasonCode: 'timeout', rowCount: 0 }),
      source({ lastOutcome: 'failed', reasonCode: 'timeout', rowCount: 0, contextKey: 'snmp:192.0.2.11/default' }),
      source({ lastOutcome: 'failed', reasonCode: 'walk_error', rowCount: 0 }),
      source({ lastOutcome: 'partial', reasonCode: 'limit_exceeded' }),
      source({ lastOutcome: 'partial', reasonCode: 'column_failed' }),
      source({ lastOutcome: 'failed', reasonCode: 'no_usable_credentials', rowCount: 0 }),
      source({ lastOutcome: 'failed', reasonCode: 'authentication', rowCount: 0 }),
      source({ lastOutcome: 'not_attempted', rowCount: 0 }),
    ] });
    expect(coverage.state).toBe('limited');
    expect(Object.fromEntries(coverage.reasons.map((r) => [r.code, r.count]))).toEqual({
      collection_unsupported: 1, collection_timeout: 2, collection_failed: 1, collection_partial_limit: 1, collection_partial: 1,
      credentials_missing: 1, credentials_rejected: 1, collection_not_attempted: 1,
    });
    expect(new Set(coverage.reasons.map((r) => r.message)).size).toBe(coverage.reasons.length);
    expect(valid(coverage)).toBe(true);
  });

  it('reports stale positive evidence separately from failures', () => {
    expect(codes({ sources: [source({ freshUntil: '2026-09-26T11:00:00.000Z' })] })).toEqual(['collection_stale']);
  });

  it('counts an expected discovery scope with no source row: pending before the deadline, not received after', () => {
    const dispatch = { jobId: '80000000-0000-4000-8000-000000000001', deviceId: DEVICE, dispatchedAt: '2026-09-26T11:50:00.000Z', deadline: '2026-09-26T12:05:00.000Z' };
    expect(codes({ dispatches: [dispatch] })).toEqual(['collection_pending']);
    expect(codes({ dispatches: [{ ...dispatch, deadline: '2026-09-26T11:55:00.000Z' }] })).toEqual(['collection_not_received']);
    // A report received for this dispatch satisfies it; an older report does not.
    expect(codes({ dispatches: [{ ...dispatch, deadline: '2026-09-26T11:55:00.000Z' }], sources: [source({ lastReceivedAt: '2026-09-26T11:51:00.000Z' })] })).toEqual([]);
    expect(codes({ dispatches: [{ ...dispatch, deadline: '2026-09-26T11:55:00.000Z' }], sources: [source({ lastReceivedAt: '2026-09-26T11:00:00.000Z' })] })).toEqual(['collection_not_received']);
  });

  it('counts mapped controller sites: no collector, not received, or covered by a unifi source', () => {
    const mapping = { controllerSiteId: 'default', collectorIds: [COLLECTOR] };
    expect(codes({ mappings: [{ controllerSiteId: 'default', collectorIds: [] }] })).toEqual(['no_collector']);
    expect(codes({ mappings: [mapping] })).toEqual(['collection_not_received']);
    expect(codes({ mappings: [mapping], sources: [source({ producerKind: 'unifi', protocol: 'unifi_device_list', contextKey: `${COLLECTOR}:default` })] })).toEqual([]);
  });

  it('reports unmapped and other-org controller sites and unresolved interfaces distinctly', () => {
    expect(codes({ sources: [source({})], controllerNotes: [{ reason: 'controller_site_unmapped' }, { reason: 'controller_site_key_invalid' }, { reason: 'controller_site_other_org' }], unresolvedCount: 3 }))
      .toEqual(['interface_unresolved', 'controller_site_unmapped', 'controller_site_other_org']);
    const coverage = summarizePhysicalCoverage({ ...empty, sources: [source({})], unresolvedCount: 3 });
    expect(coverage.reasons[0]).toMatchObject({ code: 'interface_unresolved', count: 3 });
  });
});

describe('readGraphCoverage', () => {
  const dialect = new PgDialect();
  it('keeps the logical view on its legacy explanation without reading collection state', async () => {
    const execute = vi.fn();
    const coverage = await readGraphCoverage({ execute }, { orgId: ORG, siteId: SITE }, 'logical', true);
    expect(coverage.reasons.map((r) => r.code)).toEqual(['legacy_evidence_only']);
    expect(execute).not.toHaveBeenCalled();
  });
  it('keeps the overview legacy explanation when physical exposure is off', async () => {
    const execute = vi.fn();
    expect((await readGraphCoverage({ execute }, { orgId: ORG, siteId: SITE }, 'overview', false)).reasons.map((r) => r.code)).toEqual(['legacy_evidence_only']);
    expect(execute).not.toHaveBeenCalled();
  });
  it('reads only scoped SELECTs (no writes, no commands) for the physical view', async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const coverage = await readGraphCoverage({ execute }, { orgId: ORG, siteId: SITE }, 'physical', true);
    expect(coverage.reasons.map((r) => r.code)).toEqual(['no_collector']);
    expect(execute).toHaveBeenCalled();
    for (const call of execute.mock.calls) {
      const query = dialect.sqlToQuery(call[0]);
      expect(query.sql).not.toMatch(/\b(insert|update|delete)\b/i);
      expect(query.sql).not.toMatch(/device_commands/i);
      expect(query.params).toContain(ORG);
    }
  });
});
