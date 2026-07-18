import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Action intents migration', () => {
  const migrationPath = join(__dirname, '../../migrations/2026-07-18-action-intents.sql');
  const sql = readFileSync(migrationPath, 'utf8');

  it('is idempotent: only IF NOT EXISTS / IF EXISTS / DO-guarded DDL', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS action_intents/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS intent_outbox/i);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS action_intents_org_idem_uniq/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS action_intents_org_status_idx/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS intent_outbox_unpublished_idx/i);
    expect(sql).toMatch(/ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS intent_id/i);
    expect(sql).toMatch(
      /ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS bound_argument_digest/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_one_source_chk/i,
    );
    expect(sql).toMatch(/DROP POLICY IF EXISTS breeze_org_isolation_select ON action_intents/i);
  });

  it('never calls gen_random_bytes and never opens an inner transaction', () => {
    expect(sql).not.toMatch(/gen_random_bytes\(/i);
    expect(sql).not.toMatch(/^\s*BEGIN;/im);
    expect(sql).not.toMatch(/^\s*COMMIT;/im);
    expect(sql).toMatch(/gen_random_uuid\(\)/);
  });

  it('uses gen_random_uuid() (pgcrypto-free) for the PK default', () => {
    expect(sql).toMatch(/id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
  });

  it('declares the immutability trigger over exactly the content columns', () => {
    expect(sql).toMatch(/action_intents_block_content_update/);
    expect(sql).toMatch(/action_intents_immutable_trg/);
    expect(sql).toMatch(/RAISE EXCEPTION 'action_intents content is immutable'/);
    // Lifecycle columns must NOT appear in the immutability check.
    const triggerBody = sql.slice(
      sql.indexOf('action_intents_block_content_update() RETURNS trigger'),
      sql.indexOf('END $$ LANGUAGE plpgsql;'),
    );
    for (const lifecycleCol of ['status', 'decided_at', 'executed_at', 'result', 'error_code']) {
      expect(triggerBody).not.toMatch(new RegExp(`NEW\\.${lifecycleCol}\\b`));
    }
  });

  it('enables and forces RLS on action_intents with breeze_has_org_access policies', () => {
    expect(sql).toMatch(/ALTER TABLE action_intents ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE action_intents FORCE ROW LEVEL SECURITY/);
    const selectPolicyMatches = sql.match(
      /CREATE POLICY breeze_org_isolation_select ON action_intents[\s\S]*?breeze_has_org_access\(org_id\)/,
    );
    expect(selectPolicyMatches).not.toBeNull();
    for (const cmd of ['insert', 'update', 'delete']) {
      expect(sql.toLowerCase()).toMatch(
        new RegExp(`create policy breeze_org_isolation_${cmd} on action_intents`),
      );
    }
  });

  it('forces RLS on intent_outbox with no permissive policies (system-scoped)', () => {
    expect(sql).toMatch(/ALTER TABLE intent_outbox ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE intent_outbox FORCE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/CREATE POLICY[^\n]*ON intent_outbox/i);
  });

  it('cascades intent_outbox and approval_requests.intent_id from action_intents', () => {
    expect(sql).toMatch(
      /intent_id UUID NOT NULL REFERENCES action_intents\(id\) ON DELETE CASCADE/,
    );
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS intent_id UUID\s+REFERENCES action_intents\(id\) ON DELETE CASCADE/,
    );
  });

  it('enforces at most one source link on approval_requests, permitting all-NULL', () => {
    expect(sql).toMatch(/CONSTRAINT approval_requests_one_source_chk/);
    expect(sql).toMatch(/<=\s*1/);
  });

  it('enforces exactly one actor on action_intents', () => {
    expect(sql).toMatch(/CONSTRAINT action_intents_one_actor_chk/);
    expect(sql).toMatch(
      /CHECK \(\(requested_by_user_id IS NULL\) <> \(requesting_api_key_id IS NULL\)\)/,
    );
  });

  it('declares the source/status/event_type CHECK-constrained value lists exactly as spec\'d', () => {
    expect(sql).toMatch(/source TEXT NOT NULL CHECK \(source IN \('chat','mcp_api'\)\)/);
    expect(sql).toMatch(
      /status TEXT NOT NULL DEFAULT 'pending_approval'\s+CHECK \(status IN \('pending_approval','approved','executing','completed','failed','rejected','expired','cancelled'\)\)/,
    );
    expect(sql).toMatch(
      /event_type TEXT NOT NULL CHECK \(event_type IN \('intent_created','intent_approved'\)\)/,
    );
  });
});
