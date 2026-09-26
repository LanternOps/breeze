// AI Suggested Fixes W1 — mechanical contract for fix_outcomes + fix_memory.
// CLAUDE.md: registrations are caught by contract tests 5/5 and review 0/5,
// so the unit job pins them here rather than waiting for Integration Tests.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FIX_KINDS, FIX_MEMORY_STATUSES, FIX_OUTCOME_STATES, FIX_VOTES } from '@breeze/shared';
import { checkConstraintLiterals } from './checkConstraintTestHelpers';
import { fixMemory, fixOutcomes } from './fixMemory';

const TABLES_SQL = readFileSync(
  new URL('../../../migrations/2026-11-03-100000-fix-memory-tables.sql', import.meta.url),
  'utf8',
);

describe('fix memory schema contract', () => {
  describe('CHECK constraints match @breeze/shared literals exactly', () => {
    it('fix_outcomes_state_chk', () => {
      expect(checkConstraintLiterals(TABLES_SQL, 'fix_outcomes_state_chk', 'state').sort())
        .toEqual([...FIX_OUTCOME_STATES].sort());
    });
    it('fix_outcomes_fix_kind_chk and fix_memory_fix_kind_chk', () => {
      expect(checkConstraintLiterals(TABLES_SQL, 'fix_outcomes_fix_kind_chk', 'fix_kind').sort())
        .toEqual([...FIX_KINDS].sort());
      expect(checkConstraintLiterals(TABLES_SQL, 'fix_memory_fix_kind_chk', 'fix_kind').sort())
        .toEqual([...FIX_KINDS].sort());
    });
    it('fix_outcomes_human_vote_chk', () => {
      expect(checkConstraintLiterals(TABLES_SQL, 'fix_outcomes_human_vote_chk', 'human_vote').sort())
        .toEqual([...FIX_VOTES].sort());
    });
    it('fix_memory_status_chk', () => {
      expect(checkConstraintLiterals(TABLES_SQL, 'fix_memory_status_chk', 'status').sort())
        .toEqual([...FIX_MEMORY_STATUSES].sort());
    });
  });

  it('ships the XOR owner check, the partner-wide SELECT branch and the deferrable composite FK in the same migration', () => {
    expect(TABLES_SQL).toMatch(/fix_memory_one_owner_chk\s+CHECK\s*\(\s*\(org_id IS NULL\)\s*<>\s*\(partner_id IS NULL\)\s*\)/);
    expect(TABLES_SQL).toMatch(/CREATE POLICY fix_memory_partner_wide_select[\s\S]*FOR SELECT[\s\S]*org_id IS NULL AND partner_id = public\.breeze_current_partner_id\(\)/);
    expect(TABLES_SQL).toMatch(/fix_outcomes_org_partner_fk[\s\S]*REFERENCES organizations\(id, partner_id\)[\s\S]*DEFERRABLE INITIALLY IMMEDIATE/);
    // Anchored to the function's NOT IN exclusion list, not a bare literal match anywhere in the file.
    expect(TABLES_SQL).toMatch(/breeze_device_child_orgid_tables[\s\S]*NOT IN\s*\(\s*[\s\S]*?'fix_outcomes'[\s\S]*?\)/);
  });

  it('Drizzle exposes every migration column', () => {
    for (const key of [
      'id', 'orgId', 'partnerId', 'deviceId', 'suggestionId', 'sourceType', 'sourceId', 'alertId',
      'anomalyEpisodeId', 'signatureVersion', 'signatureKey', 'broadKey', 'signatureFacets', 'osType',
      'fixKind', 'fixIdentity', 'scriptId', 'scriptVersionId', 'builtinAction', 'playbookId',
      'instructionsRef', 'scriptExecutionId', 'state', 'stateReason', 'humanVote', 'votedBy', 'votedAt',
      'recoveredAt', 'deadlineAt', 'holdingUntil', 'terminalAt', 'countedAt', 'recountRequestedAt',
      'createdAt', 'updatedAt',
    ]) expect(fixOutcomes, `fixOutcomes.${key}`).toHaveProperty(key);
    for (const key of [
      'id', 'orgId', 'partnerId', 'signatureVersion', 'signatureKey', 'broadKey', 'osType', 'fixKind',
      'fixIdentity', 'scriptId', 'scriptVersionId', 'builtinAction', 'playbookId', 'instructionsRef',
      'attempts', 'verifiedCount', 'failedCount', 'recurredCount', 'upVotes', 'downVotes',
      'rollingSuccessRate', 'consecutiveFailures', 'consecutiveVerified', 'recentOutcomes', 'status',
      'retiredBy', 'retiredAt', 'lastVerifiedAt', 'staleSince', 'rebuildPendingOrgIds', 'createdAt', 'updatedAt',
    ]) expect(fixMemory, `fixMemory.${key}`).toHaveProperty(key);
  });
});
