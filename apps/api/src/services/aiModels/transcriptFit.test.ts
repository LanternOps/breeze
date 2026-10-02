import { describe, expect, it, vi } from 'vitest';
import { makeResolvedModel } from './__fixtures__/resolvedModel';
import {
  checkTranscriptFit,
  fitLimit,
  transcriptForCount,
  type TranscriptFitDeps,
} from './transcriptFit';

const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-4-5';

const haiku = makeResolvedModel('platform', {
  offering: { id: 'off-haiku', displayName: 'Haiku 4.5' },
  logicalModel: HAIKU, wireModel: HAIKU, thinking: 'budget',
  limits: { maxInputTokens: 200_000, maxOutputTokens: 64_000 },
});

const transcript = [
  { type: 'user', message: { role: 'user', content: 'look up alpha' } },
  { type: 'assistant', message: { role: 'assistant', model: SONNET, content: [
    { type: 'thinking', thinking: 'secret sonnet reasoning', signature: 'sig' },
    { type: 'text', text: 'Looking it up.' },
    { type: 'tool_use', id: 't1', name: 'mcp__breeze__lookup', input: { key: 'alpha' } },
  ] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bravo-7' }] } },
];

function deps(count: number | Error, entries: unknown[] = transcript): TranscriptFitDeps & { countTokens: ReturnType<typeof vi.fn> } {
  return {
    readTranscript: vi.fn(async () => entries as never),
    countTokens: vi.fn(async () => { if (count instanceof Error) throw count; return count; }),
  };
}

const input = { sdkSessionId: 'sdk-1', target: haiku, systemPrompt: 'You are Breeze.', pendingUserTurn: 'and now?', orgId: 'org-1' };

describe('fitLimit', () => {
  it('reserves headroom AND the output allowance: 200k/64k-out → 136k, 1M/128k-out → 868k', () => {
    expect(fitLimit(200_000, 64_000)).toBe(136_000);
    expect(fitLimit(1_000_000, 128_000)).toBe(868_000);
    expect(fitLimit(200_000, 8_000)).toBe(160_000);
    expect(fitLimit(200_000, null)).toBe(136_000);
  });
});

describe('checkTranscriptFit (W05 spike constraint 1)', () => {
  it('counts with the TARGET model\'s tokenizer through the target\'s connection', async () => {
    const d = deps(100_000);
    const fit = await checkTranscriptFit(input, d);
    expect(fit).toEqual({ kind: 'fits', countedTokens: 100_000, limitTokens: 136_000 });
    const [target, body, orgId] = d.countTokens.mock.calls[0]!;
    expect(target.wireModel).toBe(HAIKU);
    expect(target.connection).toBe(haiku.connection);
    expect(body.system).toBe('You are Breeze.');
    expect(orgId).toBe('org-1');
  });
  it('counts the incoming user message too (Codex review finding 5)', async () => {
    const d = deps(1_000);
    await checkTranscriptFit(input, d);
    const last = d.countTokens.mock.calls[0]![1].messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.content.at(-1)).toEqual({ type: 'text', text: 'and now?' });
  });
  it('a transcript over the target\'s limit is too_large', async () => {
    expect(await checkTranscriptFit(input, deps(212_762)))
      .toEqual({ kind: 'too_large', countedTokens: 212_762, limitTokens: 136_000 });
  });
  it('a count at the limit fits; one token over does not', async () => {
    expect((await checkTranscriptFit(input, deps(136_000))).kind).toBe('fits');
    expect((await checkTranscriptFit(input, deps(136_001))).kind).toBe('too_large');
  });
  it('a count failure or a missing transcript is unverifiable, never fits', async () => {
    expect(await checkTranscriptFit(input, deps(new Error('404 count_tokens not supported'))))
      .toEqual({ kind: 'unverifiable', reason: 'count_failed' });
    expect(await checkTranscriptFit(input, deps(1, [])))
      .toEqual({ kind: 'unverifiable', reason: 'no_transcript' });
  });
  it('a model with no known window is unverifiable', async () => {
    const t = { ...haiku, limits: { maxInputTokens: null, maxOutputTokens: 64_000 } };
    const d = deps(1);
    expect(await checkTranscriptFit({ ...input, target: t }, d)).toEqual({ kind: 'unverifiable', reason: 'no_window' });
    expect(d.countTokens).not.toHaveBeenCalled();
  });
  it('a connection kind with no counter (W06/W07 until they add one) is unverifiable and never counted', async () => {
    const t = { ...haiku, connection: { ...haiku.connection, kind: 'openai_compatible' as never } };
    const d = deps(1);
    expect(await checkTranscriptFit({ ...input, target: t }, d)).toEqual({ kind: 'unverifiable', reason: 'connection_kind' });
    expect(d.countTokens).not.toHaveBeenCalled();
  });
});

describe('transcriptForCount', () => {
  it('drops another model\'s thinking (the CLI never replays it), flattens tool blocks', () => {
    const msgs = transcriptForCount(transcript, HAIKU);
    expect(msgs).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'look up alpha' }] },
      { role: 'assistant', content: [
        { type: 'text', text: 'Looking it up.' },
        { type: 'text', text: '[tool_use mcp__breeze__lookup] {"key":"alpha"}' },
      ] },
      { role: 'user', content: [{ type: 'text', text: '[tool_result] bravo-7' }] },
    ]);
  });
  it('keeps the target\'s OWN thinking (a round trip replays it), matching dated served ids', () => {
    const own = [{ type: 'assistant', message: { role: 'assistant', model: `${HAIKU}-20251001`, content: [
      { type: 'thinking', thinking: 'haiku reasoning', signature: 's' },
    ] } }];
    expect(transcriptForCount(own, HAIKU)).toEqual([
      { role: 'user', content: [{ type: 'text', text: '(earlier conversation)' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'haiku reasoning' }] },
    ]);
  });
  it('counts only what follows the last compact boundary', () => {
    const entries = [
      { type: 'user', message: { role: 'user', content: 'old' } },
      { type: 'system', subtype: 'compact_boundary', message: {} },
      { type: 'user', message: { role: 'user', content: 'summary + new' } },
    ];
    expect(transcriptForCount(entries, HAIKU)).toEqual([{ role: 'user', content: [{ type: 'text', text: 'summary + new' }] }]);
  });
  it('keeps images in tool results (screenshots are large) and merges consecutive same-role turns', () => {
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    const entries = [
      { type: 'user', message: { role: 'user', content: 'a' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [img, { type: 'text', text: 'shot' }] }] } },
    ];
    expect(transcriptForCount(entries, HAIKU)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'a' }, img, { type: 'text', text: '[tool_result] shot' }] },
    ]);
  });
});
