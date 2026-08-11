import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { WorkspaceDatabase } from '../hostTypes';
import { createDeviceSummaryService } from './deviceSummaryService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

const dialect = new PgDialect();

/** Render a recorded Drizzle where-clause to real SQL text plus bound params. */
function rendered(where: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(where as never);
  return { sql: query.sql, params: query.params };
}

/**
 * Every `"<column>" = $N` in the rendered SQL, resolved to the value actually
 * bound at position N — i.e. what this column is compared against.
 *
 * Asserting `params).toContain(ORG_ID)` only binds the PRESENCE of a value, not
 * which column carries it: transposing the arguments of the device lookup to
 * `and(eq(devices.orgId, deviceId), eq(devices.id, orgId))` leaves both values
 * present and such a test green. Pairing column to value is what catches it.
 */
function boundTo(query: { sql: string; params: unknown[] }, column: string): unknown[] {
  // The leading quote anchors the column name, so "org_id" cannot match a probe
  // for "id", nor "crawl_device_id" a probe for "device_id".
  const occurrences = query.sql.matchAll(new RegExp(`"${column}"\\s*=\\s*\\$(\\d+)`, 'g'));
  return [...occurrences].map((match) => query.params[Number(match[1]) - 1]);
}

/**
 * Fake handle that records the projection and where-clause of every query and
 * replays canned rows in call order. It is deliberately NOT permissive: it
 * records exactly what the service asked the database for, so a test can fail
 * when a tenancy predicate or a projection narrowing is removed.
 */
function makeDb(resultsByCall: unknown[][]) {
  const selects: unknown[] = [];
  const wheres: unknown[] = [];
  let call = 0;
  const db = {
    select: vi.fn((projection?: unknown) => {
      const index = call;
      call += 1;
      selects.push(projection);
      return {
        from: vi.fn(() => ({
          where: vi.fn((clause: unknown) => {
            wheres.push(clause);
            const rows = resultsByCall[index] ?? [];
            const result = Promise.resolve(rows) as Promise<unknown[]> & {
              limit: (n: number) => Promise<unknown[]>;
            };
            result.limit = async () => rows;
            return result;
          }),
        })),
      };
    }),
  };
  return { db: db as unknown as WorkspaceDatabase, selects, wheres };
}

const deviceFound = [{ id: DEVICE_ID }];

function harness(overrides: {
  device?: unknown[];
  files?: unknown[];
  runs?: unknown[];
} = {}) {
  const h = makeDb([
    overrides.device ?? deviceFound,
    overrides.files ?? [{ indexedFiles: 7, visibleSources: 2 }],
    overrides.runs ?? [{
      lastSuccessfulCrawlAt: new Date('2026-07-12T10:00:00.000Z'),
      lastActivityAt: new Date('2026-07-12T11:00:00.000Z'),
    }],
  ]);
  return { ...h, service: createDeviceSummaryService(h.db) };
}

describe('deviceSummaryService', () => {
  it('aggregates indexed files, live sources and crawl timestamps for one device', async () => {
    const { service } = harness();
    await expect(service.summarize(ORG_ID, DEVICE_ID)).resolves.toEqual({
      deviceId: DEVICE_ID,
      indexedFiles: 7,
      visibleSources: 2,
      lastSuccessfulCrawlAt: new Date('2026-07-12T10:00:00.000Z'),
      lastActivityAt: new Date('2026-07-12T11:00:00.000Z'),
    });
  });

  it('returns zeros and null timestamps when the device has no workspace rows', async () => {
    const { service } = harness({
      files: [{ indexedFiles: 0, visibleSources: 0 }],
      runs: [{ lastSuccessfulCrawlAt: null, lastActivityAt: null }],
    });
    await expect(service.summarize(ORG_ID, DEVICE_ID)).resolves.toEqual({
      deviceId: DEVICE_ID,
      indexedFiles: 0,
      visibleSources: 0,
      lastSuccessfulCrawlAt: null,
      lastActivityAt: null,
    });
  });

  it('tolerates an empty aggregate row rather than reporting NaN or undefined', async () => {
    const { service } = harness({ files: [], runs: [] });
    await expect(service.summarize(ORG_ID, DEVICE_ID)).resolves.toEqual({
      deviceId: DEVICE_ID,
      indexedFiles: 0,
      visibleSources: 0,
      lastSuccessfulCrawlAt: null,
      lastActivityAt: null,
    });
  });

  it('returns null for a device that is not in the requested org, without aggregating', async () => {
    const { service, db } = harness({ device: [] });
    await expect(service.summarize(OTHER_ORG_ID, DEVICE_ID)).resolves.toBeNull();
    // The aggregate queries must never run for a device the caller cannot see.
    expect((db.select as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  // Tenancy: RLS is the backstop, not the only control. Every query must carry
  // an explicit org + device predicate, and each value must be bound to the
  // column it belongs to. Deleting either eq(), or transposing its arguments,
  // fails these.
  it('scopes the device existence lookup by both org and device', async () => {
    const { service, wheres } = harness();
    await service.summarize(ORG_ID, DEVICE_ID);
    const query = rendered(wheres[0]);
    expect(boundTo(query, 'org_id')).toEqual([ORG_ID]);
    expect(boundTo(query, 'id')).toEqual([DEVICE_ID]);
  });

  it('scopes the file-index aggregate by org and device and excludes tombstones', async () => {
    const { service, wheres } = harness();
    await service.summarize(ORG_ID, DEVICE_ID);
    const query = rendered(wheres[1]);
    // Twice: the aggregate's own org predicate, plus the owned-sources subquery.
    expect(boundTo(query, 'org_id')).toEqual([ORG_ID, ORG_ID]);
    expect(boundTo(query, 'device_id')).toEqual([DEVICE_ID]);
    // Tombstones (soft-deleted rows) must not be counted as indexed files.
    expect(query.sql).toMatch(/"deleted_at" is null/);
  });

  it('scopes the crawl-run aggregate by org and device', async () => {
    const { service, wheres } = harness();
    await service.summarize(ORG_ID, DEVICE_ID);
    const query = rendered(wheres[2]);
    expect(boundTo(query, 'org_id')).toEqual([ORG_ID, ORG_ID]);
    expect(boundTo(query, 'device_id')).toEqual([DEVICE_ID]);
  });

  // Scope (see the header comment on the service): these aggregates report what
  // a device is RESPONSIBLE for indexing, which is the union of its own
  // device-scoped rows and the source-scoped (SMB) rows of the sources it
  // crawls. A device whose only job is crawling an SMB share must not read as
  // idle.
  it.each([
    ['file-index', 1],
    ['crawl-run', 2],
  ])('unions device-scoped rows with rows of sources the device crawls (%s)', async (_label, index) => {
    const { service, wheres } = harness();
    await service.summarize(ORG_ID, DEVICE_ID);
    const query = rendered(wheres[index]);
    expect(query.sql).toContain('"device_id" = $');
    expect(query.sql).toMatch(/=\s+\$\d+ or .*"source_id" in \(select/);
    expect(query.sql).toContain('from "workspace_sources"');
  });

  // THE cross-device control. The owned-sources subquery must be anchored on
  // crawl_device_id = <device> (and org_id = <org>). Widening it to every
  // source in the org would pull in SMB rows owned by OTHER devices — a
  // cross-device leak that no other assertion here would notice.
  it.each([
    ['file-index', 1],
    ['crawl-run', 2],
  ])('anchors the owned-sources subquery on crawl_device_id and org_id (%s)', async (_label, index) => {
    const { service, wheres } = harness();
    await service.summarize(ORG_ID, DEVICE_ID);
    const query = rendered(wheres[index]);
    expect(query.sql).toContain('"workspace_sources"."crawl_device_id"');
    expect(boundTo(query, 'crawl_device_id')).toEqual([DEVICE_ID]);
    expect(query.sql).toContain('"workspace_sources"."org_id"');
  });

  // The owned-sources branch must additionally require device_id IS NULL, i.e.
  // match only SOURCE-scoped rows. crawl_device_id is only meaningful for
  // smb_share, but nothing forbids a local_profile source from carrying one
  // (routes/sources.ts validateSmbConfig returns early for local_profile).
  // Without this, such a source would attribute every OTHER device's
  // device-scoped rows on it to this device.
  it.each([
    ['file-index', 1],
    ['crawl-run', 2],
  ])('restricts the owned-sources branch to source-scoped rows (%s)', async (_label, index) => {
    const { service, wheres } = harness();
    await service.summarize(ORG_ID, DEVICE_ID);
    const query = rendered(wheres[index]);
    expect(query.sql).toMatch(/"device_id" is null and "[a-z_]+"\."source_id" in \(select/);
  });

  // THE conjunction control. `boundTo` only proves the org value is bound to
  // the org_id column somewhere in the SQL; it does not prove that predicate
  // is AND-ed against the rest of the where-clause rather than OR-ed into it.
  // Mutating `and(eq(orgId), responsibleFor(...))` to
  // `and(or(eq(orgId), responsibleFor(...)))` keeps every `boundTo` assertion
  // above green (the value is still bound to org_id) while silently turning
  // the explicit org predicate into a no-op: any row `responsibleFor` matches
  // is returned regardless of org. That is the defence-in-depth layer
  // vanishing, leaving RLS as the only control — exactly the case this
  // predicate exists to cover if RLS is ever misconfigured. Asserting the
  // literal `"org_id" = $N and` substring (not just presence of `and`
  // anywhere in the SQL) catches that the org predicate is conjoined at the
  // top level, not buried inside an `or(...)`.
  //
  // wheres[0] — the `devices` existence lookup — is the most security-relevant
  // of the three: it is the AUTHORIZATION GATE. Rewriting its
  // `and(eq(devices.orgId), eq(devices.id))` to `or(...)` makes a foreign-org
  // deviceId resolve, so summarize() returns 200 with zeroed aggregates instead
  // of null -> 404, recreating exactly the existence oracle that
  // routes/deviceSummary.ts exists to prevent. Every `boundTo` assertion above
  // stays green under that mutation, because both values are still bound to
  // their own columns; only the conjunction assertion catches it.
  it.each([
    ['device-lookup', 'devices', 0],
    ['file-index', 'workspace_file_index', 1],
    ['crawl-run', 'workspace_crawl_runs', 2],
  ])('conjoins the org predicate with the rest of the where-clause (%s)', async (_label, table, index) => {
    const { service, wheres } = harness();
    await service.summarize(ORG_ID, DEVICE_ID);
    const query = rendered(wheres[index]);
    // Table-qualified: the ownedSources subquery also carries its own
    // "workspace_sources"."org_id" = $N and ..., which is unaffected by the
    // mutation this test targets. Anchoring on the outer table's own org_id
    // is what distinguishes the top-level predicate from that subquery one.
    expect(query.sql).toMatch(new RegExp(`"${table}"\\."org_id" = \\$\\d+ and`));
  });

  it('counts visible sources as DISTINCT live source ids on the device', async () => {
    const { service, selects } = harness();
    await service.summarize(ORG_ID, DEVICE_ID);
    const projection = rendered((selects[1] as Record<string, unknown>).visibleSources);
    expect(projection.sql.toLowerCase()).toContain('count(distinct');
    expect(projection.sql).toContain('"source_id"');
  });

  it('restricts lastSuccessfulCrawlAt to completed runs only', async () => {
    const { service, selects } = harness();
    await service.summarize(ORG_ID, DEVICE_ID);
    const runProjection = selects[2] as Record<string, unknown>;
    const success = rendered(runProjection.lastSuccessfulCrawlAt);
    expect(success.sql.toLowerCase()).toContain('filter (where');
    expect(success.sql).toContain('"completed_at"');
    expect(success.params).toContain('complete');
    // lastActivityAt is deliberately unfiltered by status.
    const activity = rendered(runProjection.lastActivityAt);
    expect(activity.sql).toContain('"last_activity_at"');
    expect(activity.sql.toLowerCase()).not.toContain('filter (where');
  });

  // Disclosure boundary: the service must never fetch file paths, names,
  // credentials or crawl error reasons. A route cannot leak what it never
  // receives, so the narrowing lives in the projection itself.
  it('never projects paths, names, credentials or error detail', async () => {
    const { service, selects } = harness();
    await service.summarize(ORG_ID, DEVICE_ID);
    const forbidden = [
      'rel_path', 'parent_path', 'name', 'credential_enc',
      'error_reason', 'status_detail', 'root_path', 'cursor',
    ];
    for (const projection of selects.slice(1)) {
      const keys = Object.keys(projection as Record<string, unknown>);
      const text = keys
        .map((key) => rendered((projection as Record<string, unknown>)[key]).sql)
        .join(' ');
      for (const column of forbidden) {
        expect(text).not.toContain(`"${column}"`);
      }
    }
  });

  // RLS context: the org-scoped connection the host handed to register() is
  // the connection that enforces RLS. The service must issue every query
  // through that injected handle and never open one of its own.
  it('issues every query through the injected org-scoped handle', async () => {
    const { service, db } = harness();
    await service.summarize(ORG_ID, DEVICE_ID);
    expect((db.select as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3);
  });
});
