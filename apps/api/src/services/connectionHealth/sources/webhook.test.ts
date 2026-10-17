import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// The mapper is pure; the queries run against a real DB in
// __tests__/integration/connectionHealthSources.integration.test.ts.
vi.mock('../../../db', () => ({ db: {} }));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DECRYPT_FAILED_MESSAGE,
  DEFAULT_MAX_RETRIES,
  TERMINAL_FAILURE_WINDOW_MS,
  webhookObservation,
  webhookSource,
  type WebhookRow,
} from './webhook';

const NOW = new Date('2026-10-17T12:00:00Z');
const OLD = new Date('2026-09-01T00:00:00Z');
const ID = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const O = '33333333-3333-4333-8333-333333333333';

const row: WebhookRow = {
  id: ID,
  orgId: O,
  partnerId: P,
  name: 'Ticket sync',
  status: 'active',
  createdAt: OLD,
  hasTerminalFailure: true,
  recoveredSince: false,
  failureMessage: 'HTTP 503 from https://hooks.example.com/in?token=abc123secret',
  failureResponseStatus: 503,
};

describe('webhook source', () => {
  it('registers as an org-scoped 15-minute kind with the webhooks fix link', () => {
    expect(webhookSource).toMatchObject({
      kind: 'webhook',
      intervalMinutes: 15,
      tables: ['webhooks', 'webhook_deliveries'],
      fixHrefs: ['/integrations#webhooks'],
    });
  });

  it('a terminal failure with no success since is a transient org incident with a sanitized detail', () => {
    expect(webhookObservation(row, NOW)).toEqual({
      sourceKind: 'webhook',
      sourceId: ID,
      partnerId: P,
      orgId: O,
      ownerUserId: null,
      state: 'broken',
      severity: 'transient',
      condition: 'delivery_failed',
      detail: 'HTTP 503 from https://hooks.example.com',
      displayName: 'Ticket sync',
      fixHref: '/integrations#webhooks',
      ownerFixHref: null,
      viewPermission: { resource: 'webhooks', action: 'read' },
      repairPermission: { resource: 'organizations', action: 'write' },
      observedAt: NOW,
    });
  });

  it('falls back to the response status when the delivery has no message', () => {
    expect(webhookObservation({ ...row, failureMessage: null }, NOW).detail).toBe('HTTP 503');
    expect(webhookObservation({ ...row, failureMessage: null, failureResponseStatus: null }, NOW).detail).toBeNull();
  });

  it('a success after the failure is healthy; disabled is retired; a young webhook failing is unknown', () => {
    expect(webhookObservation({ ...row, recoveredSince: true }, NOW).state).toBe('healthy');
    expect(webhookObservation({ ...row, status: 'disabled' }, NOW).state).toBe('retired');
    expect(webhookObservation({ ...row, createdAt: new Date(NOW.getTime() - 30 * 60_000) }, NOW).state).toBe('unknown');
  });

  it('the broken query reads only failed deliveries inside the window, with literal predicates', () => {
    const q = new PgDialect().sqlToQuery(webhookSource.brokenQuery(NOW) as SQL);
    // Literal so the planner can match webhook_deliveries_failed_recent_idx.
    expect(q.sql).toContain(`d.status = 'failed'`);
    expect(q.sql).toContain(`NOT LIKE 'superseded\\_by\\_edit:%'`);
    expect(q.params).toContain(new Date(NOW.getTime() - TERMINAL_FAILURE_WINDOW_MS).toISOString());
    expect(TERMINAL_FAILURE_WINDOW_MS).toBe(60 * 60 * 1000);
  });

  it('stays in step with the delivery worker it reads (retry budget, decrypt-failure message)', () => {
    const worker = readFileSync(path.resolve(__dirname, '../../../workers/webhookDelivery.ts'), 'utf8');
    expect(worker).toContain(`const MAX_RETRIES = ${DEFAULT_MAX_RETRIES};`);
    expect(worker).toContain(`'${DECRYPT_FAILED_MESSAGE}'`);
  });

  it('counts an undecryptable-credentials delivery as terminal although it is written as superseded', () => {
    const q = new PgDialect().sqlToQuery(webhookSource.brokenQuery(NOW) as SQL);
    expect(q.sql).toContain(`d.error_message = '${DECRYPT_FAILED_MESSAGE}'`);
  });
});
