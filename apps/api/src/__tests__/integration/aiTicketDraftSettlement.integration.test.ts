/**
 * AI model registry W03 (#7601): the chat ticket draft's reserve -> settle path
 * against real Postgres, through the real route, auth and RLS.
 *
 * A ticket draft is a one-shot, NOT a turn of the chat session it summarises:
 * its reservation must be sessionless (no binding stamped onto the chat
 * session, no turn claimed), so the sessionless settlement can close it. The
 * defect this pins: the route reserved WITH the chat session (stamping it) and
 * then settled without one, which settleAiBudgetReservation refuses
 * ("Session-bound AI budget reservation requires session settlement") — the
 * reservation went indeterminate, nothing reached the ledger, and platform
 * credits were never debited.
 *
 * Only the provider is fake (the client factory returns a stub client); the
 * resolver, budget, settlement and billing-debit code are real, with the
 * billing service stubbed at fetch.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../services/aiModels/connectionFactory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/aiModels/connectionFactory')>()),
  anthropicClientFor: vi.fn(() => ({ messages: { create: provider.create } })),
}));

import { db, withSystemDbAccessContext } from '../../db';
import { aiRoutes } from '../../routes/ai';
import { createAccessToken } from '../../services/jwt';
import { closeRegistryFixtures, fixtureSql } from './aiModelRegistryFixtures';
import { assignUserToOrganization, createRole, grantRolePermissions } from './db-utils';
import { seedRegistryPartner, type SeededRegistryPartner } from './helpers/aiModelRegistrySeed';
import { PLATFORM_KEY_PLACEHOLDER } from './helpers/platformAiKey';

afterAll(closeRegistryFixtures);

const saved = {
  key: process.env.ANTHROPIC_API_KEY,
  url: process.env.BILLING_SERVICE_URL,
  billingKey: process.env.BILLING_SERVICE_API_KEY,
};
function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
afterAll(() => {
  restore('ANTHROPIC_API_KEY', saved.key);
  restore('BILLING_SERVICE_URL', saved.url);
  restore('BILLING_SERVICE_API_KEY', saved.billingKey);
});

type DeductCall = { key: string | null; costCents: number };
let deductCalls: DeductCall[] = [];

beforeEach(() => {
  // The platform connection is usable only with a platform key; the provider
  // itself is the stub above, so the key is never sent anywhere.
  process.env.ANTHROPIC_API_KEY = PLATFORM_KEY_PLACEHOLDER;
  process.env.BILLING_SERVICE_URL = 'https://billing.test.invalid';
  process.env.BILLING_SERVICE_API_KEY = 'test-billing-key';
  deductCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (String(url).endsWith('/ai-credits/deduct')) {
      const body = JSON.parse(String(init.body)) as { costCents: number; idempotencyKey?: string };
      deductCalls.push({ key: body.idempotencyKey ?? null, costCents: body.costCents });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    // The pre-admission credit check: credits available.
    return new Response(JSON.stringify({ allowed: true, plan: 'community', balanceCents: 100_000 }), { status: 200 });
  }));
  provider.create.mockReset();
  provider.create.mockResolvedValue({
    id: 'msg_w03', type: 'message', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: JSON.stringify({
      subject: 'Outlook fixed', problemSummary: 'Outlook would not open.', resolutionSummary: 'Rebuilt the profile.',
      wasFixed: true, suggestedTimeMinutes: 10,
    }) }],
    usage: { input_tokens: 1_000, output_tokens: 200 },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

async function q<R extends Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<R[]> {
  return withSystemDbAccessContext(async () => {
    const result = await db.execute<R>(query);
    return ((result as unknown as { rows?: R[] }).rows ?? (result as unknown as R[]));
  });
}

async function seed(): Promise<{ s: SeededRegistryPartner; token: string }> {
  const s = await seedRegistryPartner('platform');
  const role = await createRole({ scope: 'organization', orgId: s.orgId });
  await grantRolePermissions(role.id, [{ resource: '*', action: '*' }]);
  await assignUserToOrganization(s.userId, s.orgId, role.id);
  await fixtureSql`
    INSERT INTO ai_messages (session_id, role, content) VALUES
      (${s.chatSessionId}, 'user', 'Outlook will not open'),
      (${s.chatSessionId}, 'assistant', 'I rebuilt your mail profile; it works now.')`;
  const [user] = await fixtureSql`SELECT email FROM users WHERE id = ${s.userId}`;
  const token = await createAccessToken({
    sub: s.userId, email: String(user!.email), roleId: role.id, orgId: s.orgId, partnerId: s.partnerId,
    scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
  return { s, token };
}

async function sessionRow(id: string): Promise<Record<string, unknown>> {
  const [row] = await q<{ row: Record<string, unknown> }>(sql`SELECT to_jsonb(s) AS row FROM ai_sessions s WHERE id = ${id}::uuid`);
  return row!.row;
}

describe('chat ticket draft settlement (real Postgres)', () => {
  it('reserves sessionless, settles the reservation, writes the ledger row, marks the platform debit due, and leaves the chat session untouched', async () => {
    const { s, token } = await seed();
    const before = await sessionRow(s.chatSessionId);

    const res = await new Hono().route('/ai', aiRoutes).request(`/ai/sessions/${s.chatSessionId}/ticket-draft`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    const body = await res.json() as { data?: { subject: string } };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.data?.subject).toBe('Outlook fixed');
    expect(provider.create).toHaveBeenCalledTimes(1);

    const reservations = await q<{
      id: string; session_id: string | null; status: string; billing_source: string;
      credits_debit_due_at: string | null; credits_debited_at: string | null; actual_cost_cents: string | null;
    }>(sql`SELECT id, session_id, status, billing_source, credits_debit_due_at, credits_debited_at, actual_cost_cents
           FROM ai_budget_reservations WHERE org_id = ${s.orgId}::uuid`);
    expect(reservations).toHaveLength(1);
    const reservation = reservations[0]!;
    expect(reservation.status).toBe('settled');
    expect(reservation.session_id).toBeNull();
    expect(reservation.billing_source).toBe('platform');
    expect(Number(reservation.actual_cost_cents)).toBeGreaterThan(0);
    // Billing configured + platform funding: the debit was due, and the one
    // settling call made it under the reservation's idempotency key.
    expect(reservation.credits_debit_due_at).not.toBeNull();
    expect(reservation.credits_debited_at).not.toBeNull();
    expect(deductCalls).toEqual([{ key: `ai-settlement:${reservation.id}`, costCents: expect.any(Number) }]);

    const ledger = await q<{ session_id: string | null; source_ref: string | null; surface: string; funding_source: string; input_tokens: number }>(
      sql`SELECT session_id, source_ref, surface, funding_source, input_tokens FROM ai_invocations WHERE org_id = ${s.orgId}::uuid`,
    );
    expect(ledger).toEqual([expect.objectContaining({
      session_id: null, source_ref: 'ticket_draft', surface: 'chat', funding_source: 'platform',
    })]);

    // The chat session's binding, turn counters and totals are exactly as they were.
    expect(await sessionRow(s.chatSessionId)).toEqual(before);
  });
});
