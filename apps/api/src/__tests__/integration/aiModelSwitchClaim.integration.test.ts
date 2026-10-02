/**
 * W05 (#7603) spike constraint 3 against real Postgres: a session's model and
 * options change only between turns, and a switch is claimed only against the
 * turn it was planned on. The turn claim (reserveAiBudget + the session stamp,
 * one transaction under the org admission lock) enforces both.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AiBudgetSessionBusyError, releaseUnusedAiBudgetReservation, reserveAiBudget,
} from '../../services/aiBudgetReservations';
import { makeResolvedModel } from '../../services/aiModels/__fixtures__/resolvedModel';
import { readPreviousTurn } from '../../services/aiModels/modelTransition';
import { settleInvocation } from '../../services/aiModels/settleInvocation';
import { turnBindingFrom, withCarriedRates } from '../../services/aiModels/turnBinding';
import type { OfferingOptions } from '@breeze/shared';
import { closeRegistryFixtures, fixtureSql, seedOffering } from './aiModelRegistryFixtures';
import { seedPricedPlatformModel, seedRegistryPartner } from './helpers/aiModelRegistrySeed';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

async function setup() {
  const seed = await seedRegistryPartner('platform');
  const other = await seedOffering({ partnerId: seed.partnerId, platformModelId: await seedPricedPlatformModel(), enabled: true });
  const third = await seedOffering({ partnerId: seed.partnerId, platformModelId: await seedPricedPlatformModel(), enabled: true });
  const bindingFor = (offeringId: string, options: OfferingOptions = { effort: 'medium' }) => turnBindingFrom(makeResolvedModel('platform', {
    partnerId: seed.partnerId, orgId: seed.orgId, offering: { id: offeringId, displayName: offeringId }, options,
  }));
  /** A chat-turn claim exactly as the messages route makes it (guarded, chat key). */
  const claim = (offeringId: string, opts: { expectPrev?: string | null; options?: OfferingOptions; binding?: ReturnType<typeof bindingFor> } = {}) =>
    reserveAiBudget({
      orgId: seed.orgId, billingSource: 'platform', sessionId: seed.chatSessionId,
      idempotencyKey: `chat:${seed.chatSessionId}:${randomUUID()}`,
      binding: opts.binding ?? bindingFor(offeringId, opts.options),
      sessionSwitchGuard: { expectedPreviousChatReservationId: opts.expectPrev ?? null },
    });
  /** A ticket draft on the same session: a one-shot, never guarded. */
  const draft = (offeringId: string) => reserveAiBudget({
    orgId: seed.orgId, billingSource: 'platform', sessionId: seed.chatSessionId,
    idempotencyKey: `ticket-draft:${seed.chatSessionId}:${randomUUID()}`, binding: bindingFor(offeringId),
  });
  const stamped = async () => (await fixtureSql`SELECT offering_id, options FROM ai_sessions WHERE id = ${seed.chatSessionId}`)[0]!;
  const reservationCount = async () => Number((await fixtureSql`
    SELECT count(*)::int AS n FROM ai_budget_reservations WHERE session_id = ${seed.chatSessionId}`)[0]!.n);
  const idOf = (r: Awaited<ReturnType<typeof claim>>) => {
    if (r.kind === 'denied') throw new Error('unexpected denial');
    return r.reservationId;
  };
  /** A completed turn: its reservation is settled (superuser fixture; the settlement path is not under test here). */
  const markSettled = async (id: string) => {
    await fixtureSql`UPDATE ai_budget_reservations SET status = 'settled', settled_at = now(), actual_cost_cents = 0 WHERE id = ${id}`;
  };
  return { seed, other, third, bindingFor, claim, draft, stamped, reservationCount, idOf, markSettled };
}

describe.skipIf(!RUN)('model switch claim (W05)', () => {
  it('an offering change is refused while another active chat turn holds the session', async () => {
    const { seed, other, claim, stamped, reservationCount, idOf } = await setup();
    const first = idOf(await claim(seed.offeringId));
    await expect(claim(other, { expectPrev: first })).rejects.toBeInstanceOf(AiBudgetSessionBusyError);
    expect(String((await stamped()).offering_id)).toBe(seed.offeringId);
    // The refused claim rolled back whole: its reservation insert included.
    expect(await reservationCount()).toBe(1);
    await releaseUnusedAiBudgetReservation({ orgId: seed.orgId, reservationId: first });
  });

  it('an options change on the SAME offering is refused while a turn is in flight (Codex review finding 9)', async () => {
    const { seed, claim, stamped, reservationCount, idOf } = await setup();
    const first = idOf(await claim(seed.offeringId, { options: { effort: 'medium' } }));
    await expect(claim(seed.offeringId, { expectPrev: first, options: { effort: 'max' } })).rejects.toBeInstanceOf(AiBudgetSessionBusyError);
    expect((await stamped()).options).toEqual({ effort: 'medium' });
    expect(await reservationCount()).toBe(1);
    await releaseUnusedAiBudgetReservation({ orgId: seed.orgId, reservationId: first });
  });

  it('a stale plan is refused: another chat turn was claimed after the plan read the previous turn (Codex review finding 4)', async () => {
    const { seed, other, claim, idOf, markSettled } = await setup();
    const a = idOf(await claim(seed.offeringId));
    await markSettled(a);
    const b = idOf(await claim(seed.offeringId, { expectPrev: a }));   // planned with A newest: fine
    await markSettled(b);
    // A request that planned (and fit-checked) while A was newest claims after B completed.
    await expect(claim(other, { expectPrev: a })).rejects.toBeInstanceOf(AiBudgetSessionBusyError);
  });

  it('a one-shot on the same session (ticket draft) is never guarded and never becomes the previous chat turn (Codex review finding 3)', async () => {
    const { seed, other, claim, draft, idOf, markSettled } = await setup();
    const chatTurn = idOf(await claim(seed.offeringId));
    await markSettled(chatTurn);
    const d = await draft(other);
    expect(d.kind).not.toBe('denied');
    expect((await readPreviousTurn({ orgId: seed.orgId, sessionId: seed.chatSessionId }))!.reservationId).toBe(chatTurn);
  });

  it('a ticket-draft reservation after a chat turn is not the previous turn, and an ACTIVE draft never blocks a chat switch', async () => {
    const { seed, other, third, claim, draft, stamped, idOf, markSettled } = await setup();
    const chatTurn = idOf(await claim(seed.offeringId));
    await markSettled(chatTurn);
    // The draft stays active (in flight) and stamps its own binding on the session.
    const d = await draft(other);
    expect(d.kind).not.toBe('denied');
    // The next chat turn planned against the chat turn (not the draft) and switching
    // to a third offering is admitted: the draft is neither the generation nor in flight.
    const next = idOf(await claim(third, { expectPrev: chatTurn }));
    expect(next).toBeTruthy();
    expect(String((await stamped()).offering_id)).toBe(third);
  });

  it('a newest chat turn whose binding does not parse is "no previous turn" for the guard too (never wedges the session)', async () => {
    const { seed, other, claim, stamped, idOf, markSettled } = await setup();
    const first = idOf(await claim(seed.offeringId));
    await markSettled(first);
    // A binding this build cannot read (e.g. written by a newer build before a rollback).
    await fixtureSql`UPDATE ai_budget_reservations SET model_binding = ${fixtureSql.json({ v: 2 })} WHERE id = ${first}`;
    expect(await readPreviousTurn({ orgId: seed.orgId, sessionId: seed.chatSessionId })).toBeNull();
    // The route plans with previous = null, so it claims expecting null: admitted.
    idOf(await claim(other, { expectPrev: null }));
    expect(String((await stamped()).offering_id)).toBe(other);
  });

  it('once the turn\'s reservation is no longer active, the switch is stamped', async () => {
    const { seed, other, claim, stamped, idOf } = await setup();
    const first = idOf(await claim(seed.offeringId));
    await releaseUnusedAiBudgetReservation({ orgId: seed.orgId, reservationId: first });
    await claim(other, { expectPrev: null });
    expect(String((await stamped()).offering_id)).toBe(other);
  });

  it('two concurrent claims with different offerings: one wins, the loser stamps nothing', async () => {
    const { other, third, claim, stamped, reservationCount } = await setup();
    const results = await Promise.allSettled([claim(other), claim(third)]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(AiBudgetSessionBusyError);
    const winner = results.indexOf(won[0]!) === 0 ? other : third;
    expect(String((await stamped()).offering_id)).toBe(winner);
    expect(await reservationCount()).toBe(1);
  });

  it('carried rates settle through the REAL settlement path, each key at its own rate (Codex review finding 2)', async () => {
    const { seed, bindingFor, claim, idOf } = await setup();
    const CARRIED = { source: 'platform' as const, standard: { inputCentsPerM: 100, outputCentsPerM: 500, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 } };
    const binding = withCarriedRates(bindingFor(seed.offeringId), [{ wireModel: 'w05-carried-model', rateSnapshot: CARRIED }]);
    const reservationId = idOf(await claim(seed.offeringId, { binding }));
    await settleInvocation({
      binding, orgId: seed.orgId, userId: seed.userId, sessionId: seed.chatSessionId, agentRunId: null, sourceRef: null,
      reservationId,
      usage: [
        { model: 'w05-carried-model', tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0, speedServed: 'standard', providerModel: null },
        { model: binding.wireModel, tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0, speedServed: 'standard', providerModel: null },
      ],
      outcome: {
        stopReason: 'end_turn', refused: false, refusalCategory: null, fallbackUsed: false, servedModel: binding.wireModel,
        providerModel: null, sdkReportedCostUsd: null, fastDowngraded: false,
      },
    });
    const rows = await fixtureSql`
      SELECT requested_model, served_model, cost_cents FROM ai_invocations
      WHERE session_id = ${seed.chatSessionId} AND ledger_mode = 'authoritative'`;
    const carriedRow = rows.find((r) => r.requested_model === 'w05-carried-model' || r.served_model === 'w05-carried-model')!;
    expect(Number(carriedRow.cost_cents)).toBe(100);   // 1M input tokens at the CARRIED 100¢/M, not the bound 200¢/M
    const boundRow = rows.find((r) => r.requested_model === binding.wireModel)!;
    expect(Number(boundRow.cost_cents)).toBe(200);     // the bound key at the bound 200¢/M
  });
});
