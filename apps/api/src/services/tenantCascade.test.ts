import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB so we can drive cascade behavior deterministically. The
// integration test exercises the real Postgres flow.
const mockState = vi.hoisted(() => ({
  /** queued execute() responses (FIFO). Each can be either an array
   *  (matches `result.length`) or `{ rowCount }` for delete results. */
  executeResponses: [] as Array<unknown>,
  /** captured SQL strings (best-effort .toString()) for verification. */
  executedSql: [] as string[],
  /** captured fkEdges to return for topological lookup. */
  fkEdges: [] as Array<{ child_table: string; parent_table: string }>,
  /** rows the W08 attachment object pre-clear SELECT returns (default: none). */
  attachmentKeyRows: [] as Array<{ storage_key: string }>,
}));

function sqlToText(q: unknown): string {
  // Drizzle's sql template stringifies as `[object Object]`; reach into
  // `queryChunks` for the literal text fragments. Nested sql.raw()
  // chunks have their own queryChunks → recurse.
  if (q && typeof q === 'object' && 'queryChunks' in q) {
    const chunks = (q as { queryChunks: unknown[] }).queryChunks;
    return chunks
      .map((c) => {
        if (c && typeof c === 'object') {
          if ('value' in c && Array.isArray((c as { value: unknown[] }).value)) {
            return ((c as { value: string[] }).value).join('');
          }
          if ('queryChunks' in c) return sqlToText(c);
        }
        return '';
      })
      .join(' ');
  }
  return String(q);
}

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn(<T,>(fn: () => Promise<T>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    execute: vi.fn((q: unknown) => {
      const text = sqlToText(q);
      mockState.executedSql.push(text);
      // Topological query: if it asks for FK edges, return those.
      if (text.includes('pg_constraint') || text.includes('contype')) {
        return Promise.resolve(mockState.fkEdges);
      }
      // SET LOCAL statements don't consume the queue (they're bookkeeping
      // for the audit_logs DELETE bypass).
      if (text.includes('SET LOCAL')) {
        return Promise.resolve({ rowCount: 0 });
      }
      // W08 #3902: the attachment object pre-clear is a SELECT, not a DELETE.
      // It must NOT consume a queued rowCount response, or every existing
      // `executeResponses` fixture silently shifts by one and the row-count
      // assertions below start measuring the wrong statements.
      if (text.includes('SELECT storage_key')) {
        return Promise.resolve(mockState.attachmentKeyRows);
      }
      const next = mockState.executeResponses.shift();
      if (next === undefined) {
        return Promise.resolve({ rowCount: 0 });
      }
      return Promise.resolve(next as any);
    }),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve(undefined)),
    })),
  },
}));

const { deleteObjectKeysMock } = vi.hoisted(() => ({ deleteObjectKeysMock: vi.fn() }));
vi.mock('./ticketAttachmentStorage', () => ({
  deleteObjectKeys: deleteObjectKeysMock,
}));

// W08 #3902: the erasure-failed forensic audit is asserted directly, so the
// audit writer is mocked rather than left to fall through to the mocked db.
const { createAuditLogMock } = vi.hoisted(() => ({ createAuditLogMock: vi.fn(async () => undefined) }));
vi.mock('./auditService', () => ({
  createAuditLog: createAuditLogMock,
}));

import {
  getOrgCascadeDeleteOrder,
  cascadeDeleteOrg,
  topologicalCascadeOrder,
  __testOnly,
} from './tenantCascade';
import { db } from '../db';

const cascadeOrder = getOrgCascadeDeleteOrder();

describe('getOrgCascadeDeleteOrder()', () => {
  it('has every entry as a safe identifier', () => {
    for (const t of cascadeOrder) {
      expect(t).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
  });

  it('has no duplicates', () => {
    const set = new Set(cascadeOrder);
    expect(set.size).toBe(cascadeOrder.length);
  });

  it('places `organizations` last (it is the id-keyed root)', () => {
    expect(cascadeOrder.at(-1)).toBe('organizations');
  });

  it('includes topology_layout in localeCompare order', () => {
    expect(cascadeOrder).toContain('topology_layout');
    const sorted = [...cascadeOrder].sort((a, b) => a.localeCompare(b));
    // organizations is intentionally last; ignore it for the order check
    const withoutOrgs = cascadeOrder.filter((t) => t !== 'organizations');
    const sortedWithoutOrgs = sorted.filter((t) => t !== 'organizations');
    expect(withoutOrgs).toEqual(sortedWithoutOrgs);
  });

  it('registers report_schedule_recipients in localeCompare order', () => {
    const order = getOrgCascadeDeleteOrder();
    const recipients = order.indexOf('report_schedule_recipients');
    const reports = order.indexOf('reports');

    expect(recipients).toBeGreaterThan(-1);
    expect(reports).toBeGreaterThan(recipients);
    expect(
      order.filter((name) => name !== 'organizations'),
    ).toEqual(
      order
        .filter((name) => name !== 'organizations')
        .sort((a, b) => a.localeCompare(b)),
    );
  });

  it('routes append-only ML feedback labels through the audit-admin delete path', () => {
    expect(cascadeOrder).toContain('ml_feedback_events');
    expect(__testOnly.AUDIT_ADMIN_REQUIRED_TABLES.has('ml_feedback_events')).toBe(true);
  });

  it('routes append-only peripheral delivery evidence through the audit-admin delete path', () => {
    expect(cascadeOrder).toContain('peripheral_policy_delivery_events');
    expect(__testOnly.AUDIT_ADMIN_REQUIRED_TABLES.has('peripheral_policy_delivery_events')).toBe(true);
  });

  it('registers health evidence and latest projection for ordinary tenant erasure', () => {
    expect(cascadeOrder).toContain('agent_health_observations');
    expect(cascadeOrder).toContain('automation_action_results');
    expect(cascadeOrder).toContain('device_agent_health_latest');
    expect(__testOnly.AUDIT_ADMIN_REQUIRED_TABLES.has('agent_health_observations')).toBe(false);
    expect(__testOnly.AUDIT_ADMIN_REQUIRED_TABLES.has('device_agent_health_latest')).toBe(false);
    expect(cascadeOrder).toContain('software_inventory_observations');
    expect(cascadeOrder).toContain('device_software_inventory_state');
    expect(__testOnly.AUDIT_ADMIN_REQUIRED_TABLES.has('software_inventory_observations')).toBe(false);
  });

  it('includes the canonical tenant tables', () => {
    const set = new Set(cascadeOrder);
    for (const required of [
      'devices',
      'users',
      'sites',
      'alerts',
      'audit_logs',
      'agent_logs',
      'ml_feedback_events',
      'organizations',
    ]) {
      expect(set.has(required), `missing required table ${required}`).toBe(true);
    }
  });
});

describe('topologicalCascadeOrder', () => {
  beforeEach(() => {
    mockState.executeResponses = [];
    mockState.executedSql = [];
    mockState.fkEdges = [];
  });

  it('returns the same set as getOrgCascadeDeleteOrder()', async () => {
    mockState.fkEdges = []; // no FKs → any order is valid, default is alpha
    const order = await topologicalCascadeOrder();
    expect(new Set(order)).toEqual(new Set(cascadeOrder));
    expect(order.length).toBe(cascadeOrder.length);
  });

  it('places a child before its parent when an FK edge exists', async () => {
    // devices.user_id → users.id is contrived but illustrates the
    // direction; if it existed, devices would have to come before users.
    mockState.fkEdges = [{ child_table: 'devices', parent_table: 'users' }];
    const order = await topologicalCascadeOrder();
    const devicesIdx = order.indexOf('devices');
    const usersIdx = order.indexOf('users');
    expect(devicesIdx).toBeLessThan(usersIdx);
  });

  it('throws on FK cycles', async () => {
    mockState.fkEdges = [
      { child_table: 'devices', parent_table: 'users' },
      { child_table: 'users', parent_table: 'devices' },
    ];
    await expect(topologicalCascadeOrder()).rejects.toThrow(/cycle/i);
  });

  it('ignores edges between cascade and non-cascade tables', async () => {
    mockState.fkEdges = [
      { child_table: 'something_not_in_list', parent_table: 'users' },
      { child_table: 'devices', parent_table: 'also_not_in_list' },
    ];
    const order = await topologicalCascadeOrder();
    expect(order.length).toBe(cascadeOrder.length);
  });
});

describe('cascadeDeleteOrg', () => {
  beforeEach(() => {
    mockState.executeResponses = [];
    mockState.executedSql = [];
    mockState.fkEdges = [];
    vi.mocked(db.execute).mockClear();
  });

  it('issues a DELETE for every cascade table plus the audit + cleanup SQL', async () => {
    // Default to 0 rows for every DELETE; the function should still
    // walk through every table.
    mockState.executeResponses = []; // empty queue → 0 rowCount default
    const stats = await cascadeDeleteOrg(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      'admin@example.com',
    );

    // tablesDeleted should contain every cascade table (plus device_commands).
    expect(Object.keys(stats.tablesDeleted)).toEqual(
      expect.arrayContaining([
        ...cascadeOrder,
        'device_commands',
      ]),
    );
    expect(stats.totalRowsDeleted).toBe(0);
    expect(stats.orgId).toBe('00000000-0000-0000-0000-000000000001');
    expect(stats.performedBy).toBe('00000000-0000-0000-0000-000000000002');
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sums rowCount across tables into totalRowsDeleted', async () => {
    // Provide a non-zero rowCount for the first few execute() calls;
    // device_commands is cleared first then the cascade walk begins.
    mockState.executeResponses = [
      { rowCount: 5 }, // device_commands
      ...Array(cascadeOrder.length).fill({ rowCount: 3 }),
    ];
    const stats = await cascadeDeleteOrg(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    );
    // 5 from device_commands + 3 per cascade table.
    expect(stats.totalRowsDeleted).toBe(5 + 3 * cascadeOrder.length);
  });

  it('tolerates a missing associated system-scoped table (42P01, FLAT shape)', async () => {
    // The flat shape — SQLSTATE on the error itself. Kept, but note it does
    // NOT exercise what production actually throws: see the wrapped-shape test
    // below, which is the one that fails against a top-level `.code` read.
    //
    // Override the default mock to make ONLY the device_commands DELETE
    // throw 42P01; everything else returns 0.
    vi.mocked(db.execute).mockImplementation(((q: unknown) => {
      const text = sqlToText(q);
      if (text.includes('pg_constraint') || text.includes('contype')) {
        return Promise.resolve(mockState.fkEdges);
      }
      if (text.includes('device_commands')) {
        const err: any = new Error('relation "device_commands" does not exist');
        err.code = '42P01';
        return Promise.reject(err);
      }
      return Promise.resolve({ rowCount: 0 });
    }) as any);

    const stats = await cascadeDeleteOrg(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    );
    expect(stats.totalRowsDeleted).toBe(0);
  });

  /**
   * The shape production ACTUALLY throws.
   *
   * `drizzle-orm/postgres-js` catches the postgres-js `PostgresError` and
   * rethrows a `DrizzleQueryError` whose own `.code` is undefined — the
   * SQLSTATE is on `.cause`. The flat fixture above passes whether
   * `isUndefinedTable` reads `err.code` or unwraps, so it proved nothing; this
   * one fails against the top-level read.
   *
   * What that broken read cost: `isUndefinedTable` returns false for a
   * genuinely missing table, so the `!isUndefinedTable(err)` branch fires,
   * writes an erasure-FAILED forensic audit, and throws — aborting a GDPR org
   * erasure partway through on any deployment that simply does not have one of
   * the optional tables. The helper exists to tolerate exactly that.
   */
  it('tolerates a missing associated table when the SQLSTATE is WRAPPED (DrizzleQueryError)', async () => {
    vi.mocked(db.execute).mockImplementation(((q: unknown) => {
      const text = sqlToText(q);
      if (text.includes('pg_constraint') || text.includes('contype')) {
        return Promise.resolve(mockState.fkEdges);
      }
      if (text.includes('device_commands')) {
        // Faithful to Drizzle: own `.code` undefined, SQLSTATE on `.cause`.
        const cause: any = new Error('relation "device_commands" does not exist');
        cause.code = '42P01';
        const wrapped: any = new Error('Failed query: delete from device_commands');
        wrapped.name = 'DrizzleQueryError';
        wrapped.cause = cause;
        return Promise.reject(wrapped);
      }
      return Promise.resolve({ rowCount: 0 });
    }) as any);

    // Must COMPLETE. Against the top-level read this rejects instead.
    const stats = await cascadeDeleteOrg(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    );
    expect(stats.totalRowsDeleted).toBe(0);
  });

  it('re-throws and aborts cascade on a non-42P01 error', async () => {
    // FK edge query returns []; the first DELETE call AFTER the associated
    // pre-clears (ASSOCIATED_SYSTEM_SCOPED_TABLES — seven of them now, not the
    // three this comment used to name) throws a
    // non-42P01 — i.e. the first ordered cascade-table DELETE, which is the
    // path that wraps errors with `DELETE from "<table>"` context.
    const associatedCount = __testOnly.ASSOCIATED_SYSTEM_SCOPED_TABLES.length;
    let callIdx = 0;
    vi.mocked(db.execute).mockImplementation(((q: unknown) => {
      const text = sqlToText(q);
      if (text.includes('pg_constraint') || text.includes('contype')) {
        return Promise.resolve([]);
      }
      // W08 #3902: the attachment object pre-clear SELECT runs before the
      // associated-table loop; excluded from the index so `associatedCount + 1`
      // still names the FIRST ordered cascade-table DELETE.
      if (text.includes('SELECT storage_key')) {
        return Promise.resolve([]);
      }
      callIdx += 1;
      if (callIdx === associatedCount + 1) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve({ rowCount: 0 });
    }) as any);

    await expect(
      cascadeDeleteOrg(
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
      ),
    ).rejects.toThrow(/DELETE from "/);
  });
});

describe('quoteIdent', () => {
  it('quotes safe identifiers', () => {
    expect(__testOnly.quoteIdent('devices')).toBe('"devices"');
    expect(__testOnly.quoteIdent('audit_logs')).toBe('"audit_logs"');
  });

  it('refuses unsafe identifiers', () => {
    expect(() => __testOnly.quoteIdent('devices; DROP TABLE users')).toThrow();
    expect(() => __testOnly.quoteIdent('"injected"')).toThrow();
    expect(() => __testOnly.quoteIdent('123_starts_with_digit')).toThrow();
  });
});

describe('ticket_attachments registration (W08 #3902)', () => {
  it('is in the org cascade list between ticket_alert_links and ticket_email_links', () => {
    const order = getOrgCascadeDeleteOrder();
    const i = order.indexOf('ticket_attachments');
    expect(i).toBeGreaterThan(-1);
    expect(order.indexOf('ticket_alert_links')).toBeLessThan(i);
    expect(i).toBeLessThan(order.indexOf('ticket_email_links'));
    expect(i).toBeLessThan(order.indexOf('tickets')); // FK child before parent
  });
});

/**
 * W08 #3902 / spec D9 — attachment OBJECTS are cleared before the row cascade.
 * The rows are the only index to the object keys, so the reverse order would
 * leave customer bytes in the bucket that nothing can find.
 */
describe('cascadeDeleteOrg attachment object pre-clear (W08 #3902)', () => {
  const ORG = '00000000-0000-0000-0000-000000000001';
  const BY = '00000000-0000-0000-0000-000000000002';

  beforeEach(() => {
    mockState.executeResponses = [];
    mockState.executedSql = [];
    mockState.fkEdges = [];
    mockState.attachmentKeyRows = [];
    vi.mocked(db.execute).mockClear();
    deleteObjectKeysMock.mockReset();
    deleteObjectKeysMock.mockResolvedValue(undefined);
    createAuditLogMock.mockClear();
  });

  function rigKeys(rows: Array<{ storage_key: string }>) {
    vi.mocked(db.execute).mockImplementation(((q: unknown) => {
      const text = sqlToText(q);
      if (text.includes('pg_constraint') || text.includes('contype')) {
        return Promise.resolve(mockState.fkEdges);
      }
      mockState.executedSql.push(text);
      if (text.includes('SELECT storage_key')) return Promise.resolve(rows);
      return Promise.resolve({ rowCount: 0 });
    }) as any);
  }

  it('reads the s3 keys and deletes the objects BEFORE the first cascade DELETE', async () => {
    const order: string[] = [];
    deleteObjectKeysMock.mockImplementation(async () => { order.push('objects'); });
    vi.mocked(db.execute).mockImplementation(((q: unknown) => {
      const text = sqlToText(q);
      if (text.includes('pg_constraint') || text.includes('contype')) {
        return Promise.resolve(mockState.fkEdges);
      }
      if (text.includes('SELECT storage_key')) {
        order.push('select-keys');
        return Promise.resolve([{ storage_key: 'ticket-attachments/a1' }]);
      }
      if (/^\s*delete/i.test(text)) order.push(`delete:${text.slice(0, 60)}`);
      return Promise.resolve({ rowCount: 0 });
    }) as any);

    await cascadeDeleteOrg(ORG, BY);

    expect(order[0]).toBe('select-keys');
    expect(order[1]).toBe('objects');
    expect(order.slice(2).every((s) => s.startsWith('delete:'))).toBe(true);
    expect(deleteObjectKeysMock).toHaveBeenCalledWith(['ticket-attachments/a1']);
  });

  it('scopes the key read to this org and to s3-backed rows only', async () => {
    rigKeys([]);
    await cascadeDeleteOrg(ORG, BY);
    const keyQuery = mockState.executedSql.find((t) => t.includes('SELECT storage_key'))!;
    expect(keyQuery).toContain('ticket_attachments');
    expect(keyQuery).toContain('org_id');
    expect(keyQuery).toContain("storage_backend = 's3'");
  });

  it('issues ZERO object deletes for an org with only db-backend attachments', async () => {
    rigKeys([]);
    await cascadeDeleteOrg(ORG, BY);
    expect(deleteObjectKeysMock).not.toHaveBeenCalled();
  });

  it('ABORTS rerunnably on an object-store fault, leaving the rows and writing the failed audit', async () => {
    const deletes: string[] = [];
    vi.mocked(db.execute).mockImplementation(((q: unknown) => {
      const text = sqlToText(q);
      if (text.includes('pg_constraint') || text.includes('contype')) {
        return Promise.resolve(mockState.fkEdges);
      }
      if (text.includes('SELECT storage_key')) {
        return Promise.resolve([{ storage_key: 'ticket-attachments/a1' }]);
      }
      if (/^\s*delete/i.test(text)) deletes.push(text);
      return Promise.resolve({ rowCount: 0 });
    }) as any);
    deleteObjectKeysMock.mockRejectedValue(new Error('bucket unreachable'));

    await expect(cascadeDeleteOrg(ORG, BY)).rejects.toThrow(/rerunnable/i);
    // Nothing was deleted, so a re-run re-reads the same keys and finishes.
    expect(deletes).toHaveLength(0);
    // The forensic breadcrumb names the object pre-clear, not a table.
    expect(createAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant.erasure.failed',
        result: 'failure',
        details: expect.objectContaining({ failedTable: 'ticket_attachments_objects' }),
      }),
    );
  });
});
