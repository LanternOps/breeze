import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { ensureClusterRoles } from './ensureClusterRoles';

// Paths the shared integration database cannot reach without dropping
// cluster-wide roles other suites depend on (#11929): a role that does not
// exist at all, a CREATE ROLE that fails, and a database with every
// breeze_app policy gone. The real-Postgres coverage is
// clusterRolesRestore.integration.test.ts.

interface FakeDb {
  roles: string[];
  member?: boolean;
  appPolicies?: number;
  failOn?: { pattern: RegExp; code: string; message?: string };
}

function fakeClient(db: FakeDb) {
  const statements: string[] = [];
  const query = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('FROM pg_roles WHERE rolname = ANY')) return db.roles.map((rolname) => ({ rolname }));
    if (text.includes('pg_has_role')) return [{ member: db.member ?? false }];
    if (text.includes('FROM pg_policies WHERE')) return [{ n: db.appPolicies ?? 50 }];
    return []; // missing-privilege scans: nothing missing
  };
  const tx = {
    unsafe: async (statement: string) => {
      statements.push(statement);
      if (db.failOn?.pattern.test(statement)) {
        throw Object.assign(new Error(db.failOn.message ?? 'permission denied to create role'), { code: db.failOn.code });
      }
      return [];
    },
  };
  const client = Object.assign(query, {
    begin: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
  }) as unknown as postgres.Sql;
  return { client, statements: () => statements.filter((s) => !s.includes('createrole_self_grant')) };
}

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

describe('ensureClusterRoles', () => {
  it('creates missing roles with the migrations\' attributes, then grants the membership', async () => {
    const { client, statements } = fakeClient({ roles: ['breeze_app'] });
    const report = await ensureClusterRoles(client, { phase: 'pre-migration', env: {}, logger: quiet });
    expect(statements()).toEqual([
      'CREATE ROLE breeze_audit_admin NOLOGIN;',
      'CREATE ROLE breeze_search NOLOGIN;',
      'GRANT breeze_audit_admin TO breeze_app;',
    ]);
    expect(report.warnings).toEqual([]);
  });

  it('turns a refused CREATE ROLE into a warning with the statement, skips what depends on it, and does not throw', async () => {
    const { client, statements } = fakeClient({
      roles: ['breeze_app'],
      failOn: { pattern: /CREATE ROLE breeze_audit_admin/, code: '42501' },
    });
    const report = await ensureClusterRoles(client, { phase: 'post-migration', env: {}, logger: quiet });
    expect(statements()).not.toContain('GRANT breeze_audit_admin TO breeze_app;');
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('SQLSTATE 42501');
    expect(report.warnings[0]).toContain('Run as a database superuser:\nCREATE ROLE breeze_audit_admin NOLOGIN;');
  });

  it('reports a non-privilege failure as an error, without the superuser advice', async () => {
    const { client } = fakeClient({
      roles: ['breeze_app', 'breeze_audit_admin', 'breeze_search'],
      failOn: { pattern: /GRANT breeze_audit_admin/, code: '25006', message: 'cannot execute GRANT ROLE in a read-only transaction' },
    });
    const errors: string[] = [];
    const report = await ensureClusterRoles(client, {
      phase: 'pre-migration',
      env: {},
      logger: { ...quiet, error: (m) => errors.push(m) },
    });
    expect(errors).toHaveLength(1);
    expect(report.warnings[0]).toContain('SQLSTATE 25006');
    expect(report.warnings[0]).not.toContain('superuser');
  });

  it('leaves the membership alone when AUDIT_ADMIN_DATABASE_URL is set', async () => {
    const { client, statements } = fakeClient({ roles: ['breeze_app', 'breeze_audit_admin', 'breeze_search'] });
    await ensureClusterRoles(client, {
      phase: 'pre-migration',
      env: { AUDIT_ADMIN_DATABASE_URL: 'postgresql://breeze_audit_admin:x@db/breeze' },
      logger: quiet,
    });
    expect(statements()).toEqual([]);
  });

  it('says when every breeze_app RLS policy is gone, which boot cannot repair', async () => {
    const { client } = fakeClient({ roles: ['breeze_app', 'breeze_audit_admin', 'breeze_search'], member: true, appPolicies: 0 });
    const errors: string[] = [];
    const report = await ensureClusterRoles(client, {
      phase: 'post-migration',
      env: {},
      logger: { ...quiet, error: (m) => errors.push(m) },
    });
    expect(errors).toHaveLength(1);
    expect(report.warnings[0]).toContain('no row-level security policies for breeze_app');
  });

  it('runs the policy check only after migrations', async () => {
    const { client } = fakeClient({ roles: ['breeze_app', 'breeze_audit_admin', 'breeze_search'], member: true, appPolicies: 0 });
    const report = await ensureClusterRoles(client, { phase: 'pre-migration', env: {}, logger: quiet });
    expect(report).toEqual({ applied: [], warnings: [] });
  });
});
