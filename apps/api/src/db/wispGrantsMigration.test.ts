import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { analyzeMigrationDml } from './migrationRlsScope';

const FILE = path.resolve(__dirname, '../../migrations/2027-01-04-100100-wisp-grants.sql');

/**
 * Wisp W02 (Wisp design §4.2): static contract for the grants DDL. The
 * functional forge / ownership proof is wispGrantsRls.integration.test.ts.
 */
describe('2027-01-04-100100-wisp-grants.sql', () => {
  const sql = readFileSync(FILE, 'utf8');

  it('exists and has no inner transaction', () => {
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });

  it('enables + forces RLS on both tables in the creating file', () => {
    for (const t of ['wisp_grants', 'wisp_grant_revisions']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
      expect(sql).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    }
  });

  it('makes the org composite FK deferrable', () => {
    expect(sql).toMatch(/wisp_grants_org_partner_fk[\s\S]*?REFERENCES organizations \(id, partner_id\)[\s\S]*?DEFERRABLE INITIALLY IMMEDIATE/);
  });

  it('binds the grantor to the anchor partner with a composite users FK', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS users_id_partner_id_key ON users (id, partner_id)');
    expect(sql).toMatch(/wisp_grants_grantor_partner_fk[\s\S]*?REFERENCES users \(id, partner_id\)/);
  });

  it('uses text + CHECK for status, never an enum', () => {
    expect(sql).not.toMatch(/CREATE TYPE/i);
    expect(sql).toMatch(/status IN \('active','paused','revoked','expired'\)/);
  });

  it('lists the user_paused and partner_disabled pause reasons (w00 A29, A35)', () => {
    expect(sql).toMatch(/paused_reason IN \([^)]*'user_paused'[^)]*\)/);
    expect(sql).toMatch(/paused_reason IN \([^)]*'partner_disabled'[^)]*\)/);
  });

  it('enforces one live grant per (grantor, partner, scope)', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS wisp_grants_one_live_per_scope_uq[\s\S]*?WHERE status IN \('active','paused'\)/);
  });

  it('guards admin updates and revision immutability with triggers', () => {
    expect(sql).toContain('CREATE TRIGGER wisp_grants_update_guard BEFORE UPDATE ON wisp_grants');
    expect(sql).toMatch(/CREATE TRIGGER wisp_grant_revisions_immutable_guard BEFORE UPDATE OR DELETE ON wisp_grant_revisions/);
    expect(sql).toContain('CREATE TRIGGER wisp_grants_delete_guard BEFORE DELETE ON wisp_grants');
  });

  it('adds grant columns to runs and tasks with both-or-none checks', () => {
    for (const t of ['ai_agent_runs', 'ai_operator_tasks']) {
      expect(sql).toContain(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS grant_id uuid`);
      expect(sql).toContain(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS grant_revision_id uuid`);
      expect(sql).toContain(`${t}_grant_link_chk`);
      expect(sql).toMatch(new RegExp(`${t}_grant_revision_fk[\\s\\S]*?REFERENCES wisp_grant_revisions \\(id, grant_id\\) ON DELETE SET NULL;`));
      expect(sql).toMatch(new RegExp(`${t}_grant_fk[\\s\\S]*?REFERENCES wisp_grants \\(id\\) ON DELETE RESTRICT;`));
    }
  });

  it('binds a pinned grant to the run/task tenant (no partner_id column, so a trigger)', () => {
    for (const t of ['ai_agent_runs', 'ai_operator_tasks']) {
      expect(sql).toContain(`CREATE TRIGGER ${t}_grant_tenant_guard BEFORE INSERT OR UPDATE OF grant_id, grant_revision_id, org_id ON ${t}`);
    }
    expect(sql).toMatch(/JOIN organizations o ON o\.partner_id = g\.partner_id[\s\S]*?g\.org_id IS NULL OR g\.org_id = NEW\.org_id/);
  });

  it('writes no rows, so it needs no system-scope election', () => {
    expect(analyzeMigrationDml(sql)).toEqual([]);
  });

  it('grants breeze_app no UPDATE/DELETE on revisions (append-only)', () => {
    expect(sql).toContain('GRANT SELECT, INSERT ON wisp_grant_revisions TO breeze_app');
    expect(sql).not.toMatch(/GRANT[^;]*(UPDATE|DELETE)[^;]*ON wisp_grant_revisions/);
  });
});
