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

import * as schema from '../../db/schema';
import {
  coreRoutes,
  DEVICE_CASCADE_DELETE_TABLES,
  DEVICE_DETACH_DEVICE_ID_TABLES,
  DEVICE_LINKED_DEVICE_ID_TABLES,
} from './core';
import { db } from '../../db';

/**
 * Tables that have a column named `device_id` but it does NOT reference devices.id.
 * Add a table here only when its device_id FK points to a different table.
 */
const NOT_DEVICES_FK: ReadonlySet<string> = new Set([
  'mobile_devices',        // device_id is a varchar identifier, not a FK to devices
  'snmp_alert_thresholds', // device_id → snmp_devices.id
  'snmp_metrics',          // device_id → snmp_devices.id
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
    const cascadeSet = new Set<string>(DEVICE_CASCADE_DELETE_TABLES);
    const detachSet = new Set<string>(DEVICE_DETACH_DEVICE_ID_TABLES);
    const linkedSet = new Set<string>(DEVICE_LINKED_DEVICE_ID_TABLES);

    const problems: string[] = [];

    for (const table of allSchemaTables()) {
      const tableName = getTableName(table);
      if (NOT_DEVICES_FK.has(tableName)) continue;

      const hasDeviceId = getTableColumns(table).some((col) => col.name === 'device_id');
      if (!hasDeviceId) continue;

      const memberships = [
        cascadeSet.has(tableName) ? 'DEVICE_CASCADE_DELETE_TABLES' : null,
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
        `DEVICE_CASCADE_DELETE_TABLES (rows deleted; order matters — children before parents), ` +
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
    expect(DEVICE_CASCADE_DELETE_TABLES).not.toContain('tickets');
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
      `These tables are in DEVICE_CASCADE_DELETE_TABLES but no longer exist in the schema. Remove them.`
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
          statements.push(sqlToText(q));
          return [];
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
});
