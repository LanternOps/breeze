import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) =>
  readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
const TABLES_MIGRATION = '2026-10-26-140000-caller-verification-tables.sql';
const POLICIES_MIGRATION = '2026-10-26-140100-caller-verification-policies.sql';
const BACKFILL_MIGRATION = '2026-10-26-140200-caller-verification-destinations-backfill.sql';

describe('caller verification migration', () => {
  it('uses column-specific nullable references and deferrable ownership', () => {
    const s = read(TABLES_MIGRATION);
    for (const col of ['requester_binding_id', 'target_binding_id', 'destination_id']) {
      expect(s).toContain(`ON DELETE SET NULL (${col}) DEFERRABLE INITIALLY IMMEDIATE`);
    }
    expect(s).not.toMatch(/\b(device_id|ticket_id)\s+uuid/i);
    expect(s).toContain('WHERE revoked_at IS NULL');
    expect(s).toContain("WHERE status='verified' AND consumed_at IS NULL");
    expect(s).toContain('FORCE ROW LEVEL SECURITY');
  });

  it('separates partner read from write authority and elects scope before backfill', () => {
    const p = read(POLICIES_MIGRATION);
    expect(p).toContain('FOR SELECT USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id())');
    expect(p).toContain('((org_id IS NULL) <> (partner_id IS NULL))');
    expect(p).not.toMatch(/required_tier_reset_password\s+smallint\s+NOT NULL/i);
    const b = read(BACKFILL_MIGRATION);
    const firstStatement = b.replace(/^(\s*--[^\n]*\n)+/, '').trimStart();
    expect(firstStatement.startsWith("SELECT set_config('breeze.scope','system',true);")).toBe(true);
    expect(b).toContain('RAISE WARNING');
  });
});
