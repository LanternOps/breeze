import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) =>
  readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
const TABLES_MIGRATION = '2026-10-26-140000-caller-verification-tables.sql';

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
});
