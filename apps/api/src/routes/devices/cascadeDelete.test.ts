import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { getTableName } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Mocks for the behavior suite (hoisted above all imports). The static
// contract tests below only read exported constants + the real schema, so
// these mocks don't affect them. Mock shapes mirror core.permissions.test.ts.
// ---------------------------------------------------------------------------

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    execute: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../services/deviceLinkGroups', () => ({
  dissolveLinkGroupIfBelowMinimum: vi.fn(async () => false),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123',
      orgCondition: () => undefined,
      token: { mfa: true },
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    c.set('permissions', {
      permissions: [{ resource, action }],
      partnerId: null,
      orgId: 'org-123',
      roleId: 'role-123',
      scope: 'organization',
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../../services/remoteAccessPolicy', () => ({
  resolveRemoteAccessForDevice: vi.fn().mockResolvedValue({ policyId: null, settings: {} }),
}));

vi.mock('../../services/remoteAccessLauncher', () => ({
  resolveRemoteAccessLaunch: vi.fn().mockReturnValue({ launchUrl: null, skipReason: 'no_provider_configured' }),
}));

vi.mock('../agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: { SELF_UNINSTALL: 'self_uninstall' },
  queueCommandForExecution: vi.fn(),
}));

vi.mock('../agents/enrollment', () => ({
  getGlobalEnrollmentSecret: vi.fn().mockReturnValue(null),
}));

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import * as schema from '../../db/schema';
import {
  coreRoutes,
  getDeviceCascadeDeleteTables,
  DEVICE_CASCADE_DELETE_TABLES,
  DEVICE_DETACH_DEVICE_ID_TABLES,
  DEVICE_LINKED_DEVICE_ID_TABLES,
  DEVICE_LINK_DEPENDENT_COLUMNS,
} from './core';
import { db } from '../../db';
import { isAgentConnected, sendCommandToAgent } from '../agentWs';

const deviceCascadeDeleteTables = getDeviceCascadeDeleteTables();

/**
 * Tables that have a column named `device_id` but it does NOT reference devices.id.
 * Add a table here only when its device_id FK points to a different table.
 */
const NOT_DEVICES_FK: ReadonlySet<string> = new Set([
  'mobile_devices',        // device_id is a varchar identifier, not a FK to devices
  'snmp_alert_thresholds', // device_id → snmp_devices.id
  'snmp_metrics',          // device_id → snmp_devices.id
]);

/**
 * Device-scoped tables the application must not write directly: rows are
 * maintained exclusively by SECURITY DEFINER triggers (breeze_app has
 * INSERT/UPDATE/DELETE revoked in ensureAppRole.ts and direct writes are
 * rejected by a BEFORE trigger), and the device_id FK declares
 * ON DELETE CASCADE, so the RI trigger removes the row when the devices row
 * is deleted. Putting one of these in getDeviceCascadeDeleteTables() would
 * make the hard-delete path fail with 42501.
 */
const DB_TRIGGER_MAINTAINED: ReadonlySet<string> = new Set([
  'partner_export_device_material_state',
]);

function getTableColumns(table: PgTable<any>): any[] {
  return Object.values(
    (table as any)[Symbol.for('drizzle:Columns')] ?? {}
  );
}

function allSchemaTables(): PgTable<any>[] {
  return Object.values(schema).filter((v) => v instanceof PgTable) as PgTable<any>[];
}

describe('device hard-delete table coverage contract', () => {
  it('every table with a device_id FK to devices.id is in exactly one of cascade/detach/linked sets', () => {
    const cascadeSet = new Set<string>(deviceCascadeDeleteTables);
    const detachSet = new Set<string>(DEVICE_DETACH_DEVICE_ID_TABLES);
    const linkedSet = new Set<string>(DEVICE_LINKED_DEVICE_ID_TABLES);

    const problems: string[] = [];

    for (const table of allSchemaTables()) {
      const tableName = getTableName(table);
      if (NOT_DEVICES_FK.has(tableName)) continue;
      if (DB_TRIGGER_MAINTAINED.has(tableName)) continue;

      const hasDeviceId = getTableColumns(table).some((col) => col.name === 'device_id');
      if (!hasDeviceId) continue;

      const memberships = [
        cascadeSet.has(tableName) ? 'getDeviceCascadeDeleteTables()' : null,
        detachSet.has(tableName) ? 'DEVICE_DETACH_DEVICE_ID_TABLES' : null,
        linkedSet.has(tableName) ? 'DEVICE_LINKED_DEVICE_ID_TABLES' : null,
      ].filter((m): m is string => m !== null);

      if (memberships.length === 0) {
        problems.push(`${tableName}: in NO set`);
      } else if (memberships.length > 1) {
        problems.push(`${tableName}: in MULTIPLE sets (${memberships.join(', ')})`);
      }
    }

    expect(
      problems,
      `Every table with a device_id FK to devices.id must appear in EXACTLY ONE of ` +
        `getDeviceCascadeDeleteTables() (rows deleted; order matters — children before parents), ` +
        `DEVICE_DETACH_DEVICE_ID_TABLES (tenant business records — device_id SET NULL), or ` +
        `DEVICE_LINKED_DEVICE_ID_TABLES (linked_device_id SET NULL) in core.ts. ` +
        `If the device_id column references a table other than devices, add it to NOT_DEVICES_FK ` +
        `in this test instead.\n\nProblems: ${problems.join('; ')}`
    ).toEqual([]);
  });

  it('tickets is in the detach set, not the cascade set', () => {
    // Tickets are tenant business records — hard-deleting a device must
    // preserve ticket history and detach the device, never destroy tickets.
    expect(DEVICE_DETACH_DEVICE_ID_TABLES).toContain('tickets');
    expect(deviceCascadeDeleteTables).not.toContain('tickets');
  });

  it('deletes ML output rows before anomaly parent rows during device hard-delete', () => {
    expect(deviceCascadeDeleteTables).toContain('remediation_suggestions');
    expect(deviceCascadeDeleteTables).toContain('metric_anomalies');
    expect(deviceCascadeDeleteTables.indexOf('remediation_suggestions')).toBeLessThan(
      deviceCascadeDeleteTables.indexOf('metric_anomalies'),
    );
  });

  it('includes every table whose linked_device_id FK references devices.id', () => {
    const linkedSet = new Set<string>(DEVICE_LINKED_DEVICE_ID_TABLES);
    const missing: string[] = [];

    for (const table of allSchemaTables()) {
      const tableName = getTableName(table);
      const hasLinkedDeviceId = getTableColumns(table).some(
        (col) => col.name === 'linked_device_id'
      );

      if (hasLinkedDeviceId && !linkedSet.has(tableName)) {
        missing.push(tableName);
      }
    }

    expect(
      missing,
      `These tables have a linked_device_id FK but are missing from DEVICE_LINKED_DEVICE_ID_TABLES in core.ts. ` +
        `Add them so linked_device_id gets SET NULL during cascade delete.\n\n` +
        `Missing: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('does not list tables that no longer exist in the schema', () => {
    const allTableNames = new Set(allSchemaTables().map((t) => getTableName(t)));

    const staleCascade = DEVICE_CASCADE_DELETE_TABLES.filter(
      (t) => !allTableNames.has(t)
    );
    const staleDetach = DEVICE_DETACH_DEVICE_ID_TABLES.filter(
      (t) => !allTableNames.has(t)
    );
    const staleLinked = DEVICE_LINKED_DEVICE_ID_TABLES.filter(
      (t) => !allTableNames.has(t)
    );

    expect(
      staleCascade,
      `These core tables are in DEVICE_CASCADE_DELETE_TABLES but no longer exist in the schema. Remove them.`
    ).toEqual([]);
    expect(
      staleDetach,
      `These tables are in DEVICE_DETACH_DEVICE_ID_TABLES but no longer exist in the schema. Remove them.`
    ).toEqual([]);
    expect(
      staleLinked,
      `These tables are in DEVICE_LINKED_DEVICE_ID_TABLES but no longer exist in the schema. Remove them.`
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #3952 — a link's provenance columns must be cleared WITH the link.
//
// Detaching a device nulls `linked_device_id`. Any CHECK constraint that makes
// another column conditional on that link is therefore violated the instant the
// pointer is nulled and the companion column is not — Postgres raises 23514 and
// the whole cascade rolls back as a 500. That is exactly what shipped for
// `discovered_assets.link_source`.
//
// Membership contracts are checked from the SCHEMA above; this one has to be
// derived from the MIGRATIONS, because a CHECK constraint exists only in SQL —
// the Drizzle schema has no idea the constraint is there. Without that,
// "remember to null the provenance column too" is a code-review item, and this
// repo's own history says review catches cascade-registration misses 0/5 while
// contract tests catch them 5/5.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations');

/**
 * Columns a `linked_device_id` CHECK names that must NOT be cleared on detach.
 *
 * Empty today, and an entry needs a written reason. The derivation below flags
 * every column co-mentioned with `linked_device_id` in a CHECK, which is
 * deliberately broader than "columns the constraint actually forbids": proving
 * the logical form of arbitrary SQL is not something a regex should attempt, so
 * a constraint like `CHECK (linked_device_id IS NULL OR site_id IS NOT NULL)`
 * — where nulling site_id is wrong — is resolved by a human writing it down
 * here rather than by the parser guessing.
 */
const LINK_CHECK_COLUMNS_NOT_CLEARED: ReadonlyMap<string, ReadonlySet<string>> = new Map();

/** Every `CHECK (...)` body in one migration file, with its owning table. */
function checkConstraints(sqlText: string): { table: string | null; body: string }[] {
  const found: { table: string | null; body: string }[] = [];
  const opener = /\bCHECK\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(sqlText)) !== null) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    for (; i < sqlText.length && depth > 0; i++) {
      if (sqlText[i] === '(') depth++;
      else if (sqlText[i] === ')') depth--;
    }
    // Unbalanced (a paren inside a string literal, say) — skip rather than
    // guess at a body. The vacuity check below is what keeps a parser that
    // silently matches nothing from passing as a green guard.
    if (depth !== 0) continue;
    found.push({ table: owningTable(sqlText, match.index), body: sqlText.slice(start, i - 1) });
  }
  return found;
}

/** The nearest CREATE/ALTER TABLE ahead of this CHECK — inline or ADD CONSTRAINT. */
function owningTable(sqlText: string, checkIndex: number): string | null {
  const preceding = sqlText.slice(0, checkIndex);
  const decl = /\b(?:CREATE|ALTER)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
  let table: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = decl.exec(preceding)) !== null) table = match[1]!.toLowerCase();
  return table;
}

function columnNamesOf(tableName: string): ReadonlySet<string> {
  const table = allSchemaTables().find((t) => getTableName(t) === tableName);
  return new Set<string>(table ? getTableColumns(table).map((col) => String(col.name)) : []);
}

/** table -> columns named by a CHECK that also names linked_device_id. */
function deriveLinkConditionalColumns(): Map<string, Set<string>> {
  const linkedTables = new Set<string>(DEVICE_LINKED_DEVICE_ID_TABLES);
  const derived = new Map<string, Set<string>>();

  for (const file of readdirSync(MIGRATIONS_DIR)) {
    if (!file.endsWith('.sql')) continue;
    const text = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    if (!text.includes('linked_device_id')) continue;

    for (const { table, body } of checkConstraints(text)) {
      if (!table || !linkedTables.has(table)) continue;
      if (!/\blinked_device_id\b/.test(body)) continue;

      // Intersect the constraint's identifiers with the table's REAL columns.
      // That is what removes the need to blacklist SQL keywords: `IS`, `NULL`
      // and `OR` are not columns of discovered_assets, so they drop out.
      //
      // KNOWN NARROW BLIND SPOT: "REAL columns" means the DRIZZLE schema, not
      // the database. A column that exists in a migration but was never added
      // to the schema file would be dropped here and silently escape the
      // contract below. That drift is `pnpm db:check-drift`'s job, not this
      // test's — noted so the gap is a documented handoff rather than an
      // assumed impossibility.
      const columns = columnNamesOf(table);
      const conditional = derived.get(table) ?? new Set<string>();
      for (const token of body.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
        const name = token.toLowerCase();
        if (name === 'linked_device_id') continue;
        if (columns.has(name)) conditional.add(name);
      }
      derived.set(table, conditional);
    }
  }

  return derived;
}

describe('migration CHECK parsing (the derivation the contract below rests on)', () => {
  // The contract test's vacuity guard pins the ONE constraint that exists
  // today, which proves the parser is not matching nothing — but it says
  // nothing about SQL shapes this repo has not written yet. A parser that
  // silently stops recognising a future shape would take the contract quietly
  // vacuous with it, so pin the shapes directly against synthetic SQL.
  it('reads an ALTER TABLE ... ADD CONSTRAINT ... CHECK', () => {
    const found = checkConstraints(
      `ALTER TABLE discovered_assets\n  ADD CONSTRAINT x CHECK (link_source IS NULL OR linked_device_id IS NOT NULL);`
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.table).toBe('discovered_assets');
    expect(found[0]!.body).toContain('link_source');
    expect(found[0]!.body).toContain('linked_device_id');
  });

  it('reads a CHECK inline in a CREATE TABLE, with nested parentheses', () => {
    const found = checkConstraints(
      `CREATE TABLE IF NOT EXISTS public.discovered_assets (\n  link_source text,\n  linked_device_id uuid,\n  CONSTRAINT c CHECK ((link_source IS NULL) OR (linked_device_id IS NOT NULL))\n);`
    );
    expect(found).toHaveLength(1);
    // `public.` qualified and paren-nested — the balanced scan must not stop at
    // the first inner ')'.
    expect(found[0]!.table).toBe('discovered_assets');
    expect(found[0]!.body).toContain('linked_device_id IS NOT NULL');
  });

  it('attributes each CHECK to the nearest preceding table, not the first in the file', () => {
    // A migration that touches several tables must not hand one table's
    // constraint to another — that would both miss a real registration and
    // demand a bogus one. Two constraints on two tables in one file is the
    // smallest fixture where "nearest" and "first" give different answers.
    const found = checkConstraints(
      `CREATE TABLE network_change_events (\n`
      + `  linked_device_id uuid,\n`
      + `  CONSTRAINT a CHECK (alert_id IS NULL OR linked_device_id IS NOT NULL)\n`
      + `);\n`
      + `CREATE TABLE discovered_assets (\n`
      + `  link_source text,\n`
      + `  linked_device_id uuid\n`
      + `);\n`
      + `ALTER TABLE discovered_assets ADD CONSTRAINT b CHECK (link_source IS NULL OR linked_device_id IS NOT NULL);`
    );
    expect(found.map((f) => f.table)).toEqual(['network_change_events', 'discovered_assets']);
    // And the bodies did not get swapped along with the names.
    expect(found[0]!.body).toContain('alert_id');
    expect(found[1]!.body).toContain('link_source');
  });

  it('is case-insensitive and tolerates quoted identifiers', () => {
    const found = checkConstraints(
      `alter table "discovered_assets" add constraint c check (link_source is null or linked_device_id is not null);`
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.table).toBe('discovered_assets');
  });
});

describe('linked_device_id detach clears every link-conditional column (#3952)', () => {
  const derived = deriveLinkConditionalColumns();

  it('actually finds the known link_source constraint', () => {
    // A derivation that matches nothing would make the contract test below
    // pass unconditionally — the failure mode that makes a static guard worse
    // than none. Pin the one constraint that exists today: if migration
    // 2026-06-27-discovered-asset-link-source.sql is renamed, reworded, or the
    // parser stops recognising ADD CONSTRAINT ... CHECK, this fails loudly
    // rather than going quietly vacuous.
    expect(
      [...(derived.get('discovered_assets') ?? [])],
      `The migration scan no longer sees discovered_assets_link_source_requires_link ` +
        `(CHECK (link_source IS NULL OR linked_device_id IS NOT NULL)). Either the ` +
        `constraint moved or checkConstraints()/owningTable() stopped parsing it — ` +
        `fix the derivation, do NOT delete this test.`
    ).toContain('link_source');
  });

  it('registers every link-conditional column in DEVICE_LINK_DEPENDENT_COLUMNS', () => {
    const problems: string[] = [];

    for (const [table, conditional] of derived) {
      const cleared = new Set<string>(DEVICE_LINK_DEPENDENT_COLUMNS[table] ?? []);
      const exempt = LINK_CHECK_COLUMNS_NOT_CLEARED.get(table) ?? new Set<string>();
      for (const column of conditional) {
        if (cleared.has(column) || exempt.has(column)) continue;
        problems.push(`${table}.${column}`);
      }
    }

    expect(
      problems,
      `A CHECK constraint in apps/api/migrations ties these columns to ` +
        `linked_device_id, but the device hard-delete detach does not clear them. ` +
        `Nulling linked_device_id alone violates the constraint (23514) and rolls ` +
        `the whole cascade back as a 500 — this is issue #3952. Add each column to ` +
        `DEVICE_LINK_DEPENDENT_COLUMNS in core.ts, or, if the constraint genuinely ` +
        `does not forbid the detached state, record it in ` +
        `LINK_CHECK_COLUMNS_NOT_CLEARED in this file WITH a reason.\n\n` +
        `Unregistered: ${problems.join(', ')}`
    ).toEqual([]);
  });

  it('only names tables and columns that exist', () => {
    // A typo here does not fail loudly at runtime — it becomes a 42703
    // undefined_column raised from inside the delete transaction, i.e. the same
    // 500 this fix removed, wearing a different SQLSTATE.
    const linkedTables = new Set<string>(DEVICE_LINKED_DEVICE_ID_TABLES);
    const problems: string[] = [];

    for (const [table, columns] of Object.entries(DEVICE_LINK_DEPENDENT_COLUMNS)) {
      if (!linkedTables.has(table)) {
        problems.push(`${table}: not in DEVICE_LINKED_DEVICE_ID_TABLES`);
        continue;
      }
      const real = columnNamesOf(table);
      for (const column of columns) {
        if (!real.has(column)) problems.push(`${table}.${column}: no such column in the schema`);
      }
    }

    expect(problems, `DEVICE_LINK_DEPENDENT_COLUMNS problems: ${problems.join('; ')}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Behavior: DELETE /devices/:id/permanent must DETACH tickets, not delete them.
// ---------------------------------------------------------------------------

/**
 * Flatten a Drizzle sql`` object into readable text. StringChunks carry a
 * string[] `value`, sql.identifier Names carry a string `value`, nested SQL
 * (subqueries) carries its own queryChunks, and raw bound params are pushed
 * as-is (same chunk shapes as documented in core.permissions.test.ts).
 */
function sqlToText(q: any): string {
  const chunks = q?.queryChunks ?? [];
  return chunks
    .map((ch: any) => {
      if (ch !== null && typeof ch === 'object') {
        if (Array.isArray(ch.queryChunks)) return sqlToText(ch);
        if (Array.isArray(ch.value)) return ch.value.join('');
        if ('value' in ch) return String(ch.value);
      }
      return String(ch);
    })
    .join('');
}

describe('DELETE /devices/:id/permanent — tickets are detached, not destroyed', () => {
  const DEVICE = {
    id: '11111111-1111-4111-8111-111111111111',
    orgId: 'org-123',
    siteId: 'site-1',
    hostname: 'host-1',
    displayName: 'Host 1',
    agentId: null,
    status: 'decommissioned' as const,
  };

  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks clears CALLS but keeps IMPLEMENTATIONS, so every impl
    // installed by a test leaks into the next one that forgets to re-rig.
    // Proven, not theoretical: the ordering test wraps db.transaction in a
    // closure over its own rig, and the dispatch-throws test makes
    // isAgentConnected throw. A test appended after either would silently run
    // against the wrong world — recording another test's ordering, or
    // exercising the catch path while looking like a happy-path test.
    vi.mocked(db.transaction).mockReset();
    vi.mocked(isAgentConnected).mockReset();
    vi.mocked(sendCommandToAgent).mockReset();
    app = new Hono();
    app.route('/devices', coreRoutes);
  });

  function rigDeviceLookup(device: unknown) {
    const limit = vi.fn().mockResolvedValue(device ? [device] : []);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    vi.mocked(db.select).mockReturnValue({ from } as never);
  }

  function rigDeleteTransaction(): string[] {
    const statements: string[] = [];
    vi.mocked(db.transaction).mockImplementation(async (cb: any) => {
      const tx = {
        execute: vi.fn().mockImplementation(async (q: any) => {
          const text = sqlToText(q);
          statements.push(text);
          // postgres-js resolves to an array-like carrying a non-enumerable
          // `.count`. A bare [] is not a result this driver can produce, and
          // returning one made every statement look like it affected 0 rows.
          const pgResult = (rows: Record<string, unknown>[], count = rows.length) => {
            Object.defineProperty(rows, 'count', { value: count, enumerable: false });
            return rows;
          };
          // The cascade tightens the lock bound and reads the caller's prior
          // value in ONE pg_settings statement (milliseconds, as an integer).
          // '0' is Postgres's "wait forever", the value that makes it actually
          // apply its 3s bound, so this keeps the mock on the interesting path.
          if (text.includes('pg_settings')) {
            return pgResult([{ prior_ms: '0' }]);
          }
          // The parent row lock must report ONE row. Returning [] here sent the
          // whole route suite down the "ran without holding the lock" branch,
          // so a regression that permanently lost the lock would have been
          // invisible to these tests.
          if (text.includes('FOR UPDATE')) {
            return pgResult([{ id: DEVICE.id }]);
          }
          return pgResult([]);
        }),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      };
      await cb(tx);
    });
    return statements;
  }

  it('hard delete detaches tickets (device_id -> NULL) instead of deleting them', async () => {
    rigDeviceLookup(DEVICE);
    const statements = rigDeleteTransaction();

    const res = await app.request(`/devices/${DEVICE.id}/permanent`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    // Previously this scenario 409'd: tickets with comments hit the
    // ticket_comments.ticket_id FK (no cascade) when DELETE FROM tickets ran.
    expect(res.status).toBe(200);

    const detachTickets = statements.filter((s) =>
      s.startsWith('UPDATE tickets SET device_id = NULL WHERE device_id = ')
    );
    expect(
      detachTickets,
      `Expected exactly one "UPDATE tickets SET device_id = NULL" statement.\nStatements:\n${statements.join('\n')}`
    ).toHaveLength(1);

    const deleteTickets = statements.filter((s) =>
      s.startsWith('DELETE FROM tickets WHERE')
    );
    expect(
      deleteTickets,
      `Tickets must never be deleted during device hard-delete.\nStatements:\n${statements.join('\n')}`
    ).toEqual([]);

    // psa_ticket_mappings (device-scoped integration rows) still cascade.
    expect(
      statements.some((s) => s.startsWith('DELETE FROM psa_ticket_mappings WHERE'))
    ).toBe(true);
  });

  it('hard delete clears discovered_assets.link_source in the same UPDATE as the link (#3952)', async () => {
    // The reported 500: an AUTO-linked discovered asset carries
    // link_source='auto', and `discovered_assets_link_source_requires_link`
    // (CHECK (link_source IS NULL OR linked_device_id IS NOT NULL)) rejects the
    // row the moment linked_device_id alone is nulled. Postgres raises 23514,
    // which the route's catch does not special-case, so the whole permanent
    // delete came back as an unhandled 500.
    //
    // Asserted on the COMPILED statement text, not on a mock call count: the
    // bug and the fix differ only in the SET clause, so anything short of
    // reading the generated SQL cannot tell them apart.
    rigDeviceLookup(DEVICE);
    const statements = rigDeleteTransaction();

    const res = await app.request(`/devices/${DEVICE.id}/permanent`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);

    const detach = statements.filter((s) => s.startsWith('UPDATE discovered_assets SET '));
    expect(
      detach,
      `Expected exactly one discovered_assets detach UPDATE.\nStatements:\n${statements.join('\n')}`
    ).toHaveLength(1);
    // One statement, both columns. A CHECK is evaluated per row at the end of
    // each statement, so a follow-up "UPDATE ... SET link_source = NULL" would
    // still transit the forbidden state and fail identically — the columns have
    // to be cleared together, which is what pinning the whole SET clause proves.
    expect(detach[0]).toBe(
      `UPDATE discovered_assets SET linked_device_id = NULL, link_source = NULL WHERE linked_device_id = ${DEVICE.id}`
    );

    // network_change_events has no link_source column: appending the assignment
    // to every linked table would trade 23514 for 42703 (undefined_column).
    const otherDetach = statements.filter((s) =>
      s.startsWith('UPDATE network_change_events SET linked_device_id')
    );
    expect(otherDetach).toHaveLength(1);
    expect(otherDetach[0]).not.toContain('link_source');

    // And the asset row itself survives — it is network inventory about an
    // endpoint that exists whether or not Breeze manages it, so a detach must
    // never become a delete.
    expect(
      statements.filter((s) => s.startsWith('DELETE FROM discovered_assets'))
    ).toEqual([]);
  });

  it('runs the link-group dissolve check when hard-deleting a linked boot profile (#2138)', async () => {
    const { dissolveLinkGroupIfBelowMinimum } = await import('../../services/deviceLinkGroups');
    rigDeviceLookup({ ...DEVICE, linkGroupId: 'grp-multiboot-1' });
    rigDeleteTransaction();

    const res = await app.request(`/devices/${DEVICE.id}/permanent`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    // The deleted device's link_group_id went with its row; the group may now
    // have a single lone survivor. Dropping this call silently strands a
    // 1-member group (the survivor renders ungrouped and re-linking it 409s).
    expect(dissolveLinkGroupIfBelowMinimum).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dissolveLinkGroupIfBelowMinimum).mock.calls[0]![1]).toBe('grp-multiboot-1');
  });

  it('does not touch link groups when the deleted device was unlinked', async () => {
    const { dissolveLinkGroupIfBelowMinimum } = await import('../../services/deviceLinkGroups');
    rigDeviceLookup(DEVICE);
    rigDeleteTransaction();

    const res = await app.request(`/devices/${DEVICE.id}/permanent`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(dissolveLinkGroupIfBelowMinimum).not.toHaveBeenCalled();
  });

  // Still `decommissioned` — the route 400s anything else BEFORE it ever
  // reaches the uninstall dispatch, so an 'online' status here would have
  // tested the wrong branch entirely. What makes the uninstall fire is an
  // agentId plus a live agent connection.
  const CONNECTED_DEVICE = { ...DEVICE, agentId: 'agent-1' };

  /**
   * Rigs the agent as online AND the send as succeeding — i.e. dispatch is
   * POSSIBLE. Named for that, not for "dispatched": the rollback tests below
   * use it precisely to prove nothing was sent, and a name like
   * `rigUninstallDispatched` reads as the opposite of what they assert.
   */
  function rigAgentOnlineAndSendable() {
    vi.mocked(isAgentConnected).mockReturnValue(true);
    // Returns synchronously — `uninstallSent = sendCommandToAgent(...)`, not an
    // awaited promise, so mockResolvedValue would make uninstallSent a Promise.
    vi.mocked(sendCommandToAgent).mockReturnValue(true as never);
  }

  async function auditDetails(): Promise<Record<string, unknown>> {
    const { writeRouteAudit } = await import('../../services/auditEvents');
    const call = vi.mocked(writeRouteAudit).mock.calls
      .map((c) => c[1] as { action?: string; details?: Record<string, unknown> })
      .find((entry) => entry.action === 'device.permanent_delete');
    expect(call, 'expected a device.permanent_delete audit entry').toBeDefined();
    return call!.details ?? {};
  }

  /**
   * #3817 — SELF_UNINSTALL is IRREVERSIBLE and must therefore be dispatched
   * only once the cascade has actually committed. It used to fire before
   * `db.transaction` opened, so every rollback path (23503, 55P03, and the
   * generic rethrow) left the agent removing itself while its device row
   * survived — an unmanageable orphan.
   *
   * On the HAPPY path this is the discriminating assertion for that ordering,
   * and the only one that is: both orderings send exactly one command with
   * identical response fields, so nothing short of recording WHEN the send
   * happened relative to the transaction can tell the fixed code from the
   * broken code. Against the pre-fix route this expects ['tx-commit',
   * 'dispatch'] and receives ['dispatch', 'tx-commit']. The rollback tests
   * below pin the same ordering from the other side — do not delete those as
   * redundant, they cover the paths this one cannot reach.
   *
   * On what 'tx-commit' means: `db.transaction` is mocked, so the marker
   * records the transaction callback RESOLVING, not a real COMMIT. Real commit
   * ordering is out of scope for a mocked-db test. That is enough to catch
   * every plausible regression here — dispatching before `db.transaction`,
   * inside the callback, or without awaiting it all land on the wrong side of
   * the marker.
   */
  it('dispatches SELF_UNINSTALL only after the cascade transaction commits (#3817)', async () => {
    rigDeviceLookup(CONNECTED_DEVICE);
    const order: string[] = [];

    // Wrap the real rig rather than replacing it, so the cascade still runs its
    // actual statements — an empty stub transaction would resolve trivially and
    // weaken the ordering claim to something the route could satisfy by accident.
    rigDeleteTransaction();
    const runTransaction = vi.mocked(db.transaction).getMockImplementation()!;
    vi.mocked(db.transaction).mockImplementation((async (cb: any) => {
      const result = await runTransaction(cb);
      order.push('tx-commit');
      return result;
    }) as never);

    vi.mocked(isAgentConnected).mockReturnValue(true);
    vi.mocked(sendCommandToAgent).mockImplementation((() => {
      order.push('dispatch');
      return true;
    }) as never);

    const res = await app.request(`/devices/${CONNECTED_DEVICE.id}/permanent`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(order).toEqual(['tx-commit', 'dispatch']);

    // Exactly once: moving the dispatch must not leave a second copy behind at
    // the old call site, which would uninstall via a duplicate command id.
    expect(sendCommandToAgent).toHaveBeenCalledTimes(1);
    const [agentId, command] = vi.mocked(sendCommandToAgent).mock.calls[0]!;
    expect(agentId).toBe('agent-1');
    expect(command).toMatchObject({
      id: `uninstall-${CONNECTED_DEVICE.id}`,
      type: 'self_uninstall',
      payload: { removeConfig: true },
    });

    // The success contract is unchanged by the reorder.
    const body = await res.json() as { success: boolean; agentUninstallSent: boolean; warning?: string };
    expect(body.success).toBe(true);
    expect(body.agentUninstallSent).toBe(true);
    expect(body.warning).toBeUndefined();

    // The audit entry is now the only DURABLE record that the irreversible
    // command actually went out — the device row it described is gone. It also
    // pins the audit below the dispatch: hoisting writeRouteAudit back above it
    // would record `false` for a command that was in fact sent.
    expect(await auditDetails()).toMatchObject({ uninstallCommandSent: true });
  });

  /**
   * The failure mode this fix deliberately ACCEPTS, and therefore the one that
   * has to be pinned: the agent drops between the commit and the dispatch. The
   * reorder moved the `isAgentConnected` check from before the transaction to
   * after it, so this state is strictly more reachable than it was — and in
   * practice it is the common case, since decommissioning (a precondition of
   * permanent delete) force-closes the agent socket.
   *
   * The delete must still succeed, and the operator must be TOLD the endpoint
   * needs a manual uninstall. Without this test, deleting the `warning` spread
   * or the connectivity guard is a silent change: mutating either leaves the
   * rest of the suite green.
   */
  it('completes the delete and warns when the agent is gone by commit time (#3817)', async () => {
    rigDeviceLookup(CONNECTED_DEVICE);
    rigDeleteTransaction();
    // Online at request time is irrelevant — what matters is the check that now
    // runs after the commit.
    vi.mocked(isAgentConnected).mockReturnValue(false);

    const res = await app.request(`/devices/${CONNECTED_DEVICE.id}/permanent`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    // The delete committed; a best-effort uninstall that could not be delivered
    // must never undo that.
    expect(res.status).toBe(200);
    // Guard intact: no send attempted against a socket that isn't there.
    expect(sendCommandToAgent).not.toHaveBeenCalled();

    const body = await res.json() as { success: boolean; agentUninstallSent: boolean; warning?: string };
    expect(body.success).toBe(true);
    expect(body.agentUninstallSent).toBe(false);
    expect(body.warning).toMatch(/manually remove/i);

    expect(await auditDetails()).toMatchObject({ uninstallCommandSent: false });
  });

  it('does not attempt an uninstall for a device that never had an agent', async () => {
    // DEVICE has agentId: null. The `device.agentId &&` half of the guard is
    // what stops a send keyed to a null agent id.
    rigDeviceLookup(DEVICE);
    rigDeleteTransaction();
    vi.mocked(isAgentConnected).mockReturnValue(true);

    const res = await app.request(`/devices/${DEVICE.id}/permanent`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    // The `device.agentId &&` short-circuit is itself load-bearing:
    // isAgentConnected asserts the process role and throws in the worker role,
    // so it must not be reached for a device that never had an agent.
    expect(isAgentConnected).not.toHaveBeenCalled();
    const body = await res.json() as { agentUninstallSent: boolean; warning?: string };
    expect(body.agentUninstallSent).toBe(false);
    // No agentId means there is no endpoint to go clean up by hand, so the
    // warning would be noise.
    expect(body.warning).toBeUndefined();
  });

  /**
   * The relocated dispatch runs AFTER the cascade committed, so nothing in it
   * may escape as a 500: that would lose the audit entry and the device-count
   * invalidation while the row is permanently gone, and would tell the caller
   * nothing happened when everything did. `isAgentConnected` is inside the try
   * for exactly this reason — it asserts the process role and can throw.
   */
  it('still reports success when the post-commit uninstall dispatch throws (#3817)', async () => {
    rigDeviceLookup(CONNECTED_DEVICE);
    rigDeleteTransaction();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const roleError = new Error('[BREEZE_ROLE] isAgentConnected is socket-local');
    vi.mocked(isAgentConnected).mockImplementation(() => {
      throw roleError;
    });

    try {
      const res = await app.request(`/devices/${CONNECTED_DEVICE.id}/permanent`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; agentUninstallSent: boolean; warning?: string };
      expect(body.success).toBe(true);
      expect(body.agentUninstallSent).toBe(false);
      expect(body.warning).toMatch(/manually remove/i);
      // Not swallowed in silence: the committed delete plus a failed uninstall
      // is exactly the state someone will need to reconstruct later.
      expect(await auditDetails()).toMatchObject({ uninstallCommandSent: false });
      // Second arg pins the request context, which carries user/route scope
      // into Sentry. (The raw-value passthrough that matters for Sentry's
      // tagging is pinned by the non-Error test below — with an Error input
      // the usual `err instanceof Error ? err : …` wrap is a no-op and cannot
      // be discriminated here. Verified by mutation.)
      const { captureException } = await import('../../services/sentry');
      expect(captureException).toHaveBeenCalledWith(roleError, expect.anything());
    } finally {
      consoleError.mockRestore();
    }
  });

  /**
   * captureException must receive the thrown value RAW. It takes `unknown`
   * deliberately and derives its Sentry tags by inspecting what it is handed
   * (connectTimeoutClassifier, pgErrorCode), so the reflex
   * `err instanceof Error ? err : new Error(String(err))` at a call site
   * silently strips `pg_code` and the CONNECT_TIMEOUT classification off every
   * non-Error throw — and `String()` on a hostile object can itself throw, out
   * of the catch whose whole job is keeping this block from escaping.
   *
   * A non-Error fixture is what makes this checkable: with an Error input that
   * wrap is a no-op, so the test above cannot discriminate it.
   */
  it('hands captureException the raw thrown value, not a wrapped Error', async () => {
    rigDeviceLookup(CONNECTED_DEVICE);
    rigDeleteTransaction();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Shaped like a postgres-js error: exactly the payload whose `code` the
    // Sentry tagging reads and a wrap would discard.
    const nonError = { code: '57P01', message: 'terminating connection' };
    vi.mocked(isAgentConnected).mockImplementation(() => {
      throw nonError;
    });

    try {
      const res = await app.request(`/devices/${CONNECTED_DEVICE.id}/permanent`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      });

      // A non-Error throw must not escape the handler either.
      expect(res.status).toBe(200);
      const { captureException } = await import('../../services/sentry');
      expect(captureException).toHaveBeenCalledWith(nonError, expect.anything());
    } finally {
      consoleError.mockRestore();
    }
  });

  /**
   * A lock timeout must surface as a retryable 409 — and, since #3817, one that
   * reports `uninstallSent: false`, because the dispatch now happens strictly
   * after the commit and this path never reached it.
   *
   * The error shape here is not invented. It is what a REAL lock timeout
   * produces: verified against live Postgres with two connections contending on
   * one row, the error arrives as `{ code: undefined, cause: { code: '55P03' } }`,
   * because Drizzle wraps the postgres-js PostgresError. The route used to read
   * the top-level `.code`, so this branch was dead and the operator got a bare
   * 500. Assert the WRAPPED shape specifically — an unwrapped
   * `{ code: '55P03' }` fixture would pass against that broken code and prove
   * nothing.
   *
   * Uses an ONLINE device, so the dispatch is one ordering mistake away from
   * firing. On the offline fixture `uninstallSent` can only ever be false and
   * this test would pass against the very regression it exists to catch.
   */
  it('does not dispatch SELF_UNINSTALL when the cascade fails with 55P03 (#3817)', async () => {
    rigDeviceLookup(CONNECTED_DEVICE);
    rigAgentOnlineAndSendable();
    vi.mocked(db.transaction).mockImplementation(async () => {
      throw Object.assign(new Error('Failed query: SELECT id FROM devices ... FOR UPDATE'), {
        cause: Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
      });
    });

    const res = await app.request(`/devices/${CONNECTED_DEVICE.id}/permanent`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(409);
    // The load-bearing half: nothing irreversible happened, so a retry is a
    // plain retry rather than damage control.
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    const body = await res.json() as { error: string; uninstallSent: boolean };
    expect(body.uninstallSent).toBe(false);
    expect(body.error).toMatch(/try again/i);
    // The pre-#3817 message disclosed an uninstall that had already gone out.
    // Keeping that text now would tell the operator their agent may be gone
    // when it demonstrably is not.
    expect(body.error).not.toMatch(/already sent/i);
  });

  /**
   * The 23503 branch had NEVER executed before the SQLSTATE unwrap — the
   * top-level `.code` read meant it was unreachable. It gets the same
   * online-agent coverage as 55P03: it is a rollback path, so post-#3817 the
   * uninstall must not have been dispatched.
   */
  it('does not dispatch SELF_UNINSTALL when the cascade fails with 23503 (#3817)', async () => {
    rigDeviceLookup(CONNECTED_DEVICE);
    rigAgentOnlineAndSendable();
    vi.mocked(db.transaction).mockImplementation(async () => {
      throw Object.assign(new Error('Failed query: DELETE FROM devices'), {
        cause: Object.assign(new Error('update or delete violates foreign key constraint'), {
          code: '23503',
          detail: 'Key (id)=(...) is still referenced from table "some_child".',
          table_name: 'some_child',
        }),
      });
    });

    const res = await app.request(`/devices/${CONNECTED_DEVICE.id}/permanent`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(409);
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    const body = await res.json() as { error: string; uninstallSent: boolean };
    expect(body.uninstallSent).toBe(false);
    // table_name must come off the SAME node as the code, or this reads
    // "related records in undefined".
    expect(body.error).toContain('some_child');
    expect(body.error).not.toMatch(/already sent/i);
  });

  /**
   * #3952 was a 23514 check violation, which is NOT one of the two mapped
   * SQLSTATEs — it took the generic rethrow. That path must stay a 500 (a
   * cascade defect is not user-retryable, so a 409 would advertise a retry
   * that fails identically forever), but it must not take the diagnosis down
   * with it: the global onError logs a bare `Error:` with no deviceId, and in
   * production returns a sanitized body, so without a log here there is no
   * server-side record of which device failed to delete. That breadcrumb is
   * precisely what the original report was missing.
   *
   * Post-#3817 the log must read `uninstallSent=false` on this path: it is a
   * rollback, so the dispatch below the transaction never ran. A `true` here
   * would mean the irreversible command escaped a failed delete again.
   */
  it('logs deviceId and uninstallSent=false before rethrowing an unmapped SQLSTATE (#3952, #3817)', async () => {
    rigDeviceLookup(CONNECTED_DEVICE);
    rigAgentOnlineAndSendable();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(db.transaction).mockImplementation(async () => {
      throw Object.assign(new Error('Failed query: UPDATE discovered_assets'), {
        cause: Object.assign(
          new Error('new row for relation "discovered_assets" violates check constraint'),
          { code: '23514', constraint_name: 'discovered_assets_link_source_requires_link' },
        ),
      });
    });

    try {
      const res = await app.request(`/devices/${CONNECTED_DEVICE.id}/permanent`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      });
      // Deliberately NOT mapped to a 409 — see the doc comment above.
      expect(res.status).toBe(500);

      const logged = consoleError.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('cascade delete'));
      expect(
        logged,
        `Expected one cascade-delete context log.\nconsole.error calls: ${JSON.stringify(consoleError.mock.calls.map((c) => String(c[0])))}`
      ).toHaveLength(1);
      // The three facts that make the line worth having: which device, whether
      // the irreversible uninstall went out, and which SQLSTATE.
      expect(logged[0]).toContain(CONNECTED_DEVICE.id);
      expect(logged[0]).toContain('uninstallSent=false');
      expect(logged[0]).toContain('23514');
      // And the command itself stayed put — the log is a record of that, not a
      // substitute for it.
      expect(sendCommandToAgent).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
