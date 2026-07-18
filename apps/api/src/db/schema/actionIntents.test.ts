import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import {
  actionIntents,
  intentOutbox,
  actionIntentStatusEnum,
  actionIntentSourceEnum,
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
  it('has exactly chat and mcp_api', () => {
    expect(actionIntentSourceEnum).toEqual(['chat', 'mcp_api']);
  });
});

describe('intentOutboxEventEnum', () => {
  it('has exactly intent_created and intent_approved', () => {
    expect(intentOutboxEventEnum).toEqual(['intent_created', 'intent_approved']);
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

  it('has no extra/missing top-level columns', () => {
    const cols = Object.keys(getTableColumns(actionIntents)).sort();
    expect(cols).toEqual(
      [
        'id',
        'orgId',
        'partnerId',
        'requestedByUserId',
        'requestingApiKeyId',
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
        'status',
        'createdAt',
        'expiresAt',
        'decidedAt',
        'decidedByUserId',
        'decidedAssuranceLevel',
        'decidedVia',
        'executedAt',
        'result',
        'errorCode',
      ].sort(),
    );
  });
});

describe('intent_outbox schema', () => {
  it('exposes the outbox columns', () => {
    const cols = getTableColumns(intentOutbox);
    expect(Object.keys(cols).sort()).toEqual(
      ['id', 'intentId', 'eventType', 'payload', 'createdAt', 'publishedAt', 'publishAttempts'].sort(),
    );
    expect(cols.intentId.notNull).toBe(true);
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
