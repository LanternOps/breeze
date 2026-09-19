// Shared by schema contract tests that need to pin a Drizzle/`@breeze/shared`
// enum against the literal set inside a migration's `CHECK (... IN (...))`
// constraint, so a member added to one side without the other fails fast in
// the unit job instead of surfacing as a 23514 in production. Hoisted out of
// aiAgentFixWatches.test.ts (P2-5, #4192) — see aiAgentOpEvidence.registry.test.ts
// and aiAgentGraduation.registry.test.ts for the additional CHECKs this covers.
import { expect } from 'vitest';

/**
 * Extracts the single-quoted literal members of a `CONSTRAINT <constraintName>
 * CHECK (<column> IN (...))` clause from raw migration SQL text.
 */
export function checkConstraintLiterals(sql: string, constraintName: string, column: string): string[] {
  const pattern = new RegExp(`${constraintName}\\s+CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)\\s*\\)`, 'i');
  const check = pattern.exec(sql);
  const memberList = check?.[1];
  expect(memberList, `${constraintName} CHECK constraint not found in the migration`).toBeDefined();

  return (memberList ?? '')
    .split(',')
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0)
    .map((raw) => {
      expect(raw, `CHECK member ${raw} is not a single-quoted literal`).toMatch(/^'[^']*'$/);
      return raw.slice(1, -1);
    });
}
