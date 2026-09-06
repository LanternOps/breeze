import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { AI_APPROVAL_SCOPES } from '@breeze/shared';
import {
  actionIntents,
  intentOutbox,
  actionIntentStatusEnum,
  actionIntentSourceEnum,
  actionIntentApprovalScopeEnum,
  actionIntentPolicyDecisionStateEnum,
  intentOutboxEventEnum,
} from './actionIntents';
import { approvalRequests } from './approvals';

describe('actionIntentStatusEnum', () => {
  it('has exactly the eight lifecycle states, in order', () => {
    expect(actionIntentStatusEnum).toEqual([
      'pending_approval',
      'approved',
      'executing',
      'completed',
      'failed',
      'rejected',
      'expired',
      'cancelled',
    ]);
  });
});

describe('actionIntentSourceEnum', () => {
  it('has exactly chat, mcp_api, and ai_agent', () => {
    // 'ai_agent' (wave 3) is the autonomous AI agent principal's source —
    // NOT the same as 'agent', which is the Go device agent.
    expect(actionIntentSourceEnum).toEqual(['chat', 'mcp_api', 'ai_agent']);
  });
});

describe('intentOutboxEventEnum', () => {
  it('has exactly the six outbox events', () => {
    // Widened in wave 2 (#3823): intent_rejected and intent_expired exist so a
    // requester can be told an outcome their chat turn did not wait for. A
    // denied intent previously wrote no outbox row at all. Widened again for
    // #4798: intent_cancelled closes the same gap for cancellation.
    expect(intentOutboxEventEnum).toEqual([
      'intent_created',
      'intent_approved',
      'intent_rejected',
      'intent_expired',
      'intent_cancelled',
      'pam.desired_state_changed',
    ]);
  });

  it('matches the SQL CHECK that actually admits the rows', () => {
    // The TS array is advisory; the CHECK constraint is the boundary. They were
    // written in two different files, so pin them to each other — a value added
    // here but not in SQL becomes a row that silently fails to insert, and one
    // added in SQL but not here becomes an event nothing consumes.
    //
    // Points at whichever migration shipped the CONSTRAINT's most recent
    // DROP+re-ADD (a CHECK constraint has one name and is replaced wholesale,
    // not appended to — the SQL file is the widest set only if it's the LAST
    // one to touch this constraint). #4798 moved that to
    // 2026-10-08-100300-intent-cancelled-outbox-event.sql; update this path
    // again the next time the constraint is widened, same as the approval-
    // scope CHECK test below does for its own migration.
    const migration = readFileSync(
      join(__dirname, '../../../migrations/2026-10-08-100300-intent-cancelled-outbox-event.sql'),
      'utf8',
    );
    const check = migration.slice(migration.indexOf('intent_outbox_event_type_check'));
    for (const event of intentOutboxEventEnum) {
      expect(check).toContain(`'${event}'`);
    }
  });
});

describe('actionIntentApprovalScopeEnum', () => {
  it('has exactly supervised and four_eyes', () => {
    expect(actionIntentApprovalScopeEnum).toEqual(['supervised', 'four_eyes']);
  });

  it('is the shared declaration, not a local copy', () => {
    // The union is declared ONCE (packages/shared/src/types/ai.ts) and
    // re-exported here; four structurally-identical literals would let a third
    // member be added to one and compile clean everywhere else.
    expect(actionIntentApprovalScopeEnum).toBe(AI_APPROVAL_SCOPES);
  });

  it('matches the SQL CHECK constraint literals exactly', () => {
    // The only mechanism that keeps the DB and TS sides pinned to each other:
    // adding a member to AI_APPROVAL_SCOPES without a follow-up migration (or
    // vice versa) fails here. Parses the shipped migration's CHECK literal
    // list rather than trusting a hand-copied duplicate.
    const sqlPath = new URL(
      '../../../migrations/2026-08-14-intent-approval-scope-and-deadlines.sql',
      import.meta.url,
    );
    const sql = readFileSync(sqlPath, 'utf8');

    const check = /CHECK\s*\(\s*approval_scope\s+IN\s*\(([^)]*)\)\s*\)/i.exec(sql);
    const memberList = check?.[1];
    expect(memberList, 'approval_scope CHECK constraint not found in the migration').toBeDefined();

    const literals = (memberList ?? '')
      .split(',')
      .map((raw) => raw.trim())
      .filter((raw) => raw.length > 0)
      .map((raw) => {
        expect(raw, `CHECK member ${raw} is not a single-quoted literal`).toMatch(/^'[^']*'$/);
        return raw.slice(1, -1);
      });

    expect([...literals].sort()).toEqual([...actionIntentApprovalScopeEnum].sort());
  });
});

describe('actionIntentPolicyDecisionStateEnum', () => {
  it('has exactly unattempted, authorized, and human_required', () => {
    expect(actionIntentPolicyDecisionStateEnum).toEqual([
      'unattempted',
      'authorized',
      'human_required',
    ]);
  });

  it('matches the SQL CHECK constraint literals exactly', () => {
    const sqlPath = new URL(
      '../../../migrations/2026-09-16-ai-agents-policy-decide-foundations.sql',
      import.meta.url,
    );
    const sql = readFileSync(sqlPath, 'utf8');

    const check = /CHECK\s*\(\s*policy_decision_state\s+IN\s*\(([^)]*)\)\s*\)/i.exec(sql);
    const memberList = check?.[1];
    expect(memberList, 'policy_decision_state CHECK constraint not found in the migration').toBeDefined();

    const literals = (memberList ?? '')
      .split(',')
      .map((raw) => raw.trim())
      .filter((raw) => raw.length > 0)
      .map((raw) => {
        expect(raw, `CHECK member ${raw} is not a single-quoted literal`).toMatch(/^'[^']*'$/);
        return raw.slice(1, -1);
      });

    expect([...literals].sort()).toEqual([...actionIntentPolicyDecisionStateEnum].sort());
  });
});

describe('action_intents schema', () => {
  it('exposes the identity/attribution columns', () => {
    const cols = getTableColumns(actionIntents);
    expect(cols.id).toBeDefined();
    expect(cols.orgId).toBeDefined();
    expect(cols.orgId.notNull).toBe(true);
    expect(cols.partnerId).toBeDefined();
    expect(cols.partnerId.notNull).toBe(false);
    expect(cols.requestedByUserId).toBeDefined();
    expect(cols.requestedByUserId.notNull).toBe(false);
    expect(cols.requestingApiKeyId).toBeDefined();
    expect(cols.requestingApiKeyId.notNull).toBe(false);
    expect(cols.source).toBeDefined();
    expect(cols.source.notNull).toBe(true);
    expect(cols.requestingClientLabel).toBeDefined();
    expect(cols.requestingClientLabel.notNull).toBe(false);
  });

  it('exposes the 12 immutable content columns', () => {
    const cols = getTableColumns(actionIntents);
    const immutable = [
      'actionName',
      'actionVersion',
      'arguments',
      'argumentDigest',
      'targetSummary',
      'impactSummary',
      'reason',
      'riskTier',
      'connectionId',
      'tenantId',
      'idempotencyKey',
      'correlationId',
    ] as const;
    expect(immutable).toHaveLength(12);
    for (const key of immutable) {
      expect(cols[key], `expected column ${key} to exist`).toBeDefined();
    }
    expect(cols.actionName.notNull).toBe(true);
    expect(cols.actionVersion.notNull).toBe(true);
    expect(cols.actionVersion.default).toBe(1);
    expect(cols.arguments.notNull).toBe(true);
    expect(cols.arguments.default).toEqual({});
    expect(cols.argumentDigest.notNull).toBe(true);
    expect(cols.targetSummary.notNull).toBe(true);
    expect(cols.impactSummary.notNull).toBe(true);
    expect(cols.reason.notNull).toBe(false);
    expect(cols.riskTier.notNull).toBe(true);
    expect(cols.connectionId.notNull).toBe(false);
    expect(cols.tenantId.notNull).toBe(false);
    expect(cols.idempotencyKey.notNull).toBe(true);
    expect(cols.correlationId.notNull).toBe(true);
  });

  it('exposes the lifecycle columns', () => {
    const cols = getTableColumns(actionIntents);
    expect(cols.status).toBeDefined();
    expect(cols.status.notNull).toBe(true);
    expect(cols.status.default).toBe('pending_approval');
    expect(cols.createdAt.notNull).toBe(true);
    expect(cols.expiresAt).toBeDefined();
    expect(cols.expiresAt.notNull).toBe(true);
    expect(cols.decidedAt).toBeDefined();
    expect(cols.decidedAt.notNull).toBe(false);
    expect(cols.decidedByUserId).toBeDefined();
    expect(cols.decidedAssuranceLevel).toBeDefined();
    expect(cols.decidedVia).toBeDefined();
    expect(cols.executedAt).toBeDefined();
    expect(cols.result).toBeDefined();
    expect(cols.errorCode).toBeDefined();
  });

  it('exposes the supervised/four_eyes classification and split-deadline columns', () => {
    const cols = getTableColumns(actionIntents);
    // Immutable classification content, decided once at creation.
    expect(cols.approvalScope).toBeDefined();
    expect(cols.approvalScope.notNull).toBe(true);
    expect(cols.approvalScope.default).toBe('four_eyes');
    expect(cols.classificationVersion).toBeDefined();
    expect(cols.classificationVersion.notNull).toBe(true);
    expect(cols.classificationVersion.default).toBe(0);
    expect(cols.effectDigest).toBeDefined();
    expect(cols.effectDigest.notNull).toBe(false);
    // Lifecycle: mutable, NOT covered by the immutability trigger.
    expect(cols.approvalExpiresAt).toBeDefined();
    expect(cols.approvalExpiresAt.notNull).toBe(false);
    expect(cols.releaseBy).toBeDefined();
    expect(cols.releaseBy.notNull).toBe(false);
  });

  it('exposes the policy-decide lifecycle + provenance columns (wave 5 part A, #3827)', () => {
    const cols = getTableColumns(actionIntents);
    expect(cols.policyDecisionState).toBeDefined();
    expect(cols.policyDecisionState.notNull).toBe(true);
    // The backfill value for pre-existing rows, NOT the value Part B's
    // createActionIntent stamps on a new row (that's the stub returning
    // 'human_required' unconditionally in THIS PR — same visible value,
    // different mechanism; Part B changes the stamp to 'unattempted').
    expect(cols.policyDecisionState.default).toBe('human_required');
    // Part-B-written, nullable in this PR (no writer exists yet).
    expect(cols.policyAuthorizationKey).toBeDefined();
    expect(cols.policyAuthorizationKey.notNull).toBe(false);
    expect(cols.policySnapshotDigest).toBeDefined();
    expect(cols.policySnapshotDigest.notNull).toBe(false);
    expect(cols.policyClassificationVersion).toBeDefined();
    expect(cols.policyClassificationVersion.notNull).toBe(false);
    expect(cols.policyReservationId).toBeDefined();
    expect(cols.policyReservationId.notNull).toBe(false);
    expect(cols.policyKillEpoch).toBeDefined();
    expect(cols.policyKillEpoch.notNull).toBe(false);
  });

  it('has no extra/missing top-level columns', () => {
    const cols = Object.keys(getTableColumns(actionIntents)).sort();
    expect(cols).toEqual(
      [
        'id',
        'orgId',
        'partnerId',
        'requestedByUserId',
        'originPrincipalKind',
        'originPrincipalId',
        'requestingApiKeyId',
        'requestingAgentRunId',
        'scopeKind',
        'scopeDeviceId',
        'scopeTicketId',
        'source',
        'requestingClientLabel',
        'actionName',
        'actionVersion',
        'arguments',
        'argumentDigest',
        'targetSummary',
        'impactSummary',
        'reason',
        'riskTier',
        'connectionId',
        'tenantId',
        'idempotencyKey',
        'correlationId',
        'approvalScope',
        'classificationVersion',
        'effectDigest',
        'status',
        'createdAt',
        'expiresAt',
        'approvalExpiresAt',
        'releaseBy',
        'decidedAt',
        'decidedByUserId',
        'decidedAssuranceLevel',
        'decidedVia',
        'executionStartedAt',
        'executedAt',
        'result',
        'errorCode',
        'policyDecisionState',
        'policyAuthorizationKey',
        'policySnapshotDigest',
        'policyClassificationVersion',
        'policyReservationId',
        'policyKillEpoch',
      ].sort(),
    );
  });
});

describe('intent_outbox schema', () => {
  it('exposes the outbox columns', () => {
    const cols = getTableColumns(intentOutbox);
    expect(Object.keys(cols).sort()).toEqual(
      [
        'id', 'intentId', 'pamActuationId', 'eventType', 'payload',
        'createdAt', 'publishedAt', 'publishAttempts',
      ].sort(),
    );
    expect(cols.intentId.notNull).toBe(false);
    expect(cols.pamActuationId.notNull).toBe(false);
    expect(cols.eventType.notNull).toBe(true);
    expect(cols.payload.notNull).toBe(true);
    expect(cols.payload.default).toEqual({});
    expect(cols.createdAt.notNull).toBe(true);
    expect(cols.publishedAt.notNull).toBe(false);
    expect(cols.publishAttempts.notNull).toBe(true);
    expect(cols.publishAttempts.default).toBe(0);
  });
});

describe('approval_requests intent linkage', () => {
  it('gains a nullable intentId FK column', () => {
    const cols = getTableColumns(approvalRequests);
    expect(cols.intentId).toBeDefined();
    expect(cols.intentId.notNull).toBe(false);
  });

  it('gains a nullable boundArgumentDigest char(64) column', () => {
    const cols = getTableColumns(approvalRequests);
    expect(cols.boundArgumentDigest).toBeDefined();
    expect(cols.boundArgumentDigest.notNull).toBe(false);
  });
});
