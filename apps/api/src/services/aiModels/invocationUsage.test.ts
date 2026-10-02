import { describe, expect, it } from 'vitest';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  messagesUsage,
  messagesUsageAfterDispatchError,
  newSdkTurnObservation,
  observeSdkMessage,
  parseSdkUsageSnapshot,
  sdkTurnUsage,
  type MessageLike,
  type SdkModelUsageLike,
  type SdkResultLike,
  type SdkUsageSnapshot,
} from './invocationUsage';
import type { TurnBinding } from './turnBinding';

const STD = { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 };
const B: TurnBinding = {
  v: 1, surface: 'chat', role: 'default', partnerId: 'p1', offeringId: 'off-1', connectionId: null,
  connectionKind: 'platform', configVersion: null, catalogRevisionId: null, funding: 'platform',
  logicalModel: 'claude-sonnet-5-5', wireModel: 'claude-sonnet-5-5', options: {}, thinkingMode: 'adaptive',
  inferenceGeo: null, wireFingerprint: 'f', rateSnapshot: { source: 'platform', standard: STD },
  refusalFallback: { offeringId: 'fb', wireModel: 'claude-haiku-4-5', rateSnapshot: { source: 'platform', standard: STD } },
};
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-4-5';
const OPUS = 'claude-opus-5-5';
const OPUS48 = 'claude-opus-4-8';
const T = { input: 100, output: 50, cacheRead: 1000, cacheWrite: 10 };

type Tok = { input: number; output: number; cacheRead: number; cacheWrite: number };
const tok = (input: number, output: number, cacheRead = 0, cacheWrite = 0): Tok => ({ input, output, cacheRead, cacheWrite });
const add = (a: Tok, b: Tok): Tok => tok(a.input + b.input, a.output + b.output, a.cacheRead + b.cacheRead, a.cacheWrite + b.cacheWrite);

/** The SDK's ModelUsage shape (cumulative per requested model id). costUSD is deliberately wrong. */
function mu(t: Tok, webSearchRequests = 0): SdkModelUsageLike {
  return {
    inputTokens: t.input, outputTokens: t.output, cacheReadInputTokens: t.cacheRead,
    cacheCreationInputTokens: t.cacheWrite, webSearchRequests, costUSD: 7.77,
  };
}
/** result.usage (per turn, main loop only). */
function ru(t: Tok, webSearchRequests = 0): NonNullable<SdkResultLike['usage']> {
  return {
    input_tokens: t.input, output_tokens: t.output, cache_read_input_tokens: t.cacheRead,
    cache_creation_input_tokens: t.cacheWrite, server_tool_use: { web_search_requests: webSearchRequests },
  };
}
function snap(models: Record<string, Tok | [Tok, number]>): SdkUsageSnapshot {
  return {
    version: 1,
    models: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, Array.isArray(v)
      ? { tokens: v[0], webSearchRequests: v[1] }
      : { tokens: v, webSearchRequests: 0 }])),
  };
}
function success(over: Partial<SdkResultLike> = {}): SdkResultLike {
  return { subtype: 'success', is_error: false, stop_reason: 'end_turn', total_cost_usd: 0.01, ...over };
}
const std = (model: string, tokens: Tok, webSearchRequests = 0) =>
  ({ model, tokens, webSearchRequests, speedServed: 'standard' as const, providerModel: null });

// Compile-time: the real SDK result / Messages API response feed these functions unchanged.
const _sdkResultFits: SdkResultLike = null as unknown as SDKResultMessage;
const _betaMessageFits: MessageLike = null as unknown as BetaMessage;
void _sdkResultFits; void _betaMessageFits;

describe('sdkTurnUsage — the provider never supplies a billing number', () => {
  it('a positive-but-wrong SDK cost is carried as telemetry only', () => {
    const out = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: null,
      result: success({ total_cost_usd: 9.99, usage: ru(T), modelUsage: { [SONNET]: mu(T) } }) });
    expect(out.usage).toEqual([std(SONNET, T)]);
    expect(out.outcome).toEqual({
      stopReason: 'end_turn', refused: false, refusalCategory: null, fallbackUsed: false,
      servedModel: SONNET, providerModel: null, sdkReportedCostUsd: 9.99, fastDowngraded: false,
    });
    expect(JSON.stringify(out.usage)).not.toMatch(/9\.99|7\.77|cost/i);
    expect(JSON.stringify(out)).not.toMatch(/cost(Cents|_cents)/i);
  });

  it('a zero SDK cost on a brand-new model still yields full token components', () => {
    const out = sdkTurnUsage({ binding: { ...B, wireModel: 'claude-new-6' }, observation: newSdkTurnObservation(),
      previousSnapshot: null,
      result: success({ total_cost_usd: 0, usage: ru(T), modelUsage: { 'claude-new-6': mu(T) } }) });
    expect(out.usage[0]).toEqual(std('claude-new-6', T));
    expect(out.outcome.sdkReportedCostUsd).toBe(0);
  });

  it('a session-scope refusal fallback: served by the fallback, per-key deltas, category kept', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'model_refusal_fallback', scope: 'session',
      fallback_model: HAIKU, api_refusal_category: 'cyber' });
    const prev = snap({ [SONNET]: tok(10, 10) });
    const out = sdkTurnUsage({ binding: B, observation: obs, previousSnapshot: prev,
      result: success({ usage: ru(T), modelUsage: { [SONNET]: mu(tok(15, 11)), [HAIKU]: mu(T) } }) });
    expect(out.usage).toEqual([std(SONNET, tok(5, 1)), std(HAIKU, T)]);
    expect(out.outcome).toMatchObject({ fallbackUsed: true, refused: false, refusalCategory: 'cyber', servedModel: HAIKU });
    expect(out.usageNote).toBe('delta');
    expect(out.usageConfirmed).toBe(true);
  });

  it('a refusal fallback on the first result: result.usage at the fallback, split unconfirmed', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'model_refusal_fallback', scope: 'session',
      fallback_model: HAIKU, api_refusal_category: 'cyber' });
    const out = sdkTurnUsage({ binding: B, observation: obs, previousSnapshot: null,
      result: success({ usage: ru(T), modelUsage: { [SONNET]: mu(tok(5, 1)), [HAIKU]: mu(T) } }) });
    expect(out.usage).toEqual([std(HAIKU, T)]);
    expect(out.usageNote).toBe('first_result');
    expect(out.usageConfirmed).toBe(false);
  });

  it('a local-scope (subagent) fallback does not change the main-loop model', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'model_refusal_fallback', scope: 'local', fallback_model: HAIKU });
    const out = sdkTurnUsage({ binding: B, observation: obs, previousSnapshot: null,
      result: success({ usage: ru(T), modelUsage: { [SONNET]: mu(T) } }) });
    expect(out.outcome.fallbackUsed).toBe(false);
    expect(out.outcome.servedModel).toBe(SONNET);
  });

  it('no fallback configured: refused with category', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'model_refusal_no_fallback', api_refusal_category: 'cyber' });
    expect(sdkTurnUsage({ binding: B, observation: obs, previousSnapshot: null,
      result: success({ stop_reason: 'refusal', usage: ru(T), modelUsage: { [SONNET]: mu(T) } }) }).outcome)
      .toMatchObject({ refused: true, stopReason: 'refusal', refusalCategory: 'cyber', fallbackUsed: false });
  });

  it('an older CLI with only stop_reason refusal: refused, category null', () => {
    expect(sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: null,
      result: success({ stop_reason: 'refusal', usage: ru(T), modelUsage: { [SONNET]: mu(T) } }) }).outcome)
      .toMatchObject({ refused: true, refusalCategory: null });
  });

  it('the fallback also declined: refused, served by the fallback', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'model_refusal_fallback', fallback_model: HAIKU, api_refusal_category: 'cyber' });
    expect(sdkTurnUsage({ binding: B, observation: obs, previousSnapshot: snap({ [SONNET]: tok(1, 1) }),
      result: success({ stop_reason: 'refusal', modelUsage: { [SONNET]: mu(tok(2, 2)), [HAIKU]: mu(T) } }) }).outcome)
      .toMatchObject({ refused: true, fallbackUsed: true, servedModel: HAIKU, refusalCategory: 'cyber' });
  });

  it('an overload fallback (no refusal message) is invisible to main-loop usage → priced at the primary model', () => {
    expect(sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: null,
      result: success({ usage: ru(T), modelUsage: { [SONNET]: mu(T) } }) }).usage[0]!.model).toBe(SONNET);
  });

  it('total_cost_usd 9.99 and costUSD never reach usage on the delta path either', () => {
    const out = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: snap({ [SONNET]: tok(1, 1) }),
      result: success({ total_cost_usd: 9.99, modelUsage: { [SONNET]: mu(add(tok(1, 1), T)) } }) });
    expect(out.usage).toEqual([std(SONNET, T)]);
    expect(out.outcome.sdkReportedCostUsd).toBe(9.99);
    expect(JSON.stringify(out.usage)).not.toMatch(/9\.99|7\.77|cost/i);
    expect(JSON.stringify(out.nextSnapshot)).not.toMatch(/9\.99|7\.77|cost/i);
  });

  it('fast requested via the binding is still billed standard: the SDK cannot confirm fast was served', () => {
    const out = sdkTurnUsage({ binding: { ...B, options: { speed: 'fast' } }, observation: newSdkTurnObservation(),
      previousSnapshot: snap({ [SONNET]: tok(0, 0) }),
      result: success({ modelUsage: { [SONNET]: mu(T) } }) });
    expect(out.usage).toEqual([std(SONNET, T)]);
    expect(out.usage.every((u) => u.speedServed === 'standard')).toBe(true);
  });
});

describe('sdkTurnUsage — cumulative modelUsage is billed as per-key deltas against the session snapshot', () => {
  it('two turns on one streaming session: the second bills only its own tokens', () => {
    const t1 = tok(100, 50, 1000, 10);
    const t2 = tok(40, 20, 1100, 5);
    const first = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: null,
      result: success({ usage: ru(t1), modelUsage: { [SONNET]: mu(t1) } }) });
    expect(first.usage).toEqual([std(SONNET, t1)]);
    expect(first.usageNote).toBe('first_result');
    expect(first.usageConfirmed).toBe(true);
    expect(first.nextSnapshot).toEqual(snap({ [SONNET]: t1 }));

    // Inside one live streaming query result.usage is NOT trusted; modelUsage is cumulative.
    const second = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: first.nextSnapshot,
      result: success({ usage: ru(add(t1, t2)), modelUsage: { [SONNET]: mu(add(t1, t2)) } }) });
    expect(second.usage).toEqual([std(SONNET, t2)]);
    expect(second.usageNote).toBe('delta');
    expect(second.usageConfirmed).toBe(true);
    expect(second.nextSnapshot).toEqual(snap({ [SONNET]: add(t1, t2) }));
  });

  it('resume onto the same model (cumulative carried from the transcript) bills only the delta', () => {
    const a = tok(6, 1750, 1711, 1029);
    const b = tok(4, 97, 3710, 1746);
    const out = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: snap({ [SONNET]: a }),
      result: success({ usage: ru(b), modelUsage: { [SONNET]: mu(add(a, b)) } }) });
    expect(out.usage).toEqual([std(SONNET, b)]);
    expect(out.nextSnapshot).toEqual(snap({ [SONNET]: add(a, b) }));
  });

  it('resume onto another model: the new key is billed, the unchanged old key is not', () => {
    const a = tok(6, 1750, 1711, 1029);
    const b = tok(4, 97, 1718, 1814);
    const out = sdkTurnUsage({ binding: { ...B, wireModel: OPUS, logicalModel: OPUS }, observation: newSdkTurnObservation(),
      previousSnapshot: snap({ [SONNET]: a }),
      result: success({ usage: ru(b), modelUsage: { [SONNET]: mu(a), [OPUS]: mu(b) } }) });
    expect(out.usage).toEqual([std(OPUS, b)]);
    expect(out.outcome).toMatchObject({ servedModel: OPUS, fallbackUsed: false });
    expect(out.nextSnapshot).toEqual(snap({ [SONNET]: a, [OPUS]: b }));
  });

  it('web search requests are billed as per-key deltas too', () => {
    const out = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(),
      previousSnapshot: snap({ [SONNET]: [tok(1, 1), 2] }),
      result: success({ modelUsage: { [SONNET]: mu(tok(3, 3), 5) } }) });
    expect(out.usage).toEqual([std(SONNET, tok(2, 2), 3)]);
  });

  it('a key with no delta yields no usage row', () => {
    const out = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(),
      previousSnapshot: snap({ [SONNET]: T, [HAIKU]: tok(1, 1) }),
      result: success({ modelUsage: { [SONNET]: mu(add(T, tok(1, 0))), [HAIKU]: mu(tok(1, 1)) } }) });
    expect(out.usage).toEqual([std(SONNET, tok(1, 0))]);
  });

  it('a decreased component re-baselines to CURRENT and bills result.usage capped by modelUsage, unconfirmed (review finding 3)', () => {
    const prevSnap = snap({ [SONNET]: T });
    const out = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: prevSnap,
      result: success({ usage: ru(tok(5, 5)), modelUsage: { [SONNET]: mu(tok(200, 60, 900, 20)) } }) });
    expect(out.usageNote).toBe('snapshot_regressed');
    expect(out.usageConfirmed).toBe(false);
    // This turn's own usage, same rule as first_result (capped componentwise by modelUsage).
    expect(out.usage).toEqual([std(SONNET, tok(5, 5))]);
    expect(out.outcome.servedModel).toBe(SONNET);
    // Re-baselined to what the CLI reports now, not the high-water mark.
    expect(out.nextSnapshot).toEqual(snap({ [SONNET]: tok(200, 60, 900, 20) }));
  });

  it('a regressed turn caps result.usage by the SUMMED current modelUsage', () => {
    const out = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: snap({ [SONNET]: T }),
      result: success({ usage: ru(tok(500, 500, 5000, 500)), modelUsage: { [SONNET]: mu(tok(1, 2, 3, 4)), [HAIKU]: mu(tok(1, 1)) } }) });
    expect(out.usageNote).toBe('snapshot_regressed');
    expect(out.usage).toEqual([std(SONNET, tok(2, 3, 3, 4))]);
  });

  it('after a reset (redeploy: counters restart small) the next turn bills its own delta, not $0', () => {
    // Long-lived session: high totals persisted. The CLI restarts with an empty transcript.
    const big = tok(900_000, 300_000, 5_000_000, 40_000);
    const reset = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: snap({ [SONNET]: big }),
      result: success({ usage: ru(tok(10, 5)), modelUsage: { [SONNET]: mu(tok(10, 5)) } }) });
    expect(reset.usageNote).toBe('snapshot_regressed');
    expect(reset.usage).toEqual([std(SONNET, tok(10, 5))]);
    const next = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: reset.nextSnapshot,
      result: success({ usage: ru(tok(7, 3)), modelUsage: { [SONNET]: mu(tok(17, 8)) } }) });
    expect(next.usageNote).toBe('delta');
    expect(next.usageConfirmed).toBe(true);
    expect(next.usage).toEqual([std(SONNET, tok(7, 3))]);
  });

  it('a regression keeps a VANISHED key at its last total (it is not regressing)', () => {
    const out = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(),
      previousSnapshot: snap({ [SONNET]: T, [HAIKU]: tok(9, 9) }),
      result: success({ usage: ru(tok(1, 1)), modelUsage: { [SONNET]: mu(tok(1, 1)) } }) });
    expect(out.usageNote).toBe('snapshot_regressed');
    expect(out.nextSnapshot).toEqual(snap({ [SONNET]: tok(1, 1), [HAIKU]: tok(9, 9) }));
  });

  it('a key that vanished from modelUsage bills no delta for it, is not a regression, and stays in the snapshot', () => {
    const out = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(),
      previousSnapshot: snap({ [SONNET]: T, [HAIKU]: tok(1, 1) }),
      result: success({ modelUsage: { [SONNET]: mu(add(T, T)) } }) });
    expect(out.usage).toEqual([std(SONNET, T)]);
    expect(out.usageNote).toBe('delta');
    expect(out.nextSnapshot).toEqual(snap({ [SONNET]: add(T, T), [HAIKU]: tok(1, 1) }));
    // and when it reappears at its old total, nothing is re-billed for it
    const back = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: out.nextSnapshot,
      result: success({ modelUsage: { [SONNET]: mu(add(T, T)), [HAIKU]: mu(tok(1, 1)) } }) });
    expect(back.usage).toEqual([]);
  });

  it('no snapshot: result.usage is billed, capped componentwise by the summed modelUsage', () => {
    const out = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: null,
      result: success({ usage: ru(tok(500, 50, 2000, 10), 4),
        modelUsage: { [SONNET]: mu(tok(100, 80, 1500, 10), 1), [HAIKU]: mu(tok(50, 0, 0, 0), 1) } }) });
    expect(out.usage).toEqual([std(SONNET, tok(150, 50, 1500, 10), 2)]);
    expect(out.usageConfirmed).toBe(false); // two keys: the split is unknown
    expect(out.usageNote).toBe('first_result');
    expect(out.nextSnapshot).toEqual(snap({ [SONNET]: [tok(100, 80, 1500, 10), 1], [HAIKU]: [tok(50, 0, 0, 0), 1] }));
  });

  it('no snapshot and no result.usage: bills nothing rather than a possibly-cumulative total', () => {
    const out = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: null,
      result: success({ modelUsage: { [SONNET]: mu(T) } }) });
    expect(out.usage).toEqual([]);
    expect(out.usageConfirmed).toBe(false);
    expect(out.nextSnapshot).toEqual(snap({ [SONNET]: T }));
  });

  it('an aborted turn (no result): zero usage, error outcome, snapshot unchanged', () => {
    const prev = snap({ [SONNET]: T });
    const out = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: prev, result: null });
    expect(out.usage).toEqual([]);
    expect(out.outcome).toMatchObject({ stopReason: 'error', servedModel: SONNET, sdkReportedCostUsd: null });
    expect(out.usageConfirmed).toBe(false);
    expect(out.usageNote).toBe('no_result');
    expect(out.nextSnapshot).toBe(prev);
  });

  it('an error result with zeroed modelUsage is untrusted: zero usage, snapshot unchanged', () => {
    const prev = snap({ [SONNET]: T });
    const out = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: prev,
      result: { subtype: 'error_during_execution', is_error: true, stop_reason: null, total_cost_usd: 0,
        usage: ru(tok(0, 0)), modelUsage: {} } });
    expect(out.usage).toEqual([]);
    expect(out.usageNote).toBe('no_result');
    expect(out.nextSnapshot).toBe(prev);
    expect(out.outcome.stopReason).toBe('error');
  });

  it('a startup-failure result is untrusted even if it carries numbers', () => {
    const prev = snap({ [SONNET]: T });
    const out = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: prev,
      result: { subtype: 'error_during_execution', is_error: true, startup_failure_reason: 'x',
        modelUsage: { [SONNET]: mu(add(T, T)) } } });
    expect(out.usage).toEqual([]);
    expect(out.usageNote).toBe('no_result');
    expect(out.nextSnapshot).toBe(prev);
  });

  it('a malformed modelUsage entry is untrusted: zero usage, snapshot unchanged', () => {
    const prev = snap({ [SONNET]: T });
    const out = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: prev,
      result: success({ modelUsage: { [SONNET]: { ...mu(add(T, T)), outputTokens: -1 } } }) });
    expect(out.usage).toEqual([]);
    expect(out.usageNote).toBe('no_result');
    expect(out.nextSnapshot).toBe(prev);
  });

  it('an interrupted turn (error_during_execution with partial modelUsage) bills its delta, unconfirmed', () => {
    const out = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: snap({ [SONNET]: T }),
      result: { subtype: 'error_during_execution', is_error: true, stop_reason: 'tool_use', total_cost_usd: 0.2,
        modelUsage: { [SONNET]: mu(add(T, tok(3, 4))) } } });
    expect(out.usage).toEqual([std(SONNET, tok(3, 4))]);
    expect(out.usageNote).toBe('delta');
    expect(out.usageConfirmed).toBe(false);
    expect(out.outcome.stopReason).toBe('error');
    expect(out.nextSnapshot).toEqual(snap({ [SONNET]: add(T, tok(3, 4)) }));
  });

  it('a success turn that made no model call: nothing billed, snapshot kept', () => {
    const prev = snap({ [SONNET]: T });
    const out = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: prev,
      result: success({ usage: ru(tok(0, 0)), modelUsage: {} }) });
    expect(out.usage).toEqual([]);
    expect(out.usageNote).toBe('empty_usage');
    expect(out.usageConfirmed).toBe(true);
    expect(out.nextSnapshot).toBe(prev);
  });
});

describe('sdkTurnUsage — served model is read from the usage, never assumed', () => {
  it('CLI refusal fallback with no fallback_model: the new key is billed and becomes the served model', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'model_refusal_fallback', scope: 'session', api_refusal_category: null });
    const prev = snap({ [OPUS]: T });
    const out = sdkTurnUsage({ binding: { ...B, wireModel: OPUS, logicalModel: OPUS, refusalFallback: null },
      observation: obs, previousSnapshot: prev,
      result: success({ modelUsage: { [OPUS]: mu(add(T, tok(10, 0))), [OPUS48]: mu(tok(30, 40)) } }) });
    expect(out.usage).toEqual([std(OPUS, tok(10, 0)), std(OPUS48, tok(30, 40))]);
    expect(out.outcome).toMatchObject({ servedModel: OPUS48, fallbackUsed: true, refused: false });
  });

  it('a new key with no refusal message at all still sets the served model', () => {
    const out = sdkTurnUsage({ binding: { ...B, wireModel: OPUS, logicalModel: OPUS, refusalFallback: null },
      observation: newSdkTurnObservation(), previousSnapshot: snap({ [OPUS]: T }),
      result: success({ modelUsage: { [OPUS]: mu(add(T, tok(0, 0, 0, 5))), [OPUS48]: mu(tok(30, 40)) } }) });
    expect(out.usage.map((u) => u.model)).toEqual([OPUS, OPUS48]);
    expect(out.outcome).toMatchObject({ servedModel: OPUS48, fallbackUsed: true });
  });

  it('the swap is persistent: the next turn grows only the fallback key, which stays the served model', () => {
    const out = sdkTurnUsage({ binding: { ...B, wireModel: OPUS, logicalModel: OPUS, refusalFallback: null },
      observation: newSdkTurnObservation(), previousSnapshot: snap({ [OPUS]: T, [OPUS48]: tok(30, 40) }),
      result: success({ modelUsage: { [OPUS]: mu(T), [OPUS48]: mu(tok(60, 90)) } }) });
    expect(out.usage).toEqual([std(OPUS48, tok(30, 50))]);
    expect(out.outcome).toMatchObject({ servedModel: OPUS48, fallbackUsed: true });
  });

  it('#7766: a first-turn CLI refusal swap with no fallback_model labels the fallback as served and bills each key on its own row', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'model_refusal_fallback', scope: 'session', api_refusal_category: 'cyber' });
    const refused = tok(100, 5);
    const answered = tok(120, 60);
    const out = sdkTurnUsage({ binding: { ...B, wireModel: OPUS, logicalModel: OPUS, refusalFallback: null },
      observation: obs, previousSnapshot: null,
      result: success({ usage: ru(add(refused, answered)), modelUsage: { [OPUS]: mu(refused), [OPUS48]: mu(answered) } }) });
    expect(out.outcome).toMatchObject({ servedModel: OPUS48, fallbackUsed: true });
    expect(out.usage).toEqual([std(OPUS, refused), std(OPUS48, answered)]);
  });

  it('#7766: the bound refusal fallback\'s key is the served model when it grew', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'model_refusal_fallback', scope: 'session', api_refusal_category: null });
    const out = sdkTurnUsage({ binding: B, observation: obs, previousSnapshot: null,
      result: success({ usage: ru(add(T, T)), modelUsage: { [SONNET]: mu(T), [HAIKU]: mu(T) } }) });
    expect(out.outcome).toMatchObject({ servedModel: HAIKU, fallbackUsed: true });
  });

  it('#7766: when modelUsage also carries earlier turns, the capped turn usage is attributed to the fallback, not the bound model', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'model_refusal_fallback', scope: 'session', api_refusal_category: null });
    const turn = tok(50, 20);
    const out = sdkTurnUsage({ binding: { ...B, wireModel: OPUS, logicalModel: OPUS, refusalFallback: null },
      observation: obs, previousSnapshot: null,
      // a resumed transcript: OPUS carries earlier turns, so the per-key split is only a ceiling
      result: success({ usage: ru(turn), modelUsage: { [OPUS]: mu(tok(900, 400)), [OPUS48]: mu(tok(30, 15)) } }) });
    expect(out.outcome).toMatchObject({ servedModel: OPUS48 });
    expect(out.usage).toEqual([std(OPUS48, turn)]);
  });

  it('without a refusal swap, two grown keys on a first result still bill as the bound model (unchanged)', () => {
    const out = sdkTurnUsage({ binding: { ...B, wireModel: OPUS, logicalModel: OPUS, refusalFallback: null },
      observation: newSdkTurnObservation(), previousSnapshot: null,
      result: success({ usage: ru(tok(10, 5)), modelUsage: { [OPUS]: mu(tok(900, 400)), [OPUS48]: mu(tok(30, 15)) } }) });
    expect(out.outcome).toMatchObject({ servedModel: OPUS });
  });

  it('a single key on the first result is the served model even when it is not the bound one', () => {
    const out = sdkTurnUsage({ binding: B, observation: newSdkTurnObservation(), previousSnapshot: null,
      result: success({ usage: ru(T), modelUsage: { [OPUS48]: mu(T) } }) });
    expect(out.usage).toEqual([std(OPUS48, T)]);
    expect(out.outcome).toMatchObject({ servedModel: OPUS48, fallbackUsed: true });
  });
});

describe('W09: provider-failure observation', () => {
  it('an api_retry records the classified cause, its status and the CLI\'s attempt count', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: 'overloaded' });
    expect(obs.providerFailure).toEqual({ cause: 'overloaded', status: 529, retries: 2, terminal: false });
    expect(obs.sawOutput).toBe(false);
  });

  it('a synthetic API-error assistant message is a failure, not output', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'API Error: 429' }] } });
    expect(obs.providerFailure).toMatchObject({ cause: 'rate_limited' });
    expect(obs.sawOutput).toBe(false);
  });

  it('real assistant content (text, thinking, tool_use) is output', () => {
    for (const block of [{ type: 'text', text: 'hi' }, { type: 'thinking', thinking: '' }, { type: 'tool_use', id: 't', name: 'x', input: {} }]) {
      const obs = newSdkTurnObservation();
      observeSdkMessage(obs, { type: 'assistant', message: { content: [block] } });
      expect(obs.sawOutput).toBe(true);
    }
  });

  it('a streamed content block start is output (the user may already be reading it)', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    expect(obs.sawOutput).toBe(true);
  });

  it('a result with api_error_status records the failure', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'result', subtype: 'success', is_error: true, api_error_status: 401 });
    expect(obs.providerFailure).toMatchObject({ cause: 'auth_failed', status: 401 });
  });

  it('a later unclassified error clears an earlier cause (never fail over on a stale cause, D8)', () => {
    for (const later of [
      { type: 'system', subtype: 'api_retry', attempt: 2, error_status: null, error: 'unknown' },     // a timeout / reset after send
      { type: 'system', subtype: 'api_retry', attempt: 2, error_status: 400, error: 'invalid_request' },
      { type: 'assistant', error: 'invalid_request', message: { content: [] } },
      { type: 'result', subtype: 'success', is_error: true, api_error_status: 400 },
    ]) {
      const obs = newSdkTurnObservation();
      observeSdkMessage(obs, { type: 'system', subtype: 'api_retry', attempt: 1, error_status: 529, error: 'overloaded' });
      observeSdkMessage(obs, later);
      expect(obs.providerFailure).toBeNull();
    }
  });

  it('a non-failover error (invalid_request) records nothing', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'api_retry', attempt: 1, error_status: 400, error: 'invalid_request' });
    expect(obs.providerFailure).toBeNull();
  });

  it('the refusal and fast-mode observations are unchanged alongside it', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'api_retry', attempt: 1, error_status: 529, error: 'overloaded', fast_mode_state: 'cooldown' });
    observeSdkMessage(obs, { type: 'system', subtype: 'model_refusal_fallback', fallback_model: 'm2', api_refusal_category: 'cyber' });
    expect(obs.fastNotOnSeen).toBe(true);
    expect(obs.refusalFallback).toEqual({ fallbackModel: 'm2', category: 'cyber' });
    expect(obs.providerFailure).toMatchObject({ cause: 'overloaded' });
  });
});

/**
 * The frames the W09 lab (L1, docs/testing/lab/2026-10-02-ai-model-registry-w09-l1-l3.md)
 * recorded from the real CLI (agent-sdk 0.3.286), scrubbed. `BG` is the CLI's
 * own background call: it succeeds in every query, even when the main model fails.
 */
const BG = 'claude-haiku-4-5-20251001';
const LOW_CREDIT_TEXT = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
const syntheticError = (error: string) =>
  ({ type: 'assistant', error, message: { model: '<synthetic>', content: [{ type: 'text', text: `API Error: ${error}` }] } });
const failedResult = (status: number, text = 'API Error') => ({
  type: 'result', subtype: 'success', is_error: true, api_error_status: status, stop_reason: 'stop_sequence',
  result: text, total_cost_usd: 0.001, usage: ru(tok(0, 0)), modelUsage: { [BG]: mu(tok(900, 15)) },
});
const retries = (error: string, status: number, n = 3) =>
  Array.from({ length: n }, (_, i) => ({ type: 'system', subtype: 'api_retry', attempt: i + 1, max_retries: 3, retry_delay_ms: 0, error_status: status, error }));
const LAB_FAILED_TURNS = {
  lowCredit: { frames: [syntheticError('billing_error'), failedResult(400, LOW_CREDIT_TEXT)], cause: 'quota_exhausted' },
  overloaded: { frames: [...retries('overloaded', 529), syntheticError('server_error'), failedResult(529)], cause: 'overloaded' },
  rateLimited: { frames: [...retries('rate_limit', 429), syntheticError('rate_limit'), failedResult(429)], cause: 'rate_limited' },
  authFailed: { frames: [...retries('authentication_failed', 401), syntheticError('authentication_failed'), failedResult(401)], cause: 'auth_failed' },
} as const;
function observed(frames: readonly unknown[]) {
  const obs = newSdkTurnObservation();
  for (const f of frames) observeSdkMessage(obs, f);
  return obs;
}

describe('#7784: a later, less specific frame never clears the terminal cause', () => {
  it('low credit: the result\'s bare 400 keeps the billing_error frame\'s quota_exhausted (the lab sequence)', () => {
    const obs = observed(LAB_FAILED_TURNS.lowCredit.frames);
    expect(obs.providerFailure).toMatchObject({ cause: 'quota_exhausted', retries: 0 });
    expect(obs.sawOutput).toBe(false);
  });

  it.each(Object.entries(LAB_FAILED_TURNS))('%s: the lab sequence ends on its classified cause', (_name, turn) => {
    expect(observed(turn.frames).providerFailure).toMatchObject({ cause: turn.cause });
  });

  it('a terminal unclassified error (invalid_request) followed by the result\'s 400 stays cleared', () => {
    const obs = observed([...retries('overloaded', 529, 1), syntheticError('invalid_request'), failedResult(400)]);
    expect(obs.providerFailure).toBeNull();
  });

  it('a result with a classified status still replaces a terminal cause (529 is more specific than server_error)', () => {
    const obs = observed([syntheticError('server_error'), failedResult(529)]);
    expect(obs.providerFailure).toMatchObject({ cause: 'overloaded', status: 529 });
  });

  it('an api_retry after a terminal cause is a new request: it still decides (classified or cleared)', () => {
    const cleared = observed([syntheticError('billing_error'), { type: 'system', subtype: 'api_retry', attempt: 1, error_status: null, error: 'unknown' }, failedResult(400)]);
    expect(cleared.providerFailure).toBeNull();
    const replaced = observed([syntheticError('billing_error'), ...retries('rate_limit', 429, 1)]);
    expect(replaced.providerFailure).toMatchObject({ cause: 'rate_limited' });
  });
});

describe('#7786: the CLI\'s background call never labels a failed turn', () => {
  it.each(Object.entries(LAB_FAILED_TURNS))('%s on a query\'s first turn: served = bound, no fallback, nothing billed', (_name, turn) => {
    const obs = observed(turn.frames);
    const out = sdkTurnUsage({ binding: B, observation: obs, previousSnapshot: null, result: turn.frames.at(-1) as SdkResultLike });
    expect(out.outcome).toMatchObject({ servedModel: SONNET, fallbackUsed: false, stopReason: 'error', refused: false });
    // Billing unchanged: result.usage (main loop) is zero, so nothing is billed.
    expect(out.usage).toEqual([]);
    expect(out.usageNote).toBe('first_result');
    expect(out.usageConfirmed).toBe(false);
  });

  it('a failed later turn (snapshot present): the background delta is billed exactly as before, but never named as the served model', () => {
    const prev = snap({ [SONNET]: T, [BG]: tok(900, 15) });
    const frames = [...retries('rate_limit', 429), syntheticError('rate_limit'),
      { ...failedResult(429), modelUsage: { [SONNET]: mu(T), [BG]: mu(tok(1800, 30)) } }];
    const out = sdkTurnUsage({ binding: B, observation: observed(frames), previousSnapshot: prev, result: frames.at(-1) as SdkResultLike });
    expect(out.outcome).toMatchObject({ servedModel: SONNET, fallbackUsed: false, stopReason: 'error' });
    expect(out.usage).toEqual([std(BG, tok(900, 15))]);
    expect(out.usageNote).toBe('delta');
    expect(out.nextSnapshot).toEqual(snap({ [SONNET]: T, [BG]: tok(1800, 30) }));
  });

  it('a turn that produced output before failing keeps the observed served model', () => {
    const frames = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }, failedResult(529)];
    const out = sdkTurnUsage({ binding: B, observation: observed(frames), previousSnapshot: null,
      result: { ...(frames.at(-1) as SdkResultLike), usage: ru(tok(5, 5)), modelUsage: { [OPUS48]: mu(tok(5, 5)) } } });
    expect(out.outcome).toMatchObject({ servedModel: OPUS48, fallbackUsed: true });
  });

  it('a refusal fallback observed on a failed turn still names the fallback', () => {
    const frames = [{ type: 'system', subtype: 'model_refusal_fallback', fallback_model: HAIKU, api_refusal_category: 'cyber' }, failedResult(529)];
    const out = sdkTurnUsage({ binding: B, observation: observed(frames), previousSnapshot: null, result: frames.at(-1) as SdkResultLike });
    expect(out.outcome).toMatchObject({ servedModel: HAIKU, fallbackUsed: true });
  });
});

describe('parseSdkUsageSnapshot', () => {
  it('round-trips a valid snapshot', () => {
    const s = snap({ [SONNET]: [T, 2], [OPUS]: tok(1, 2, 3, 4) });
    expect(parseSdkUsageSnapshot(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['the wrong version', { version: 2, models: {} }],
    ['a missing models map', { version: 1 }],
    ['a negative count', { version: 1, models: { m: { tokens: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0 } } }],
    ['a non-finite count', { version: 1, models: { m: { tokens: { input: 1, output: Number.POSITIVE_INFINITY, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0 } } }],
    ['a missing component', { version: 1, models: { m: { tokens: { input: 1, output: 0, cacheRead: 0 }, webSearchRequests: 0 } } }],
    ['an unknown field', { version: 1, models: {}, costUsd: 1 }],
    ['an unknown entry field', { version: 1, models: { m: { tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0, costUSD: 1 } } }],
  ])('rejects %s', (_label, raw) => {
    expect(parseSdkUsageSnapshot(raw)).toBeNull();
  });
});

function msg(over: Partial<MessageLike> = {}): MessageLike {
  return {
    model: SONNET, stop_reason: 'end_turn', stop_details: null, content: [{ type: 'text' }],
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 },
    ...over,
  };
}
const mstd = (model: string, tokens: Tok, providerModel: string | null, webSearchRequests = 0) =>
  ({ model, tokens, webSearchRequests, speedServed: 'standard' as const, providerModel });

describe('messagesUsageAfterDispatchError', () => {
  it('bills the completed attempts at their real counts with an error outcome (refused leg keeps its category)', () => {
    const attempts = [{ wireModel: SONNET, message: msg({ stop_reason: 'refusal', stop_details: { category: 'cyber' } }) }];
    const out = messagesUsageAfterDispatchError(B, attempts);
    expect(out.usage).toEqual(messagesUsage(B, attempts).usage);
    expect(out.outcome).toMatchObject({ stopReason: 'error', refused: true, refusalCategory: 'cyber', fallbackUsed: false });
  });
});

describe('messagesUsage', () => {
  it('a plain response: one usage at the requested wire model', () => {
    const out = messagesUsage(B, [{ wireModel: SONNET, message: msg() }]);
    expect(out.usage).toEqual([mstd(SONNET, T, SONNET)]);
    expect(out.outcome).toMatchObject({
      stopReason: 'end_turn', refused: false, fallbackUsed: false, sdkReportedCostUsd: null,
      servedModel: SONNET, providerModel: SONNET,
    });
  });

  it('server-side fallback: per-model iterations, category from the fallback block', () => {
    const out = messagesUsage(B, [{ wireModel: SONNET, message: msg({
      content: [
        { type: 'fallback', from: { model: SONNET }, to: { model: HAIKU }, trigger: { category: 'cyber' } },
        { type: 'text' },
      ],
      usage: { input_tokens: 300, output_tokens: 80, iterations: [
        { type: 'message', model: SONNET, input_tokens: 100, output_tokens: 5 },
        { type: 'fallback_message', model: HAIKU, input_tokens: 200, output_tokens: 75 },
      ] },
    }) }]);
    expect(out.usage.map((u) => [u.model, u.tokens.input, u.tokens.output])).toEqual([
      [SONNET, 100, 5], [HAIKU, 200, 75],
    ]);
    expect(out.outcome).toMatchObject({ fallbackUsed: true, refused: false, refusalCategory: 'cyber', servedModel: HAIKU });
  });

  it('refusal with no fallback: category from stop_details', () => {
    expect(messagesUsage(B, [{ wireModel: SONNET,
      message: msg({ stop_reason: 'refusal', stop_details: { category: 'cyber' } }) }]).outcome)
      .toMatchObject({ refused: true, stopReason: 'refusal', refusalCategory: 'cyber' });
  });

  it('client-side (catalog) fallback: one usage per attempt at the model each attempt requested', () => {
    const out = messagesUsage(B, [
      { wireModel: SONNET, message: msg({ stop_reason: 'refusal', stop_details: { category: 'bio' } }) },
      { wireModel: HAIKU, message: msg({ model: 'provider/haiku' }) },
    ]);
    expect(out.usage.map((u) => [u.model, u.providerModel])).toEqual([[SONNET, SONNET], [HAIKU, 'provider/haiku']]);
    expect(out.outcome).toMatchObject({
      fallbackUsed: true, refused: false, refusalCategory: 'bio', servedModel: HAIKU, providerModel: 'provider/haiku',
    });
  });

  it('web search requests ride on the first usage of the attempt that made them', () => {
    const out = messagesUsage(B, [{ wireModel: SONNET,
      message: msg({ usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 3 } } }) }]);
    expect(out.usage[0]!.webSearchRequests).toBe(3);
  });

  it('the response model differs from the requested wire model: billed at the wire model, provider model recorded', () => {
    const out = messagesUsage(B, [{ wireModel: SONNET, message: msg({ model: 'claude-sonnet-5-5-20260901' }) }]);
    expect(out.usage).toEqual([mstd(SONNET, T, 'claude-sonnet-5-5-20260901')]);
    expect(out.outcome).toMatchObject({ servedModel: SONNET, providerModel: 'claude-sonnet-5-5-20260901', fallbackUsed: false });
  });

  it('fast is billed only when the response confirms usage.speed fast', () => {
    const fastBinding: TurnBinding = { ...B, options: { speed: 'fast' } };
    const confirmed = messagesUsage(fastBinding, [{ wireModel: SONNET,
      message: msg({ usage: { input_tokens: 1, output_tokens: 1, speed: 'fast' } }) }]);
    expect(confirmed.usage[0]!.speedServed).toBe('fast');
    for (const speed of ['standard', null, undefined] as const) {
      const out = messagesUsage(fastBinding, [{ wireModel: SONNET,
        message: msg({ usage: { input_tokens: 1, output_tokens: 1, speed } }) }]);
      expect(out.usage[0]!.speedServed).toBe('standard');
    }
  });

  it('fast confirmed on a response with iterations applies to every iteration of that attempt', () => {
    const out = messagesUsage(B, [{ wireModel: SONNET, message: msg({
      usage: { input_tokens: 2, output_tokens: 2, speed: 'fast', iterations: [
        { type: 'message', model: SONNET, input_tokens: 1, output_tokens: 1 },
        { type: 'message', model: SONNET, input_tokens: 1, output_tokens: 1 },
      ] },
    }) }]);
    expect(out.usage).toEqual([{ model: SONNET, tokens: tok(2, 2), webSearchRequests: 0, speedServed: 'fast', providerModel: SONNET }]);
  });
});

describe('messagesUsage across separate createMessage calls (a retry loop)', () => {
  const plain = (call: number, over: Partial<MessageLike> = {}) => ({ wireModel: SONNET, call, message: msg(over) });

  it('a plain retry is two ordinary calls: no fallback, no refusal, both billed', () => {
    const out = messagesUsage(B, [plain(0), plain(1)]);
    expect(out.usage.map((u) => [u.model, u.call, u.callOutcome?.fallbackUsed])).toEqual([[SONNET, 0, false], [SONNET, 1, false]]);
    expect(out.usage.map((u) => u.tokens)).toEqual([T, T]);
    expect(out.outcome).toMatchObject({ stopReason: 'end_turn', refused: false, fallbackUsed: false, refusalCategory: null, servedModel: SONNET });
  });

  it('a genuine client-side refusal fallback inside ONE call is still labelled', () => {
    const out = messagesUsage(B, [
      { wireModel: SONNET, call: 0, message: msg({ stop_reason: 'refusal', stop_details: { category: 'bio' } }) },
      { wireModel: HAIKU, call: 0, message: msg() },
      plain(1),
    ]);
    expect(out.usage.map((u) => [u.model, u.call, u.callOutcome?.fallbackUsed])).toEqual([[SONNET, 0, true], [HAIKU, 0, true], [SONNET, 1, false]]);
    expect(out.usage[2]!.callOutcome).toMatchObject({ refused: false, refusalCategory: null });
    expect(out.outcome).toMatchObject({ servedModel: SONNET, fallbackUsed: true });
  });

  it('a single call (no call tags) is interpreted exactly as before', () => {
    const out = messagesUsage(B, [
      { wireModel: SONNET, message: msg({ stop_reason: 'refusal', stop_details: { category: 'bio' } }) },
      { wireModel: HAIKU, message: msg() },
    ]);
    expect(out.usage.every((u) => u.call === undefined && u.callOutcome === undefined)).toBe(true);
    expect(out.outcome).toMatchObject({ fallbackUsed: true, refusalCategory: 'bio', servedModel: HAIKU });
  });

  it('after a dispatch error the LAST call is the errored one', () => {
    const out = messagesUsageAfterDispatchError(B, [plain(0), plain(1, { stop_reason: 'refusal', stop_details: { category: 'cyber' } })]);
    expect(out.outcome).toMatchObject({ stopReason: 'error', refused: true });
    expect(out.usage[0]!.callOutcome).toMatchObject({ stopReason: 'end_turn' });
    expect(out.usage[1]!.callOutcome).toMatchObject({ stopReason: 'error' });
  });
});
