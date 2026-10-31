// #10411: a call the platform refused (guardrail, RBAC, rate limit, input
// validation, ceiling, intent-creation failure) is recorded as `refused`, so
// `rejected` keeps meaning "the approval lifecycle ended without approval".
import { describe, expect, expectTypeOf, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AiToolStatus } from '@breeze/shared';
import { aiToolStatusEnum } from './schema/ai';

const FILE = '2027-01-18-150000-ai-tool-status-refused.sql';
const SQL = readFileSync(new URL(`../../migrations/${FILE}`, import.meta.url), 'utf8');

describe(FILE, () => {
  it('adds `refused` to ai_tool_status idempotently and never uses it in the same file', () => {
    expect(SQL).toMatch(/ALTER TYPE (public\.)?ai_tool_status ADD VALUE IF NOT EXISTS 'refused'/);
    // Postgres forbids using an enum value in the transaction that added it,
    // and autoMigrate wraps each file in one transaction.
    const uses = SQL.split('\n').filter((line) => !line.trimStart().startsWith('--') && line.includes("'refused'"));
    expect(uses).toHaveLength(1);
    expect(SQL).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });

  it('keeps the Drizzle enum and the shared type in step with the migration', () => {
    expect(aiToolStatusEnum.enumValues).toContain('refused');
    expect(aiToolStatusEnum.enumValues).toContain('rejected');
    expectTypeOf<'refused'>().toMatchTypeOf<AiToolStatus>();
  });
});
