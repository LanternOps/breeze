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
  LinkGroupSiteAccessError: class LinkGroupSiteAccessError extends Error {},
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
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
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

  /**
   * State the LOCKED devices row reports back, i.e. what the route decides on.
   *
   * Since #2787 the permanent-delete route no longer trusts the pre-flight
   * `getDeviceWithOrgAndSiteCheck` copy for anything but authorisation:
   * `purgeRemovedDevice` re-reads status and link_group_id under
   * `SELECT ... FOR UPDATE`, so these knobs — not `rigDeviceLookup`'s fixture —
   * are what drive the eligibility branches.
   */
  interface DeleteTxOptions {
    /** Status the locked row reports. Default 'decommissioned' (eligible). */
    status?: string;
    /** link_group_id on the locked row. Default null (unlinked). */
    linkGroupId?: string | null;
    /** Serve a pending `device_remove` self_uninstall to the refusal probe. */
    pendingUninstall?: boolean;
    /** Lock returns zero rows (device vanished between lookup and lock). */
    deviceMissing?: boolean;
  }

  function rigDeleteTransaction(opts: DeleteTxOptions = {}): string[] {
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
            if (opts.deviceMissing) return pgResult([]);
            return pgResult([
              {
                id: DEVICE.id,
                status: opts.status ?? 'decommissioned',
                link_group_id: opts.linkGroupId ?? null,
              },
            ]);
          }
          // The purge refusal probe (deviceLifecycle.ts). Distinct from the
          // cascade's own `DELETE FROM device_commands` — only the probe names
          // the self_uninstall type.
          if (text.includes('self_uninstall')) {
            return opts.pendingUninstall ? pgResult([{ id: 'cmd-1' }]) : pgResult([]);
          }
          return pgResult([]);
        }),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      };
      // Return, do not swallow: the route reads `linkGroupDissolved` off the
      // transaction's resolved value now that purgeRemovedDevice owns it.
      return cb(tx);
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
    // Read from the LOCKED row since #2787, not from the pre-flight lookup —
    // the lookup's copy predates the lock and can be stale.
    rigDeleteTransaction({ linkGroupId: 'grp-multiboot-1' });

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

  /**
   * #2787 review — the audit spread was keyed on the PRE-LOCK
   * `device.linkGroupId` from `getDeviceWithOrgAndSiteCheck`, while
   * `linkGroupDissolved` came from the locked row. When those disagree (a
   * device linked between the pre-flight read and the lock) the dissolve runs
   * and the audit records NOTHING about it — and dissolving a group unlinks
   * SIBLING devices that were never in this request, so "why did this whole VM
   * group un-group?" becomes unanswerable.
   *
   * Both facts must come off the same read: the locked one.
   */
  it('audits the link group read UNDER THE LOCK, not the stale pre-flight copy (#2787)', async () => {
    const { dissolveLinkGroupIfBelowMinimum } = await import('../../services/deviceLinkGroups');
    vi.mocked(dissolveLinkGroupIfBelowMinimum).mockResolvedValue(true);
    // Pre-flight sees an UNLINKED device...
    rigDeviceLookup({ ...DEVICE, linkGroupId: null });
    // ...but under the lock it is in a group, and the dissolve fires.
    rigDeleteTransaction({ linkGroupId: 'grp-late-link' });

    const res = await app.request(`/devices/${DEVICE.id}/permanent`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(dissolveLinkGroupIfBelowMinimum).toHaveBeenCalledTimes(1);
    expect(await auditDetails()).toMatchObject({
      linkGroupId: 'grp-late-link',
      linkGroupDissolved: true,
    });
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

  /**
   * Wave 05 (#5023 follow-up, #2787) — the cascade must run in a SYSTEM DB
   * context, matching `jobs/deviceBulkPurge.ts`'s `purgeOne`. Today the route
   * runs `purgeRemovedDevice` under the caller's tenant RLS context, and
   * `services/deviceDeletion.ts` documents that at least one cascade table is
   * deliberately invisible under tenant policy — so a single permanent delete
   * can strand rows that bulk purge removes.
   *
   * `runOutsideDbContext` must run FIRST (CLAUDE.md's DB context helpers
   * contract): the route is already inside the request's `withDbAccessContext`
   * transaction, and escalating without first exiting it would hold two
   * pooled connections at once.
   *
   * Authorisation must stay exactly where it is: `getDeviceWithOrgAndSiteCheck`
   * (the `db.select` chokepoint) and the decommissioned pre-check both run
   * BEFORE the escalation, so a caller who fails either check never reaches a
   * system-scoped connection at all.
   */
  describe('escalates the cascade to a system DB context (#5023 wave 05)', () => {
    it('calls runOutsideDbContext and withSystemDbAccessContext exactly once on a successful purge, after the chokepoint lookup', async () => {
      rigDeviceLookup(DEVICE);
      rigDeleteTransaction();

      const res = await app.request(`/devices/${DEVICE.id}/permanent`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      });

      expect(res.status).toBe(200);
      expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
      expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);

      // Ordering: the chokepoint's authorisation read must resolve BEFORE the
      // escalation opens — authorised first, matching the bulk worker.
      const selectOrder = vi.mocked(db.select).mock.invocationCallOrder[0];
      const escalateOrder = vi.mocked(runOutsideDbContext).mock.invocationCallOrder[0];
      expect(selectOrder).toBeDefined();
      expect(escalateOrder).toBeDefined();
      expect(selectOrder!).toBeLessThan(escalateOrder!);
    });

    it('does not escalate when the pre-check 400s (device not decommissioned)', async () => {
      rigDeviceLookup({ ...DEVICE, status: 'online' });

      const res = await app.request(`/devices/${DEVICE.id}/permanent`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      });

      expect(res.status).toBe(400);
      expect(runOutsideDbContext).not.toHaveBeenCalled();
      expect(withSystemDbAccessContext).not.toHaveBeenCalled();
    });

    it('does not escalate when the chokepoint 404s (device missing)', async () => {
      rigDeviceLookup(null);

      const res = await app.request(`/devices/${DEVICE.id}/permanent`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      });

      expect(res.status).toBe(404);
      expect(runOutsideDbContext).not.toHaveBeenCalled();
      expect(withSystemDbAccessContext).not.toHaveBeenCalled();
    });
  });

  // Still `decommissioned` — the route 400s anything else BEFORE it ever
  // reaches the transaction, so an 'online' status here would test the wrong
  // branch entirely. `agentId` is what the REMOVED fire-and-forget uninstall
  // needed, so the connected fixture is what makes its absence checkable.
  const CONNECTED_DEVICE = { ...DEVICE, agentId: 'agent-1' };

  /**
   * Rigs the agent as online AND the send as succeeding — i.e. a WS dispatch is
   * POSSIBLE. Named for that, not for "dispatched": every test below uses it
   * precisely to prove nothing was sent.
   */
  function rigAgentOnlineAndSendable() {
    vi.mocked(isAgentConnected).mockReturnValue(true);
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
   * #2787 — the best-effort WS `self_uninstall` this route used to fire after
   * the cascade committed is GONE, and its removal is the whole point of the
   * refusal below, so it needs a discriminating test of its own.
   *
   * Why it went: it only ever reached a CONNECTED agent, and a device reaching
   * permanent delete has been decommissioned — which force-closes the agent
   * socket — so in practice it almost never fired. When it did, it raced the
   * cascade that had just deleted the device's own `device_commands` rows. The
   * durable `device_remove` uninstall queued at Remove time (#3986) is the real
   * mechanism, and this route now REFUSES rather than destroying it.
   *
   * The online fixture is load-bearing: on an offline device `sendCommandToAgent`
   * could not fire regardless, and this test would pass against the very
   * regression it exists to catch.
   */
  it('never fires a WS self_uninstall, even with the agent connected (#2787)', async () => {
    rigDeviceLookup(CONNECTED_DEVICE);
    rigAgentOnlineAndSendable();
    rigDeleteTransaction();

    const res = await app.request(`/devices/${CONNECTED_DEVICE.id}/permanent`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    // `isAgentConnected` asserts the process role and throws in the worker
    // role, so the route must not so much as probe it any more.
    expect(isAgentConnected).not.toHaveBeenCalled();

    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ success: true });
    // The removed fields must not linger as `false`/undefined shells — a
    // consumer reading `agentUninstallSent` should fail loudly, not read a
    // fabricated "we tried".
    expect(body).not.toHaveProperty('agentUninstallSent');
    expect(body).not.toHaveProperty('warning');
    expect(await auditDetails()).not.toHaveProperty('uninstallCommandSent');
  });

  /**
   * The refusal that replaces it. `device_commands` is in the device cascade,
   * so purging a device whose `device_remove` uninstall is still collectable
   * destroys the only thing that will ever clean the endpoint — a zombie agent
   * nobody can see or reach. 409 + code so the web can say why.
   */
  it('refuses with 409 UNINSTALL_PENDING while a device_remove uninstall is queued (#2787)', async () => {
    rigDeviceLookup(CONNECTED_DEVICE);
    const statements = rigDeleteTransaction({ pendingUninstall: true });

    const res = await app.request(`/devices/${CONNECTED_DEVICE.id}/permanent`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'UNINSTALL_PENDING' });
    // Nothing was destroyed: the refusal has to happen before the cascade, not
    // be reported after it.
    expect(statements.some((s) => s.startsWith('DELETE FROM devices'))).toBe(false);
    expect(statements.some((s) => s.startsWith('DELETE FROM device_commands'))).toBe(false);
  });

  /**
   * The TOCTOU this wave closes. The pre-flight status check runs OUTSIDE the
   * deletion transaction; a Restore committing between it and the cascade used
   * to be purged silently. `purgeRemovedDevice` re-reads status under the row
   * lock, so the loser of that race gets a 409 instead of a dead device.
   */
  it('refuses with 409 NOT_REMOVED when a Restore won the race under the lock (#2787)', async () => {
    rigDeviceLookup(DEVICE); // still 'decommissioned' at pre-flight...
    const statements = rigDeleteTransaction({ status: 'offline' }); // ...but not under the lock

    const res = await app.request(`/devices/${DEVICE.id}/permanent`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'NOT_REMOVED' });
    expect(statements.some((s) => s.startsWith('DELETE FROM devices'))).toBe(false);
  });

  it('returns 404 when the device vanished between the lookup and the lock (#2787)', async () => {
    rigDeviceLookup(DEVICE);
    rigDeleteTransaction({ deviceMissing: true });

    const res = await app.request(`/devices/${DEVICE.id}/permanent`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  /**
   * A lock timeout must surface as a retryable 409.
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
   * Uses an ONLINE device so that a reintroduced WS dispatch on the rollback
   * path would actually be able to fire; on the offline fixture this test
   * would pass against the very regression it exists to catch.
   */
  it('fails fast with a retryable 409 and sends nothing when the cascade hits 55P03', async () => {
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
    const body = await res.json() as { error: string };
    expect(body).not.toHaveProperty('uninstallSent');
    expect(body.error).toMatch(/try again/i);
    // The pre-#3817 message disclosed an uninstall that had already gone out.
    // Keeping that text now would tell the operator their agent may be gone
    // when it demonstrably is not.
    expect(body.error).not.toMatch(/already sent/i);
  });

  /**
   * The 23503 branch had NEVER executed before the SQLSTATE unwrap — the
   * top-level `.code` read meant it was unreachable. It gets the same
   * online-agent coverage as 55P03.
   */
  it('reports the offending table with a 409 and sends nothing when the cascade hits 23503', async () => {
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
    const body = await res.json() as { error: string };
    expect(body).not.toHaveProperty('uninstallSent');
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
   */
  it('logs the deviceId and SQLSTATE before rethrowing an unmapped error (#3952)', async () => {
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
      // The two facts that make the line worth having: which device, and which
      // SQLSTATE. Without them the global onError logs a bare `Error:` with no
      // deviceId and, in production, returns a sanitized body.
      expect(logged[0]).toContain(CONNECTED_DEVICE.id);
      expect(logged[0]).toContain('23514');
      expect(sendCommandToAgent).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
