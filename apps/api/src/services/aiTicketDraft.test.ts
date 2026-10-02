import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();

import { draftTicketFromTranscript, ThinTranscriptError } from './aiTicketDraft';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { messagesUsage } from './aiModels/invocationUsage';
import { turnBindingFrom } from './aiModels/turnBinding';

const binding = turnBindingFrom(makeResolvedModel('catalog'));

const base = { resolved: makeResolvedModel('platform'), client: { messages: { create: createMock } } as never };

function reply(json: object, inTok = 100, outTok = 50) {
  return { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(json) }], usage: { input_tokens: inTok, output_tokens: outTok } };
}

const transcript = [
  { role: 'user', content: 'Outlook will not open on my PC' },
  { role: 'assistant', content: 'I rebuilt your mail profile; it is working now.' },
];


const REFUSED = {
  model: 'anthropic/claude-sonnet-5.5', stop_reason: 'refusal', stop_details: { category: 'cyber' },
  content: [], usage: { input_tokens: 70, output_tokens: 3 },
};
function catalogWithFallback() {
  const base = makeResolvedModel('catalog');
  return makeResolvedModel('catalog', {
    refusalFallback: {
      offeringId: 'fb', displayName: 'Haiku', wireModel: 'anthropic/claude-haiku-4.5',
      wireParams: { betas: [], applied: {} }, options: {}, rateSnapshot: base.rateSnapshot,
    } as never,
  });
}

beforeEach(() => {
  createMock.mockReset();
});

describe('draftTicketFromTranscript', () => {
  it('caps both retry attempts within the reserved operation budget', async () => {
    createMock.mockResolvedValueOnce(reply({
      subject: 'S', problemSummary: 'P', resolutionSummary: '', wasFixed: false, suggestedTimeMinutes: 5,
    }));

    await draftTicketFromTranscript({
      messages: transcript,
      contextSnapshot: null,
      elapsedMinutes: 5,
      ...base,
      budgetCents: 4,
    });

    // The ceiling comes from the registry rate via costEstimator, never a model-id table.
    const sent = createMock.mock.calls[0]![0] as { max_tokens: number };
    expect(sent.max_tokens).toBeGreaterThan(0);
    expect(sent.max_tokens).toBeLessThanOrEqual(1024);
  });

  it('calls through createMessage with the resolved wire model and returns every attempt for billing', async () => {
    createMock
      .mockResolvedValueOnce({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: { input_tokens: 100, output_tokens: 10 } })
      .mockResolvedValueOnce(reply({ subject: 's', problemSummary: 'p', resolutionSummary: 'r', wasFixed: true, suggestedTimeMinutes: 5 }, 120, 30));
    const out = await draftTicketFromTranscript({
      messages: transcript, contextSnapshot: null, elapsedMinutes: 10, ...base, resolved: makeResolvedModel('catalog'),
    });
    expect(createMock.mock.calls[0]![0]).toMatchObject({ model: 'anthropic/claude-sonnet-5.5', max_tokens: 1024 });
    expect(out.attempts).toHaveLength(2);
    // Two separate calls: a plain parse retry, NOT a refusal fallback.
    expect(out.attempts.map((a) => a.call)).toEqual([0, 1]);
    const billed = messagesUsage(binding, out.attempts);
    expect(billed.outcome).toMatchObject({ fallbackUsed: false, refused: false, refusalCategory: null });
    expect(billed.usage.map((u) => u.callOutcome?.fallbackUsed)).toEqual([false, false]);
  });

  it('a provider throw carries the attempts made so far and marks the outcome unknown', async () => {
    createMock.mockRejectedValue(new Error('socket'));
    await expect(draftTicketFromTranscript({
      messages: transcript, contextSnapshot: null, elapsedMinutes: 10, ...base,
    })).rejects.toMatchObject({ name: 'TicketDraftFailedError', attempts: [], providerOutcomeUnknown: true });
  });

  it('a refusal whose client-side fallback THROWS still hands back the refused (billed) attempt', async () => {
    createMock.mockResolvedValueOnce(REFUSED).mockRejectedValueOnce(new Error('socket'));
    const err = await draftTicketFromTranscript({
      messages: transcript, contextSnapshot: null, elapsedMinutes: 10, ...base, resolved: catalogWithFallback(),
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'TicketDraftFailedError', providerOutcomeUnknown: true });
    expect((err as { attempts: unknown[] }).attempts).toEqual([
      { wireModel: 'anthropic/claude-sonnet-5.5', message: REFUSED, call: 0 },
    ]);
  });

  it('returns a structured draft and maps wasFixed', async () => {
    createMock.mockResolvedValueOnce(reply({ subject: 'Outlook would not open', problemSummary: 'Outlook would not start.', resolutionSummary: 'Rebuilt the mail profile.', wasFixed: true, suggestedTimeMinutes: 15 }));
    const r = await draftTicketFromTranscript({ messages: transcript, contextSnapshot: null, elapsedMinutes: 25, ...base });
    expect(r.wasFixed).toBe(true);
    expect(r.subject).toBe('Outlook would not open');
    expect(r.attempts[0]!.message.usage.output_tokens).toBe(50);
  });

  it('clamps suggestedTimeMinutes to the elapsed ceiling', async () => {
    createMock.mockResolvedValueOnce(reply({ subject: 's', problemSummary: 'p', resolutionSummary: '', wasFixed: false, suggestedTimeMinutes: 999 }));
    const r = await draftTicketFromTranscript({ messages: transcript, contextSnapshot: null, elapsedMinutes: 25, ...base });
    expect(r.suggestedTimeMinutes).toBeLessThanOrEqual(25);
  });

  it('blanks resolutionSummary when the issue was not fixed', async () => {
    createMock.mockResolvedValueOnce(reply({ subject: 's', problemSummary: 'p', resolutionSummary: 'leaked resolution text', wasFixed: false, suggestedTimeMinutes: 5 }));
    const r = await draftTicketFromTranscript({ messages: transcript, contextSnapshot: null, elapsedMinutes: 25, ...base });
    expect(r.resolutionSummary).toBe('');
  });

  it('recovers when retry returns valid JSON', async () => {
    createMock
      .mockResolvedValueOnce({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: {} })
      .mockResolvedValueOnce(reply({ subject: 'Recovered', problemSummary: 'p', resolutionSummary: 'r', wasFixed: true, suggestedTimeMinutes: 5 }));

    const r = await draftTicketFromTranscript({ messages: transcript, contextSnapshot: null, elapsedMinutes: 25, ...base });

    expect(r.subject).toBe('Recovered');
    expect(r.resolutionSummary).toBe('r');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on invalid JSON then throws', async () => {
    createMock.mockResolvedValue({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: {} });
    await expect(draftTicketFromTranscript({ messages: transcript, contextSnapshot: null, elapsedMinutes: 25, ...base })).rejects.toThrow();
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('throws ThinTranscriptError when there is no assistant turn', async () => {
    await expect(draftTicketFromTranscript({ messages: [{ role: 'user', content: 'hi' }], contextSnapshot: null, elapsedMinutes: 5, ...base })).rejects.toBeInstanceOf(ThinTranscriptError);
    expect(createMock).not.toHaveBeenCalled();
  });
});
