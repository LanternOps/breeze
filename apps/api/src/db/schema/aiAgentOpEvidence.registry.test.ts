// P2-5 (#4192) — mechanical registry contract for the two new tables
// (ai_agent_op_evidence, ai_agent_graduation) plus the three new columns
// added to the already-registered ai_agent_fix_watches. Per CLAUDE.md's
// "Cascade registration" contract, this is the check code review has
// caught 0/5 times and contract tests 5/5 — asserted directly here rather
// than only under the (DB-requiring) integration suites so it fails fast
// in the unit job too.
import { describe, expect, it } from 'vitest';
import { getOrgCascadeDeleteOrder, ORG_CASCADE_DELETE_ORDER } from '../../services/tenantCascade';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';
import { __testOnly as orgMergeRegistryTestOnly } from '../../services/orgMergeRegistry';
import { aiAgentOpEvidence } from './aiAgentOpEvidence';
import { aiAgentGraduation } from './aiAgentGraduation';

describe('P2-5 schema registries (Task 2)', () => {
  // getOrgCascadeDeleteOrder() (not the raw CORE_ORG_CASCADE_DELETE_ORDER
  // constant) is the real consumer-facing contract: it re-sorts and dedupes
  // via withExtensionOrgCascade() (tenancyRegistry.ts) regardless of the
  // raw list's own insertion order, and it's what
  // tenantCascade.integration.test.ts's "is alphabetised" assertion checks
  // too — verified both pass together against a real DB. So the raw list's
  // OWN internal order is cosmetic; what matters is that the two new
  // entries are present exactly once each (a duplicate string would
  // silently collapse via the wrapper's `Set`, hiding a real double-add) and
  // that the final normalised order comes out right.
  it('getOrgCascadeDeleteOrder() contains both new tables exactly once each, sorted with organizations last', () => {
    const order = getOrgCascadeDeleteOrder();
    for (const table of ['ai_agent_graduation', 'ai_agent_op_evidence']) {
      const occurrences = order.filter((t) => t === table);
      expect(occurrences, `${table} should appear exactly once`).toHaveLength(1);
    }
    const withoutLast = order.slice(0, -1);
    const sorted = [...withoutLast].sort((a, b) => a.localeCompare(b));
    expect(withoutLast).toEqual(sorted);
    expect(order[order.length - 1]).toBe('organizations');
  });

  it('the raw CORE_ORG_CASCADE_DELETE_ORDER list does not insert either new table twice', () => {
    for (const table of ['ai_agent_graduation', 'ai_agent_op_evidence']) {
      const occurrences = ORG_CASCADE_DELETE_ORDER.filter((t) => t === table);
      expect(occurrences, `${table} should appear exactly once in the raw list`).toHaveLength(1);
    }
  });

  it('ai_agent_graduation cascade-sorts before ai_agent_op_evidence, both between ai_agent_fix_watches and ai_agent_runs', () => {
    const order = getOrgCascadeDeleteOrder();
    const idxFixWatches = order.indexOf('ai_agent_fix_watches');
    const idxGraduation = order.indexOf('ai_agent_graduation');
    const idxOpEvidence = order.indexOf('ai_agent_op_evidence');
    const idxRuns = order.indexOf('ai_agent_runs');
    expect(idxFixWatches).toBeGreaterThanOrEqual(0);
    expect(idxGraduation).toBeGreaterThan(idxFixWatches);
    expect(idxOpEvidence).toBeGreaterThan(idxGraduation);
    expect(idxRuns).toBeGreaterThan(idxOpEvidence);
  });

  it('CORE_TENANT_EXPORT_POLICY has an entry for both new tables', () => {
    expect(CORE_TENANT_EXPORT_POLICY['ai_agent_op_evidence']).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY['ai_agent_graduation']).toBeDefined();
  });

  it('ai_agent_fix_watches export policy classifies the three new columns as included', () => {
    const policy = CORE_TENANT_EXPORT_POLICY['ai_agent_fix_watches'];
    expect(policy).toBeDefined();
    for (const column of ['intent_id', 'source_kind', 'op_keys']) {
      expect(policy!.columns[column]?.decision, `${column} should be classified`).toBe('include');
    }
  });

  it('orgMergeRegistry SPECIAL has both new tables classified leave-for-erasure', () => {
    const special = orgMergeRegistryTestOnly.SPECIAL;
    expect(special['ai_agent_graduation']?.kind).toBe('leave-for-erasure');
    expect(special['ai_agent_op_evidence']?.kind).toBe('leave-for-erasure');
  });

  it('aiAgentOpEvidence exposes every column named in the migration', () => {
    const expectedKeys = [
      'id', 'orgId', 'agentId', 'namespace', 'opKey', 'ruleId',
      'sourceKind', 'sourceId', 'metric', 'runId', 'occurredAt', 'createdAt',
    ];
    for (const key of expectedKeys) {
      expect(aiAgentOpEvidence, `aiAgentOpEvidence.${key} should exist`).toHaveProperty(key);
    }
  });

  it('aiAgentGraduation exposes every column named in the migration', () => {
    const expectedKeys = [
      'id', 'orgId', 'agentId', 'opKey', 'state', 'firstVerifiedAt',
      'promotedAt', 'promotedIntentId', 'demotedAt', 'demoteReason',
      'demoteRunId', 'demoteWatchId', 'updatedAt',
    ];
    for (const key of expectedKeys) {
      expect(aiAgentGraduation, `aiAgentGraduation.${key} should exist`).toHaveProperty(key);
    }
  });
});
