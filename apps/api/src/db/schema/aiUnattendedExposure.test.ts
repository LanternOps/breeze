import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getTableColumns } from 'drizzle-orm';
import { aiUnattendedExposure, AI_UNATTENDED_EXPOSURE_SOURCES } from './aiUnattendedExposure';

describe('AI_UNATTENDED_EXPOSURE_SOURCES', () => {
  it('has exactly act and policy_intent', () => {
    expect(AI_UNATTENDED_EXPOSURE_SOURCES).toEqual(['act', 'policy_intent']);
  });

  it('matches the SQL CHECK constraint literals exactly', () => {
    const sqlPath = new URL(
      '../../../migrations/2026-09-16-ai-agents-policy-decide-foundations.sql',
      import.meta.url,
    );
    const sql = readFileSync(sqlPath, 'utf8');

    const check = /ai_unattended_exposure_source_chk\s+CHECK\s*\(\s*source\s+IN\s*\(([^)]*)\)\s*\)/i.exec(sql);
    const memberList = check?.[1];
    expect(memberList, 'ai_unattended_exposure_source_chk CHECK constraint not found in the migration').toBeDefined();

    const literals = (memberList ?? '')
      .split(',')
      .map((raw) => raw.trim())
      .filter((raw) => raw.length > 0)
      .map((raw) => {
        expect(raw, `CHECK member ${raw} is not a single-quoted literal`).toMatch(/^'[^']*'$/);
        return raw.slice(1, -1);
      });

    expect([...literals].sort()).toEqual([...AI_UNATTENDED_EXPOSURE_SOURCES].sort());
  });
});

describe('ai_unattended_exposure schema', () => {
  it('exposes exactly the ledger columns', () => {
    const cols = getTableColumns(aiUnattendedExposure);
    expect(Object.keys(cols).sort()).toEqual(
      ['id', 'orgId', 'partnerId', 'agentId', 'runId', 'deviceId', 'intentId', 'source', 'reservedAt'].sort(),
    );
  });

  it('requires org_id, partner_id, agent_id, run_id, device_id, and source', () => {
    const cols = getTableColumns(aiUnattendedExposure);
    expect(cols.orgId.notNull).toBe(true);
    expect(cols.partnerId.notNull).toBe(true);
    expect(cols.agentId.notNull).toBe(true);
    expect(cols.runId.notNull).toBe(true);
    expect(cols.deviceId.notNull).toBe(true);
    expect(cols.source.notNull).toBe(true);
  });

  it('leaves intent_id nullable (SET NULL on delete)', () => {
    const cols = getTableColumns(aiUnattendedExposure);
    expect(cols.intentId.notNull).toBe(false);
  });

  it('defaults reserved_at to now()', () => {
    const cols = getTableColumns(aiUnattendedExposure);
    expect(cols.reservedAt.notNull).toBe(true);
    expect(cols.reservedAt.hasDefault).toBe(true);
  });
});
