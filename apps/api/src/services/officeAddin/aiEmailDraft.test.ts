import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();

import { draftTicketFromEmail, EmailDraftFailedError } from './aiEmailDraft';
import { makeResolvedModel } from '../aiModels/__fixtures__/resolvedModel';
import { messagesUsage } from '../aiModels/invocationUsage';
import { turnBindingFrom } from '../aiModels/turnBinding';

const binding = turnBindingFrom(makeResolvedModel('platform'));

function reply(json: object, inTok = 100, outTok = 50) {
  return { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(json) }], usage: { input_tokens: inTok, output_tokens: outTok } };
}

const baseInput = {
  subject: 'Outlook will not open',
  bodyText: 'My Outlook crashes every time I open it. Please help ASAP.',
  threadContext: null,
  resolved: makeResolvedModel('platform'),
  client: { messages: { create: createMock } } as never,
};


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

describe('draftTicketFromEmail', () => {
  it('caps both retry attempts within the reserved operation budget', async () => {
    createMock.mockResolvedValueOnce(reply({
      subject: 'Outlook crashes', summary: 'Outlook crashes and needs investigation.', suggestedTimeMinutes: 20,
    }));

    await draftTicketFromEmail({
      ...baseInput,
      budgetCents: 4,
    });

    // The ceiling comes from the registry rate via costEstimator, never a model-id table.
    const sent = createMock.mock.calls[0]![0] as { max_tokens: number };
    expect(sent.max_tokens).toBeGreaterThan(0);
    expect(sent.max_tokens).toBeLessThanOrEqual(1024);
  });

  it('returns a structured draft from valid JSON', async () => {
    createMock.mockResolvedValueOnce(
      reply({ subject: 'Outlook crashes on launch', summary: 'The customer reports Outlook crashes every time it is opened. This is blocking their email access. Needs investigation of the mail profile or add-ins.', suggestedTimeMinutes: 20 })
    );
    const r = await draftTicketFromEmail(baseInput);
    expect(r.subject).toBe('Outlook crashes on launch');
    expect(r.summary).toContain('crashes');
    expect(r.suggestedTimeMinutes).toBe(20);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]!.message.usage).toMatchObject({ input_tokens: 100, output_tokens: 50 });
  });

  it('dispatches the resolved wire model through createMessage and returns every attempt for billing', async () => {
    createMock
      .mockResolvedValueOnce({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: { input_tokens: 100, output_tokens: 10 } })
      .mockResolvedValueOnce(reply({ subject: 's', summary: 'A summary long enough for a ticket body here.', suggestedTimeMinutes: 10 }, 120, 30));
    const r = await draftTicketFromEmail({ ...baseInput, resolved: makeResolvedModel('catalog') });
    expect(createMock.mock.calls[0]![0]).toMatchObject({ model: 'anthropic/claude-sonnet-5.5', max_tokens: 1024 });
    expect(r.attempts).toHaveLength(2);
  });

  it('a provider throw carries the attempts made so far and marks the outcome unknown', async () => {
    createMock.mockRejectedValue(new Error('socket'));
    await expect(draftTicketFromEmail(baseInput)).rejects.toMatchObject({
      name: 'EmailDraftFailedError', attempts: [], providerOutcomeUnknown: true,
    });
  });

  it('a refusal whose client-side fallback THROWS still hands back the refused (billed) attempt', async () => {
    createMock.mockResolvedValueOnce(REFUSED).mockRejectedValueOnce(new Error('socket'));
    const err = await draftTicketFromEmail({ ...baseInput, resolved: catalogWithFallback() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailDraftFailedError);
    expect((err as EmailDraftFailedError).providerOutcomeUnknown).toBe(true);
    expect((err as EmailDraftFailedError).attempts).toEqual([
      { wireModel: 'anthropic/claude-sonnet-5.5', message: REFUSED, call: 0 },
    ]);
  });

  it('recovers when the retry returns valid JSON', async () => {
    createMock
      .mockResolvedValueOnce({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: {} })
      .mockResolvedValueOnce(reply({ subject: 'Recovered subject', summary: 'A summary with enough words to be plausible for a ticket body description here.', suggestedTimeMinutes: 15 }));

    const r = await draftTicketFromEmail(baseInput);

    expect(r.subject).toBe('Recovered subject');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('keeps every attempt on a recovered retry', async () => {
    createMock
      .mockResolvedValueOnce({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: { input_tokens: 30, output_tokens: 10 } })
      .mockResolvedValueOnce(reply({ subject: 'Recovered subject', summary: 'A summary with enough words to be plausible for a ticket body description here.', suggestedTimeMinutes: 15 }, 100, 50));

    const r = await draftTicketFromEmail(baseInput);

    // Attempt 1's burned 30/10 must not be dropped when attempt 2 succeeds.
    expect(r.attempts.map((a) => a.message.usage.input_tokens)).toEqual([30, 100]);
    expect(r.attempts.map((a) => a.message.usage.output_tokens)).toEqual([10, 50]);
    // Two separate calls: a plain parse retry, NOT a refusal fallback.
    expect(r.attempts.map((a) => a.call)).toEqual([0, 1]);
    const billed = messagesUsage(binding, r.attempts);
    expect(billed.outcome).toMatchObject({ fallbackUsed: false, refused: false, refusalCategory: null });
  });

  it('retries once on malformed JSON then throws', async () => {
    createMock.mockResolvedValue({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: {} });
    await expect(draftTicketFromEmail(baseInput)).rejects.toThrow();
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('throws EmailDraftFailedError carrying BOTH failed attempts', async () => {
    createMock
      .mockResolvedValueOnce({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: { input_tokens: 40, output_tokens: 20 } })
      .mockResolvedValueOnce({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'still not json' }], usage: { input_tokens: 60, output_tokens: 30 } });

    const err = await draftTicketFromEmail(baseInput).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(EmailDraftFailedError);
    const failed = err as EmailDraftFailedError;
    expect(failed.attempts).toHaveLength(2);
    expect(failed.attempts.reduce((n, a) => n + a.message.usage.input_tokens, 0)).toBe(100);
    expect(failed.attempts.reduce((n, a) => n + a.message.usage.output_tokens, 0)).toBe(50);
    expect(failed.message).toContain('attempt 1:');
    expect(failed.message).toContain('attempt 2:');
  });

  it('records a per-attempt "no text block" error and never reports undefined', async () => {
    createMock.mockResolvedValue({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'tool_use' }], usage: { input_tokens: 10, output_tokens: 0 } });

    const err = await draftTicketFromEmail(baseInput).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(EmailDraftFailedError);
    expect((err as Error).message).toContain('no text block in model response');
    expect((err as Error).message).not.toContain('undefined');
    expect((err as EmailDraftFailedError).attempts).toHaveLength(2); // both attempts billed
  });

  it("attempt 2's no-text failure does not erase attempt 1's parse error", async () => {
    createMock
      .mockResolvedValueOnce({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: {} })
      .mockResolvedValueOnce({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [], usage: {} });

    const err = await draftTicketFromEmail(baseInput).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e
    );

    const message = (err as Error).message;
    expect(message).toMatch(/attempt 1: .*(SyntaxError|JSON)/);
    expect(message).toContain('attempt 2: no text block in model response');
  });

  it('wraps an API error so prior attempts stay diagnosable and metered', async () => {
    createMock
      .mockResolvedValueOnce({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: { input_tokens: 25, output_tokens: 5 } })
      .mockRejectedValueOnce(new Error('overloaded'));

    const err = await draftTicketFromEmail(baseInput).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(EmailDraftFailedError);
    expect((err as Error).message).toContain('attempt 1:');
    expect((err as Error).message).toContain('overloaded');
    expect((err as EmailDraftFailedError).attempts).toHaveLength(1);
    expect((err as EmailDraftFailedError).attempts[0]!.message.usage.input_tokens).toBe(25);
    expect((err as EmailDraftFailedError).providerOutcomeUnknown).toBe(true);
  });

  it('retries once on zod-invalid output then throws', async () => {
    // subject exceeds 120 chars -> schema invalid
    const longSubject = 'x'.repeat(200);
    createMock.mockResolvedValue(reply({ subject: longSubject, summary: 'Some summary text here that is long enough to pass minimal checks.', suggestedTimeMinutes: 10 }));
    await expect(draftTicketFromEmail(baseInput)).rejects.toThrow();
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('clamps suggestedTimeMinutes to the [5, 480] range (low)', async () => {
    createMock.mockResolvedValueOnce(reply({ subject: 's', summary: 'A summary that is long enough to be plausible for a ticket body here.', suggestedTimeMinutes: 0 }));
    const r = await draftTicketFromEmail(baseInput);
    expect(r.suggestedTimeMinutes).toBe(5);
  });

  it('clamps suggestedTimeMinutes to the [5, 480] range (high)', async () => {
    createMock.mockResolvedValueOnce(reply({ subject: 's', summary: 'A summary that is long enough to be plausible for a ticket body here.', suggestedTimeMinutes: 9999 }));
    const r = await draftTicketFromEmail(baseInput);
    expect(r.suggestedTimeMinutes).toBe(480);
  });
});
