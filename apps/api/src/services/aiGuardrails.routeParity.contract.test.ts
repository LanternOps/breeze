/**
 * Tool-vs-route permission parity, asserted against role grants.
 *
 * Principle: a tool must require EXACTLY what its equivalent HTTP route
 * requires — never less. These cases are the ones the 2026-09-17 AI tool
 * SITE/ROLE audit (§2.4, §2.5) found weaker than their route, two of them
 * exploitable by a role that ships in `db/seed.ts`.
 *
 * Static and DB-free: `requiredPermissionsForTool` is the same resolution
 * `checkToolPermission` performs, and `permissionGrantMatches` is the same
 * comparison `hasPermission` performs, so evaluating the former against a
 * grant list reproduces the real decision without a database.
 */
import { describe, it, expect } from 'vitest';
import { requiredPermissionsForTool } from './aiGuardrails';
import { permissionGrantMatches } from './permissionMatching';
import { SYSTEM_ROLES } from '../db/seed';

function grantsOf(roleName: string): { resource: string; action: string }[] {
  const role = SYSTEM_ROLES.find((r) => r.name === roleName);
  if (!role) throw new Error(`seeded role "${roleName}" not found`);
  return role.permissions.map((p) => {
    const [resource, action] = p.split(':');
    return { resource: resource!, action: action! };
  });
}

function parseGrants(specs: string[]): { resource: string; action: string }[] {
  return specs.map((p) => {
    const [resource, action] = p.split(':');
    return { resource: resource!, action: action! };
  });
}

/** Mirrors checkToolPermission: resolve requirements, then require ALL of them. */
function allows(
  grants: { resource: string; action: string }[],
  tool: string,
  input: Record<string, unknown> = {},
): boolean {
  const required = requiredPermissionsForTool(tool, input);
  // null = no mapping = nobody is eligible (fail closed).
  if (!required) return false;
  return required.every((req) => grants.some((g) => permissionGrantMatches(g, req.resource, req.action)));
}

const ORG_TECHNICIAN = grantsOf('Org Technician');

describe('seeded Org Technician is not the ceiling for backup/vault/report tools', () => {
  // The seeded grants this whole suite turns on. If seed.ts changes these, the
  // exploitability claims below change with it — pin them.
  it('holds devices:* and reports:read|write but no organizations:*, backup:* or reports:export', () => {
    const flat = ORG_TECHNICIAN.map((g) => `${g.resource}:${g.action}`);
    expect(flat).toContain('devices:execute');
    expect(flat).toContain('reports:write');
    expect(flat).toContain('remote:access');
    expect(flat).not.toContain('reports:export');
    expect(flat.some((g) => g.startsWith('organizations:'))).toBe(false);
    expect(flat.some((g) => g.startsWith('backup:'))).toBe(false);
  });

  // §2.5 — generate_report `generate` vs routes/reports/generate.ts:24 (REPORTS_EXPORT).
  it('cannot run generate_report `generate` (route requires reports:export)', () => {
    expect(allows(ORG_TECHNICIAN, 'generate_report', { action: 'generate' })).toBe(false);
  });
  it('can still run the report read actions it legitimately holds', () => {
    expect(allows(ORG_TECHNICIAN, 'generate_report', { action: 'list' })).toBe(true);
    expect(allows(ORG_TECHNICIAN, 'generate_report', { action: 'download' })).toBe(true);
  });
  it('a role holding reports:export may generate', () => {
    expect(allows(parseGrants(['reports:read', 'reports:export']), 'generate_report', { action: 'generate' })).toBe(true);
  });

  // §2.5 — vault cluster vs routes/backup/vault.ts:100/371 (ORGS_READ) and 135/186/231 (ORGS_WRITE).
  it.each(['query_vaults', 'get_vault_status'])('cannot read %s (route requires organizations:read)', (tool) => {
    expect(allows(ORG_TECHNICIAN, tool)).toBe(false);
  });
  it('cannot run configure_vault (route requires organizations:write) — this one WRITES', () => {
    expect(allows(ORG_TECHNICIAN, 'configure_vault')).toBe(false);
  });
  it('a role holding organizations:read may read vaults; organizations:write is needed to configure', () => {
    const reader = parseGrants(['organizations:read']);
    expect(allows(reader, 'query_vaults')).toBe(true);
    expect(allows(reader, 'get_vault_status')).toBe(true);
    expect(allows(reader, 'configure_vault')).toBe(false);
    expect(allows(parseGrants(['organizations:write']), 'configure_vault')).toBe(true);
  });

  // §2.5 — backup / hyperv / mssql reads.
  it.each([
    // tool, the route's permission, route evidence
    ['query_backups', 'organizations:read'], // routes/backup/jobs.ts:61
    ['browse_snapshots', 'backup:read'], // routes/backup/snapshots.ts:273
    ['get_vm_restore_estimate', 'backup:read'], // routes/backup/vmrestore.ts:501
    ['query_hyperv_vms', 'organizations:read'], // routes/backup/hyperv.ts:52
    ['get_hyperv_vm_details', 'organizations:read'], // routes/backup/hyperv.ts:94
    ['query_mssql_instances', 'organizations:read'], // routes/backup/mssql.ts:67
    ['get_mssql_backup_status', 'organizations:read'], // routes/backup/mssql.ts:94
  ])('%s is denied to Org Technician and allowed only with %s', (tool, grant) => {
    expect(allows(ORG_TECHNICIAN, tool)).toBe(false);
    expect(allows(parseGrants([grant]), tool)).toBe(true);
  });
});

describe('remote-access tools carry the remote:access gate their router applies', () => {
  // routes/remote/index.ts:16 — `remoteRoutes.use('*', requirePermission(REMOTE_ACCESS…), requireMfa())`
  // applies to every child router, including sessions.ts.
  it.each(['create_remote_session', 'list_remote_sessions', 'computer_control'])(
    '%s is denied to a role with device grants but no remote:access',
    (tool) => {
      expect(allows(parseGrants(['devices:read', 'devices:write', 'devices:execute']), tool)).toBe(false);
    },
  );
  it('the seeded Org Technician, which does hold remote:access, keeps working', () => {
    expect(allows(ORG_TECHNICIAN, 'create_remote_session')).toBe(true);
    expect(allows(ORG_TECHNICIAN, 'list_remote_sessions')).toBe(true);
    expect(allows(ORG_TECHNICIAN, 'computer_control')).toBe(true);
  });
  it('remote:access alone is not enough — the device-side grant is still required', () => {
    expect(allows(parseGrants(['remote:access']), 'create_remote_session')).toBe(false);
    expect(allows(parseGrants(['remote:access']), 'list_remote_sessions')).toBe(false);
  });
});

describe('manage_tickets move_org requires BOTH permissions its route requires', () => {
  // routes/tickets/moveOrg.ts:21-23 — tickets:write AND organizations:write.
  it('a tickets:write role without organizations:write is denied', () => {
    expect(allows(parseGrants(['tickets:read', 'tickets:write', 'tickets:manage']), 'manage_tickets', { action: 'move_org' })).toBe(false);
  });
  it('a role holding both is allowed', () => {
    expect(allows(parseGrants(['tickets:write', 'organizations:write']), 'manage_tickets', { action: 'move_org' })).toBe(true);
  });
  it('the extra permission does not leak onto the other manage_tickets actions', () => {
    expect(allows(parseGrants(['tickets:write']), 'manage_tickets', { action: 'comment' })).toBe(true);
  });
});

describe('registry_operations reads are agent executions, not device reads (§2.4, SR5-01 precedent)', () => {
  // routes/devices/commands.ts:49 — DEVICES_EXECUTE + requireMfa(); the handler
  // dispatches a real agent command via aiExecuteCommand.
  it.each(['read_key', 'get_value'])('%s is denied to a devices:read-only role', (action) => {
    expect(allows(parseGrants(['devices:read', 'devices:write']), 'registry_operations', { action })).toBe(false);
    expect(allows(grantsOf('Org Viewer'), 'registry_operations', { action })).toBe(false);
  });
  it.each(['read_key', 'get_value'])('%s is allowed with devices:execute', (action) => {
    expect(allows(parseGrants(['devices:execute']), 'registry_operations', { action })).toBe(true);
  });
  it('matches the SR5-01 treatment of file_operations list/read exactly', () => {
    const readOnly = parseGrants(['devices:read', 'devices:write']);
    expect(allows(readOnly, 'file_operations', { action: 'list' })).toBe(false);
    expect(allows(readOnly, 'file_operations', { action: 'read' })).toBe(false);
    expect(allows(readOnly, 'registry_operations', { action: 'read_key' })).toBe(false);
  });
});
