// apps/api/src/db/schema/aiPlatformModels.contract.test.ts
// AI model registry W01 (#7599): mechanical contract for ai_platform_models.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { MODEL_LIFECYCLES, PROMPT_PROFILES } from '@breeze/shared';
import { checkConstraintLiterals } from './checkConstraintTestHelpers';
import { aiPlatformModels } from './aiPlatformModels';

const DDL = readFileSync(
  new URL('../../../migrations/2026-11-13-100000-ai-platform-models.sql', import.meta.url),
  'utf8',
);

describe('ai_platform_models schema contract', () => {
  it('lifecycle and prompt_profile CHECKs match @breeze/shared exactly', () => {
    expect(checkConstraintLiterals(DDL, 'ai_platform_models_lifecycle_chk', 'lifecycle')).toEqual([...MODEL_LIFECYCLES]);
    expect(checkConstraintLiterals(DDL, 'ai_platform_models_prompt_profile_chk', 'prompt_profile')).toEqual([...PROMPT_PROFILES]);
    expect(checkConstraintLiterals(DDL, 'ai_platform_models_provider_chk', 'provider')).toEqual(['anthropic']);
  });

  it('offering requires all four prices, and the default must be offered', () => {
    const offered = /ai_platform_models_offered_priced_chk\s+CHECK\s*\(([\s\S]*?)\)\s*,\s*\n/.exec(DDL)?.[1] ?? '';
    for (const column of ['input_cents_per_m', 'output_cents_per_m', 'cache_read_cents_per_m', 'cache_write_cents_per_m']) {
      expect(offered).toContain(`${column} IS NOT NULL`);
    }
    expect(DDL).toMatch(/ai_platform_models_default_offered_chk\s+CHECK\s*\(\s*NOT is_platform_default OR platform_offered\s*\)/);
    expect(DDL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS ai_platform_models_one_default_uq[\s\S]*WHERE is_platform_default/);
  });

  // CLAUDE.md cascade table: registration is triggered by these columns. None
  // exists, so no cascade / merge / device / ticket / export entry applies.
  it('has no tenant, device, ticket or user axis', () => {
    const columns = Object.values(getTableColumns(aiPlatformModels)).map((column) => column.name);
    for (const axis of ['org_id', 'partner_id', 'device_id', 'ticket_id', 'user_id']) {
      expect(columns).not.toContain(axis);
    }
  });

  it('the DDL migration writes no rows', () => {
    expect(DDL).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });
});
