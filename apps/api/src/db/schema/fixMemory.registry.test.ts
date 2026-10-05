// AI Suggested Fixes W1 — mechanical contract for fix_outcomes + fix_memory.
// CLAUDE.md: registrations are caught by contract tests 5/5 and review 0/5,
// so the unit job pins them here rather than waiting for Integration Tests.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ALERT_RESOLUTION_REASONS,
  FIX_KINDS,
  FIX_MEMORY_STATUSES,
  FIX_OUTCOME_STATES,
  FIX_VOTES,
  REMEDIATION_SUGGESTION_ORIGINS,
  RESEARCH_BUILTIN_ACTIONS,
} from '@breeze/shared';
import { checkConstraintLiterals } from './checkConstraintTestHelpers';
import { fixMemory, fixOutcomes } from './fixMemory';
import { fixInstructions } from './fixInstructions';
import { alerts } from './alerts';
import { remediationSuggestions } from './remediationSuggestions';
import { getOrgCascadeDeleteOrder } from '../../services/tenantCascade';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';
import { __testOnly as orgMergeRegistryTestOnly } from '../../services/orgMergeRegistry';

const TABLES_SQL = readFileSync(
  new URL('../../../migrations/2026-11-08-170000-fix-memory-tables.sql', import.meta.url),
  'utf8',
);
const ORIGIN_SQL = readFileSync(
  new URL('../../../migrations/2026-11-08-170100-remediation-suggestion-origin.sql', import.meta.url),
  'utf8',
);
const REASON_SQL = readFileSync(
  new URL('../../../migrations/2026-11-08-170200-alert-resolution-reason.sql', import.meta.url),
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

  it('every single-column FK on fix_outcomes has an index led by that column (M4: ON DELETE SET NULL scans)', () => {
    const table = TABLES_SQL.slice(TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS fix_outcomes'), TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS fix_memory'));
    const block = table.slice(0, table.indexOf(');\n'));
    const fkColumns = [...block.matchAll(/^\s+(\w+)\s+uuid\s+REFERENCES\s/gm)].map((m) => m[1]!);
    expect(fkColumns).toEqual(expect.arrayContaining(['anomaly_episode_id', 'script_id', 'script_version_id', 'playbook_id', 'voted_by']));
    const leading = new Set([...table.matchAll(/ON fix_outcomes \((\w+)/g)].map((m) => m[1]!));
    const unindexed = fkColumns.filter((c) => !leading.has(c));
    expect(unindexed).toEqual([]);
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

describe('fix memory registrations', () => {
  it('both tables are in the org cascade order, alphabetically between executive_summaries and fleet_design_applied_items', () => {
    const order = getOrgCascadeDeleteOrder();
    const at = (t: string) => order.indexOf(t);
    expect(at('fix_memory')).toBeGreaterThan(at('executive_summaries'));
    expect(at('fix_outcomes')).toBeGreaterThan(at('fix_memory'));
    expect(at('fleet_design_applied_items')).toBeGreaterThan(at('fix_outcomes'));
  });

  it('both tables are leave-for-erasure in the merge registry', () => {
    expect(orgMergeRegistryTestOnly.SPECIAL['fix_outcomes']?.kind).toBe('leave-for-erasure');
    expect(orgMergeRegistryTestOnly.SPECIAL['fix_memory']?.kind).toBe('leave-for-erasure');
  });

  it('export policy classifies signature_facets as an excluded open container and keys by org_id', () => {
    const outcomes = CORE_TENANT_EXPORT_POLICY['fix_outcomes'];
    const memory = CORE_TENANT_EXPORT_POLICY['fix_memory'];
    expect(outcomes).toBeDefined();
    expect(memory).toBeDefined();
    expect(outcomes!.columns['signature_facets']).toMatchObject({ decision: 'exclude', openContainerReviewed: true });
    expect(outcomes!.columns['signature_key']?.decision).toBe('include');
    expect(memory!.columns['recent_outcomes']?.decision).toBe('include');
  });
});

describe('suggestion origin + alert resolution reason', () => {
  it('origin CHECK mirrors REMEDIATION_SUGGESTION_ORIGINS and defaults existing rows to catalog_match', () => {
    expect(checkConstraintLiterals(ORIGIN_SQL, 'remediation_suggestions_origin_check', 'origin').sort())
      .toEqual([...REMEDIATION_SUGGESTION_ORIGINS].sort());
    expect(ORIGIN_SQL).toMatch(/ADD COLUMN IF NOT EXISTS origin varchar\(20\) NOT NULL DEFAULT 'catalog_match'/);
    expect(checkConstraintLiterals(ORIGIN_SQL, 'remediation_suggestions_target_type_check', 'target_type'))
      .toContain('manual_steps');
  });

  it('resolution_reason CHECK mirrors ALERT_RESOLUTION_REASONS', () => {
    expect(checkConstraintLiterals(REASON_SQL, 'alerts_resolution_reason_check', 'resolution_reason').sort())
      .toEqual([...ALERT_RESOLUTION_REASONS].sort());
  });

  it('Drizzle exposes the new columns and export policy classifies them', () => {
    expect(remediationSuggestions).toHaveProperty('origin');
    expect(alerts).toHaveProperty('resolutionReason');
    expect(CORE_TENANT_EXPORT_POLICY['remediation_suggestions']!.columns['origin']?.decision).toBe('include');
    expect(CORE_TENANT_EXPORT_POLICY['alerts']!.columns['resolution_reason']?.decision).toBe('include');
  });
});

const W2_SUGGESTIONS_SQL = readFileSync(
  new URL('../../../migrations/2026-12-07-100200-remediation-research-suggestions.sql', import.meta.url),
  'utf8',
);
const W2_INSTRUCTIONS_SQL = readFileSync(
  new URL('../../../migrations/2026-12-07-100100-fix-instructions.sql', import.meta.url),
  'utf8',
);

describe('W2 research columns + reviewed steps', () => {
  it('builtin_action CHECK mirrors RESEARCH_BUILTIN_ACTIONS', () => {
    expect(checkConstraintLiterals(W2_SUGGESTIONS_SQL, 'remediation_suggestions_builtin_action_check', 'builtin_action').sort())
      .toEqual([...RESEARCH_BUILTIN_ACTIONS].sort());
    expect(checkConstraintLiterals(W2_SUGGESTIONS_SQL, 'remediation_suggestions_target_type_check', 'target_type'))
      .toEqual(expect.arrayContaining(['builtin_action', 'script_draft', 'manual_steps']));
  });

  it('fix_instructions is partner-axis with a separate SELECT-only own-partner branch', () => {
    expect(W2_INSTRUCTIONS_SQL).toMatch(/partner_id\s+uuid NOT NULL REFERENCES partners\(id\) ON DELETE CASCADE/);
    expect(W2_INSTRUCTIONS_SQL).toMatch(/CREATE POLICY fix_instructions_partner_select[\s\S]*FOR SELECT[\s\S]*partner_id = public\.breeze_current_partner_id\(\)/);
    expect(W2_INSTRUCTIONS_SQL).not.toMatch(/org_id/);
    expect(fixInstructions).toHaveProperty('steps');
  });

  it('classifies every new column of an org-cascade table for export', () => {
    for (const col of ['agent_run_id', 'builtin_action', 'research_ordinal', 'instructions_id']) {
      expect(CORE_TENANT_EXPORT_POLICY['remediation_suggestions']!.columns[col]?.decision, col).toBe('include');
    }
    for (const col of ['action_command_id', 'action_cleanup_run_id']) {
      expect(CORE_TENANT_EXPORT_POLICY['fix_outcomes']!.columns[col]?.decision, col).toBe('include');
    }
  });
});
