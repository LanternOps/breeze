import { beforeEach, describe, expect, it, vi } from 'vitest';

// readPreviousTurn's read and report (logging gap): the DB row and Sentry.
const dbm = vi.hoisted(() => ({ rows: [] as Array<{ id: string; model_binding: unknown }> }));
vi.mock('../../db', () => ({
  db: { execute: vi.fn(async () => dbm.rows) },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { makeResolvedModel } from './__fixtures__/resolvedModel';
import { planModelTransition, readPreviousTurn, type PreviousTurn } from './modelTransition';
import { captureException } from '../sentry';
import type { TranscriptFitDeps } from './transcriptFit';

const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-4-5';
const R = (input: number) => ({ source: 'linked_platform' as const, standard: { inputCentsPerM: input, outputCentsPerM: input * 5, cacheReadCentsPerM: input / 10, cacheWriteCentsPerM: input * 1.25 } });

// Target: BYOK Haiku 4.5 on conn-1 (config v2), 200k window / 64k out → fit limit 136k.
const haiku = makeResolvedModel('anthropic_byok', {
  offering: { id: 'off-haiku', displayName: 'Haiku 4.5' }, logicalModel: HAIKU, wireModel: HAIKU,
  rateSnapshot: R(100), limits: { maxInputTokens: 200_000, maxOutputTokens: 64_000 },
});
const prevSonnet: PreviousTurn = {
  reservationId: 'res-prev', wireModel: SONNET, connectionId: 'conn-1', configVersion: 2, catalogRevisionId: null,
  funding: 'partner_key', rateSnapshot: R(300), carriedRates: [],
};

let count: number | Error;
const deps: TranscriptFitDeps & { countTokens: ReturnType<typeof vi.fn> } = {
  readTranscript: vi.fn(async () => [{ type: 'user', message: { role: 'user', content: 'x' } }]),
  countTokens: vi.fn(async () => { if (count instanceof Error) throw count; return count; }),
};
beforeEach(() => { vi.clearAllMocks(); count = 1_000; });

const base = {
  orgId: 'org-1', sdkSessionId: 'sdk-1', sessionOfferingId: 'off-sonnet', previous: prevSonnet,
  target: haiku, systemPrompt: 'sys', pendingUserTurn: 'next',
};

describe('planModelTransition', () => {
  it('no SDK transcript yet → fresh, nothing counted', async () => {
    expect(await planModelTransition({ ...base, sdkSessionId: null }, deps)).toEqual({ kind: 'fresh' });
    expect(deps.countTokens).not.toHaveBeenCalled();
  });
  it('same wire model on the same connection → same_model (W03 reuse / rotation), carried rates kept', async () => {
    const carried = [{ wireModel: 'claude-opus-5-5', rateSnapshot: R(500) }];
    const r = await planModelTransition({ ...base, previous: { ...prevSonnet, wireModel: HAIKU, carriedRates: carried } }, deps);
    expect(r).toEqual({ kind: 'same_model', carriedRates: carried });
    expect(deps.countTokens).not.toHaveBeenCalled();
  });
  it('same model after a key rotation (config_version bump) → same_model: W03 resumes it, no switch', async () => {
    const r = await planModelTransition({ ...base, previous: { ...prevSonnet, wireModel: HAIKU, configVersion: 1 } }, deps);
    expect(r.kind).toBe('same_model');
  });
  it('another connection → continuation_required cross_connection, nothing counted', async () => {
    const r = await planModelTransition({ ...base, previous: { ...prevSonnet, connectionId: null, funding: 'platform' } }, deps);
    expect(r).toEqual({ kind: 'continuation_required', reason: 'cross_connection' });
    expect(deps.countTokens).not.toHaveBeenCalled();
  });
  it('same connection id but another funding source → cross_connection (never cross funding implicitly)', async () => {
    const r = await planModelTransition({ ...base, previous: { ...prevSonnet, funding: 'platform' } }, deps);
    expect(r).toMatchObject({ kind: 'continuation_required', reason: 'cross_connection' });
  });
  it('a model switch across a config_version or catalog-revision change → connection_changed (spec §9.2)', async () => {
    expect(await planModelTransition({ ...base, previous: { ...prevSonnet, configVersion: 1 } }, deps))
      .toEqual({ kind: 'continuation_required', reason: 'connection_changed' });
    const catalogTarget = { ...haiku, catalogRevisionId: 'rev-2' };
    expect(await planModelTransition({ ...base, target: catalogTarget, previous: { ...prevSonnet, catalogRevisionId: 'rev-1' } }, deps))
      .toEqual({ kind: 'continuation_required', reason: 'connection_changed' });
    expect(deps.countTokens).not.toHaveBeenCalled();
  });
  it('same connection, smaller target that fits → switch_resume carrying the previous model\'s rate', async () => {
    count = 100_000;
    const r = await planModelTransition(base, deps);
    expect(r).toEqual({
      kind: 'switch_resume',
      fit: { kind: 'fits', countedTokens: 100_000, limitTokens: 136_000 },
      carriedRates: [{ wireModel: SONNET, rateSnapshot: R(300) }],
    });
    expect(deps.countTokens.mock.calls[0]![0].wireModel).toBe(HAIKU);
  });
  it('a CHAINED switch carries every model switched away from: Opus → Sonnet → Haiku carries [opus, sonnet]', async () => {
    count = 100_000;
    const opus = { wireModel: 'claude-opus-5-5', rateSnapshot: R(500) };
    const r = await planModelTransition({ ...base, previous: { ...prevSonnet, carriedRates: [opus] } }, deps);
    expect(r).toMatchObject({ kind: 'switch_resume', carriedRates: [opus, { wireModel: SONNET, rateSnapshot: R(300) }] });
  });
  it('same connection, smaller target that does not fit → continuation_required transcript_too_large', async () => {
    count = 212_762;
    expect(await planModelTransition(base, deps)).toMatchObject({ kind: 'continuation_required', reason: 'transcript_too_large' });
  });
  it('a count that fails → continuation_required fit_unverifiable, never a resume', async () => {
    count = new Error('boom');
    expect(await planModelTransition(base, deps)).toMatchObject({ kind: 'continuation_required', reason: 'fit_unverifiable' });
  });
  it('no previous chat binding, the session already on the target OFFERING → same_model (offering fixes connection + funding)', async () => {
    expect(await planModelTransition({ ...base, previous: null, sessionOfferingId: 'off-haiku' }, deps)).toEqual({ kind: 'same_model', carriedRates: [] });
  });
  it('no previous chat binding and another offering — even one with the same logical model id — → fit_unverifiable (Codex review finding 1)', async () => {
    expect(await planModelTransition({ ...base, previous: null, sessionOfferingId: 'off-platform-haiku' }, deps))
      .toEqual({ kind: 'continuation_required', reason: 'fit_unverifiable' });
    expect(deps.countTokens).not.toHaveBeenCalled();
  });
});

describe('readPreviousTurn', () => {
  it('a newest chat turn whose binding does not parse reads as no previous turn, and is reported (never silently)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    dbm.rows = [{ id: 'res-x', model_binding: { v: 2 } }];
    expect(await readPreviousTurn({ orgId: 'org-1', sessionId: 'sess-1' })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[modelTransition]'), { orgId: 'org-1', sessionId: 'sess-1', reservationId: 'res-x' });
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), undefined, { org_id: 'org-1', ai_reservation_id: 'res-x' });
    warn.mockRestore();
  });
  it('no chat turn at all is null and silent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    dbm.rows = [];
    expect(await readPreviousTurn({ orgId: 'org-1', sessionId: 'sess-1' })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
