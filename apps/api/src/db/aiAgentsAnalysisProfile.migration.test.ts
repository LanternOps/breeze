import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_AGENT_RUN_PROFILES } from '@breeze/shared';

const FILE = '2026-10-16-190500-ai-analysis-profile-org-switch.sql';
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

/**
 * Execution plane W04 (#5715) — the TS tuple and the SQL CHECK are two copies
 * of one vocabulary, and this file is the NEWEST migration that redefines
 * `ai_agent_runs_profile_chk`, so it is where the live contract now lives (the
 * patch-profile migration's own suite froze its assertion to what it shipped —
 * a shipped migration is immutable). A profile added to `AI_AGENT_RUN_PROFILES`
 * without a new migration redefining this constraint ships as a runtime 23514
 * on the first admitted run of that profile.
 */
describe(`${FILE}`, () => {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, FILE), 'utf8');

  it('ai_agent_runs_profile_chk lists exactly AI_AGENT_RUN_PROFILES', () => {
    const match = /ai_agent_runs_profile_chk\s+CHECK \(profile IN \(([^)]*)\)\)/.exec(sql);
    expect(match, 'profile CHECK not found').not.toBeNull();
    const listed = (match?.[1] ?? '')
      .split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
    expect(listed).toEqual([...AI_AGENT_RUN_PROFILES].sort());
  });

  it('adds both columns idempotently and drops the constraint before re-adding it', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS ai_external_processing boolean NOT NULL DEFAULT false');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS staged_inputs jsonb');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS ai_agent_runs_profile_chk;');
  });

  it('is DDL only: no DML, no inner transaction, so it needs no breeze.scope election', () => {
    const code = sql.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });
});
