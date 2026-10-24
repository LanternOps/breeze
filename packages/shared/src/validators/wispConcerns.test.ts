import { describe, expect, it } from 'vitest';
import {
  createWatchBodySchema,
  createWatchInputSchema,
  dismissBodySchema,
  listConcernsQuerySchema,
  listConcernsToolSchema,
  nudgeSchema,
  proposeActionSchema,
  raiseConcernChatSchema,
  raiseConcernSchema,
  requestSpecialistSchema,
  resolveBodySchema,
  resolveConcernToolSchema,
  snoozeBodySchema,
  snoozeConcernToolSchema,
  updateConcernSchema,
} from './wispConcerns';

const id = '6f1c2b1e-4a7d-4c55-9a35-2d8f5f0e1a01';
const id2 = '0b3d7e55-8f2a-4b9e-b1c4-7d6e5a4f3c21';
const daysAhead = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

describe('raiseConcernSchema (record_concern)', () => {
  it('accepts every subject kind and a bounded evidence object', () => {
    for (const kind of ['ticket', 'device', 'alert', 'org', 'integration', 'run', 'task', 'incident', 'quote', 'invoice', 'contract', 'site']) {
      expect(raiseConcernSchema.safeParse({ subject: { kind, id }, summary: 's', severity: 'low' }).success, kind).toBe(true);
    }
  });
  it('rejects a 2001-char summary, an unknown kind and > 20 evidence keys', () => {
    expect(raiseConcernSchema.safeParse({ subject: { kind: 'ticket', id }, summary: 'x'.repeat(2001), severity: 'low' }).success).toBe(false);
    expect(raiseConcernSchema.safeParse({ subject: { kind: 'user', id }, summary: 's', severity: 'low' }).success).toBe(false);
    const evidence = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
    expect(raiseConcernSchema.safeParse({ subject: { kind: 'ticket', id }, summary: 's', severity: 'low', evidence }).success).toBe(false);
  });
});

describe('JSON byte caps', () => {
  it('evidence over 16 KB and watch params over 4 KB are a validation error, not a DB CHECK', () => {
    expect(raiseConcernSchema.safeParse({ subject: { kind: 'ticket', id }, summary: 's', severity: 'low', evidence: { blob: 'x'.repeat(16_400) } }).success).toBe(false);
    expect(raiseConcernSchema.safeParse({ subject: { kind: 'ticket', id }, summary: 's', severity: 'low', evidence: { blob: 'x'.repeat(16_000) } }).success).toBe(true);
    expect(createWatchInputSchema.safeParse({ orgId: null, kind: 'custom_query', params: { q: 'x'.repeat(4_100) }, cadenceMinutes: 60 }).success).toBe(false);
    expect(createWatchInputSchema.safeParse({ orgId: null, kind: 'custom_query', params: { q: 'x'.repeat(4_000) }, cadenceMinutes: 60 }).success).toBe(true);
  });
});

describe('raiseConcernChatSchema (raise_concern)', () => {
  it('accepts the chat subject kinds with an explicit orgId', () => {
    for (const kind of ['ticket', 'org', 'quote', 'invoice', 'contract', 'device']) {
      expect(raiseConcernChatSchema.safeParse({ orgId: id2, subject: { kind, id }, summary: 's', severity: 'medium' }).success, kind).toBe(true);
    }
  });
  it('rejects incident/alert/run subjects and a missing orgId', () => {
    for (const kind of ['incident', 'alert', 'integration', 'run', 'task', 'site']) {
      expect(raiseConcernChatSchema.safeParse({ orgId: id2, subject: { kind, id }, summary: 's', severity: 'medium' }).success, kind).toBe(false);
    }
    expect(raiseConcernChatSchema.safeParse({ subject: { kind: 'ticket', id }, summary: 's', severity: 'medium' }).success).toBe(false);
  });
});

describe('updateConcernSchema', () => {
  it('requires an outcome when resolving', () => {
    expect(updateConcernSchema.safeParse({ concernId: id, status: 'resolved' }).success).toBe(false);
    expect(updateConcernSchema.safeParse({ concernId: id, status: 'resolved', outcome: 'fixed' }).success).toBe(true);
    expect(updateConcernSchema.safeParse({ concernId: id, severity: 'high' }).success).toBe(true);
  });
  it('rejects a status other than resolved', () => {
    expect(updateConcernSchema.safeParse({ concernId: id, status: 'dismissed', outcome: 'x' }).success).toBe(false);
  });
});

describe('outcome-tool schemas', () => {
  it('nudge caps nextStep at 300', () => {
    expect(nudgeSchema.safeParse({ concernId: id, nextStep: 'call them' }).success).toBe(true);
    expect(nudgeSchema.safeParse({ concernId: id, nextStep: 'x'.repeat(301) }).success).toBe(false);
  });
  it('propose_action caps reason at 500', () => {
    expect(proposeActionSchema.safeParse({ toolName: 'manage_tickets', input: {}, reason: 'r' }).success).toBe(true);
    expect(proposeActionSchema.safeParse({ toolName: 'manage_tickets', input: {}, reason: 'x'.repeat(501) }).success).toBe(false);
  });
  it('request_specialist needs a 10–500 char reason', () => {
    expect(requestSpecialistSchema.safeParse({ kind: 'sweep', params: {}, reason: 'too short' }).success).toBe(false);
    expect(requestSpecialistSchema.safeParse({ kind: 'sweep', params: {}, reason: 'look at all backups' }).success).toBe(true);
  });
});

describe('watch schemas', () => {
  it('bounds cadence to 15..10080 and accepts a null org', () => {
    expect(createWatchInputSchema.safeParse({ orgId: null, kind: 'ticket_cluster', cadenceMinutes: 15 }).success).toBe(true);
    expect(createWatchInputSchema.safeParse({ orgId: null, kind: 'ticket_cluster', cadenceMinutes: 14 }).success).toBe(false);
    expect(createWatchInputSchema.safeParse({ orgId: id, kind: 'backup_health', cadenceMinutes: 10_081 }).success).toBe(false);
    expect(createWatchInputSchema.safeParse({ orgId: id, kind: 'nope', cadenceMinutes: 60 }).success).toBe(false);
  });
  it('the route body requires grantId and defaults params to {}', () => {
    const parsed = createWatchBodySchema.parse({ grantId: id, orgId: id2, kind: 'ticket_waiting', cadenceMinutes: 60 });
    expect(parsed.params).toEqual({});
    expect(createWatchBodySchema.safeParse({ orgId: id2, kind: 'ticket_waiting', cadenceMinutes: 60 }).success).toBe(false);
  });
});

describe('snooze / dismiss / resolve bodies', () => {
  it('snooze must be in the future and at most 30 days ahead', () => {
    expect(snoozeBodySchema.safeParse({ grantId: id, until: daysAhead(1) }).success).toBe(true);
    expect(snoozeBodySchema.safeParse({ grantId: id, until: daysAhead(31) }).success).toBe(false);
    expect(snoozeBodySchema.safeParse({ grantId: id, until: daysAhead(-1) }).success).toBe(false);
    expect(snoozeBodySchema.safeParse({ until: daysAhead(1) }).success).toBe(false);
    expect(snoozeConcernToolSchema.safeParse({ concernId: id, until: daysAhead(31) }).success).toBe(false);
  });
  it('dismiss needs grantId; resolve caps the outcome at 1000', () => {
    expect(dismissBodySchema.safeParse({}).success).toBe(false);
    expect(resolveBodySchema.safeParse({ grantId: id, outcome: 'done' }).success).toBe(true);
    expect(resolveBodySchema.safeParse({ grantId: id, outcome: 'x'.repeat(1001) }).success).toBe(false);
    expect(resolveConcernToolSchema.safeParse({ concernId: id, outcome: '' }).success).toBe(false);
  });
});

describe('list schemas', () => {
  it('parses a comma status list and rejects an unknown status', () => {
    expect(listConcernsQuerySchema.parse({ grantId: id, status: 'open,snoozed' }).status).toEqual(['open', 'snoozed']);
    expect(listConcernsQuerySchema.parse({ grantId: id }).status).toBeUndefined();
    expect(listConcernsQuerySchema.safeParse({ grantId: id, status: 'open,closed' }).success).toBe(false);
    expect(listConcernsToolSchema.safeParse({ status: ['open'] }).success).toBe(true);
    expect(listConcernsToolSchema.safeParse({ status: ['gone'] }).success).toBe(false);
  });
});
