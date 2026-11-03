import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { flowVersions, flowRuns, flowRunSteps } from './flowRuns';
import { flows } from './flows';
import { actionIntents } from './actionIntents';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';

// Tool Catalog W04 (#5219) Task A2 — flow publications, runs and the step
// ledger. Migration: 2027-01-06-130000-flow-runs.sql. Tenancy shapes are Open
// Decision 1: flow_versions follows flows (org XOR partner), flow_runs and
// flow_run_steps are shape 1 (org_id NOT NULL, no partner axis).

const FLOW_VERSION_COLUMNS = [
  'id', 'flowId', 'orgId', 'partnerId', 'publicationSeq', 'definitionVersion', 'definition',
  'effectiveTier', 'stepPins', 'preApprovals', 'enabledByUserId', 'createdAt',
] as const;

const FLOW_RUN_COLUMNS = [
  'id', 'orgId', 'flowId', 'flowVersionId', 'definitionVersion', 'triggerKind', 'triggeredVia',
  'triggerPayload', 'inputs', 'status', 'preApprovalsHonored', 'currentStepId', 'currentItemIndex',
  'resumeSeq', 'leaseToken', 'leaseExpiresAt', 'wakeAt', 'dedupeKey', 'chainDepth', 'causedByRunId',
  'triggeredByUserId', 'aiSessionId', 'activeMs', 'lastHeartbeatAt', 'cancelRequestedAt',
  'bodiesPrunedAt', 'errorCode', 'error', 'startedAt', 'finishedAt', 'createdAt', 'updatedAt',
  // W05 (#5220, 2027-01-07-140000-flow-webhooks-tools-budgets.sql): the per-run
  // AI token count, the parent agent run of an ai_agent start, the API key of an
  // api/mcp start (flow_runs_ai_tokens_chk / _agent_parent_chk / _api_key_chk).
  'aiTokensUsed', 'parentAgentRunId', 'triggeredByApiKeyId',
] as const;

const FLOW_RUN_STEP_COLUMNS = [
  'id', 'runId', 'orgId', 'stepId', 'itemIndex', 'attempt', 'tool', 'toolSource', 'tier', 'status',
  'approvalMode', 'renderedInput', 'output', 'outputTruncated', 'errorCode', 'error', 'actionIntentId',
  'approvedByUserId', 'startedAt', 'finishedAt', 'durationMs',
  // W05 (#5220): model usage of an `ai` step (flow_run_steps_ai_usage_chk).
  'aiInputTokens', 'aiOutputTokens', 'aiCostCents',
] as const;

describe('flow run tables (Drizzle)', () => {
  it('names the three tables', () => {
    expect(getTableName(flowVersions)).toBe('flow_versions');
    expect(getTableName(flowRuns)).toBe('flow_runs');
    expect(getTableName(flowRunSteps)).toBe('flow_run_steps');
  });

  it('declares exactly the planned columns', () => {
    expect(Object.keys(getTableColumns(flowVersions)).sort()).toEqual([...FLOW_VERSION_COLUMNS].sort());
    expect(Object.keys(getTableColumns(flowRuns)).sort()).toEqual([...FLOW_RUN_COLUMNS].sort());
    expect(Object.keys(getTableColumns(flowRunSteps)).sort()).toEqual([...FLOW_RUN_STEP_COLUMNS].sort());
  });

  it('classifies every column of the three tables in the tenant export policy (jsonb never included)', () => {
    // The export contract fails only under Integration Tests; this makes a
    // column added without a classification red in Test API too.
    for (const table of [flowVersions, flowRuns, flowRunSteps]) {
      const name = getTableName(table);
      const policy = CORE_TENANT_EXPORT_POLICY[name];
      expect(policy, name).toBeDefined();
      const columns = Object.values(getTableColumns(table));
      expect(Object.keys(policy!.columns).sort(), name).toEqual(columns.map((c) => c.name).sort());
      for (const col of columns.filter((c) => c.getSQLType() === 'jsonb')) {
        expect(policy!.columns[col.name]!.decision, `${name}.${col.name}`).toBe('exclude');
      }
    }
  });

  it('keeps runs and steps shape 1: org_id NOT NULL, no partner axis (Open Decision 1)', () => {
    expect(getTableColumns(flowRuns).orgId.notNull).toBe(true);
    expect(getTableColumns(flowRunSteps).orgId.notNull).toBe(true);
    expect(Object.keys(getTableColumns(flowRuns))).not.toContain('partnerId');
    expect(Object.keys(getTableColumns(flowRunSteps))).not.toContain('partnerId');
    // flow_versions follows flows: both owner columns nullable (XOR in SQL).
    expect(getTableColumns(flowVersions).orgId.notNull).toBe(false);
    expect(getTableColumns(flowVersions).partnerId.notNull).toBe(false);
  });

  it('has no device, ticket or site column on any of the three (the trigger device lives in trigger_payload)', () => {
    for (const table of [flowVersions, flowRuns, flowRunSteps]) {
      const cols = Object.keys(getTableColumns(table));
      expect(cols, getTableName(table)).not.toContain('deviceId');
      expect(cols, getTableName(table)).not.toContain('ticketId');
      expect(cols, getTableName(table)).not.toContain('siteId');
    }
  });

  it('dedupe_key is NOT NULL (every creation path sets one) and the ledger keys are NOT NULL', () => {
    const run = getTableColumns(flowRuns);
    expect(run.dedupeKey.notNull).toBe(true);
    expect(run.flowVersionId.notNull).toBe(true);
    expect(run.preApprovalsHonored.notNull).toBe(true);
    // Nullable only so retention can prune them.
    expect(run.triggerPayload.notNull).toBe(false);
    expect(run.inputs.notNull).toBe(false);
    const step = getTableColumns(flowRunSteps);
    expect(step.runId.notNull).toBe(true);
    expect(step.attempt.notNull).toBe(true);
    expect(step.renderedInput.notNull).toBe(false);
    expect(step.output.notNull).toBe(false);
  });
});

describe('columns W04 adds to existing tables', () => {
  it('flows gains the live publication pointer and the schedule occurrence key', () => {
    const cols = getTableColumns(flows);
    expect(cols.enabledPublicationSeq).toBeDefined();
    expect(cols.enabledPublicationSeq.name).toBe('enabled_publication_seq');
    expect(cols.enabledPublicationSeq.notNull).toBe(false);
    expect(cols.scheduleLastOccurrenceKey).toBeDefined();
    expect(cols.scheduleLastOccurrenceKey.name).toBe('schedule_last_occurrence_key');
  });

  it('flow_run_steps has an org_id index (org erasure and FK checks look rows up by org_id alone)', () => {
    const idx = getTableConfig(flowRunSteps).indexes.find((i) => i.config.name === 'flow_run_steps_org_id_idx');
    expect(idx).toBeDefined();
    expect(idx!.config.columns.map((c) => (c as { name: string }).name)).toEqual(['org_id']);
    expect(idx!.config.where).toBeUndefined();
  });

  it('action_intents gains requesting_flow_run_id (nullable; one-actor CHECK in SQL)', () => {
    const cols = getTableColumns(actionIntents);
    expect(cols.requestingFlowRunId).toBeDefined();
    expect(cols.requestingFlowRunId.name).toBe('requesting_flow_run_id');
    expect(cols.requestingFlowRunId.notNull).toBe(false);
  });
});
