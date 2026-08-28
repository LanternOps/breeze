import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();
const { getAnthropicClientForPartnerMock, resolveWireModelMock } = vi.hoisted(() => ({
  getAnthropicClientForPartnerMock: vi.fn(),
  resolveWireModelMock: vi.fn<(resolved: unknown, model: string) => { model: string; catalogPricing?: unknown }>((_resolved: unknown, model: string) => ({ model })),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: createMock }; },
}));
vi.mock('../llm/llmConfigResolver', () => ({
  getAnthropicClientForPartner: getAnthropicClientForPartnerMock,
  resolveWireModel: resolveWireModelMock,
}));

import { draftTicketFromEmail, EmailDraftFailedError } from './aiEmailDraft';

function reply(json: object, inTok = 100, outTok = 50) {
  return { content: [{ type: 'text', text: JSON.stringify(json) }], usage: { input_tokens: inTok, output_tokens: outTok } };
}

const baseInput = {
  subject: 'Outlook will not open',
  bodyText: 'My Outlook crashes every time I open it. Please help ASAP.',
  threadContext: null,
  model: 'claude-x',
  partnerId: 'partner-1',
};

beforeEach(() => {
  createMock.mockReset();
  // Identity by default so the rest of the suite reads plainly; the two
  // wire-translation tests below override it with a NON-identity mapping,
  // which is the only way a `model: input.model` regression is observable.
  resolveWireModelMock.mockReset();
  resolveWireModelMock.mockImplementation((_resolved: unknown, model: string) => ({ model }));
  getAnthropicClientForPartnerMock.mockReset();
  getAnthropicClientForPartnerMock.mockResolvedValue({
    client: { messages: { create: createMock } },
    resolved: { source: 'partner', partnerId: 'partner-1', apiKey: 'partner-key', model: 'claude-x' },
  });
});

describe('draftTicketFromEmail', () => {
  it('returns a structured draft from valid JSON', async () => {
    createMock.mockResolvedValueOnce(
      reply({ subject: 'Outlook crashes on launch', summary: 'The customer reports Outlook crashes every time it is opened. This is blocking their email access. Needs investigation of the mail profile or add-ins.', suggestedTimeMinutes: 20 })
    );
    const r = await draftTicketFromEmail(baseInput);
    expect(r.subject).toBe('Outlook crashes on launch');
    expect(r.summary).toContain('crashes');
    expect(r.suggestedTimeMinutes).toBe(20);
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(50);
    expect(getAnthropicClientForPartnerMock).toHaveBeenCalledWith('partner-1', { surface: 'one_shot_email_draft', orgId: null });
  });

  it('uses an injected resolved client without resolving a second time', async () => {
    createMock.mockResolvedValueOnce(
      reply({
        subject: 'Outlook crashes on launch',
        summary: 'The customer reports Outlook crashes whenever it opens and needs support.',
        suggestedTimeMinutes: 20,
      }),
    );

    await draftTicketFromEmail({
      ...baseInput,
      client: { messages: { create: createMock } } as any,
    });

    expect(getAnthropicClientForPartnerMock).not.toHaveBeenCalled();
  });

  /**
   * The self-resolving branch owns the wire translation (#3922 W3 review round
   * 2). Every other test here leaves `resolveWireModel` as an identity stub, so
   * a regression to `model: input.model` would sail through all of them — the
   * translated id and the logical id are the same string. These two pin the
   * branch with a NON-identity translation, which is the only way the
   * substitution is observable.
   */
  it('sends the RESOLVED wire model to the provider when it resolves its own client', async () => {
    resolveWireModelMock.mockReturnValueOnce({ model: 'anthropic/claude-x-wire' });
    createMock.mockResolvedValueOnce(
      reply({
        subject: 'Outlook crashes on launch',
        summary: 'The customer reports Outlook crashes whenever it opens and needs support.',
        suggestedTimeMinutes: 20,
      }),
    );

    await draftTicketFromEmail(baseInput);

    // Translated against the config this call actually resolved, keyed on the
    // caller's LOGICAL model id.
    expect(resolveWireModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'partner', partnerId: 'partner-1' }),
      'claude-x',
    );
    // …and it is the translated id that reaches the third-party endpoint. A
    // catalog endpoint 404s on the platform-logical id.
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'anthropic/claude-x-wire' }),
    );
  });

  it('sends an injected client the caller-supplied model verbatim, translating nothing', async () => {
    resolveWireModelMock.mockReturnValue({ model: 'anthropic/never-used' });
    createMock.mockResolvedValueOnce(
      reply({
        subject: 'Outlook crashes on launch',
        summary: 'The customer reports Outlook crashes whenever it opens and needs support.',
        suggestedTimeMinutes: 20,
      }),
    );

    await draftTicketFromEmail({
      ...baseInput,
      client: { messages: { create: createMock } } as any,
    });

    // `input.model` is ALREADY the wire id on this path — the caller translated
    // it against its own resolved config. Translating a second time would
    // double-map it into an id no provider knows.
    expect(resolveWireModelMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-x' }));
  });

  it('recovers when the retry returns valid JSON', async () => {
    createMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'not json' }], usage: {} })
      .mockResolvedValueOnce(reply({ subject: 'Recovered subject', summary: 'A summary with enough words to be plausible for a ticket body description here.', suggestedTimeMinutes: 15 }));

    const r = await draftTicketFromEmail(baseInput);

    expect(r.subject).toBe('Recovered subject');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('accumulates token counts across attempts on a recovered retry', async () => {
    createMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'not json' }], usage: { input_tokens: 30, output_tokens: 10 } })
      .mockResolvedValueOnce(reply({ subject: 'Recovered subject', summary: 'A summary with enough words to be plausible for a ticket body description here.', suggestedTimeMinutes: 15 }, 100, 50));

    const r = await draftTicketFromEmail(baseInput);

    // Attempt 1's burned 30/10 must not be dropped when attempt 2 succeeds.
    expect(r.inputTokens).toBe(130);
    expect(r.outputTokens).toBe(60);
  });

  it('retries once on malformed JSON then throws', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'not json' }], usage: {} });
    await expect(draftTicketFromEmail(baseInput)).rejects.toThrow();
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('throws EmailDraftFailedError carrying accumulated tokens from BOTH failed attempts', async () => {
    createMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'not json' }], usage: { input_tokens: 40, output_tokens: 20 } })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'still not json' }], usage: { input_tokens: 60, output_tokens: 30 } });

    const err = await draftTicketFromEmail(baseInput).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(EmailDraftFailedError);
    const failed = err as EmailDraftFailedError;
    expect(failed.inputTokens).toBe(100);
    expect(failed.outputTokens).toBe(50);
    expect(failed.message).toContain('attempt 1:');
    expect(failed.message).toContain('attempt 2:');
  });

  it('records a per-attempt "no text block" error and never reports undefined', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'tool_use' }], usage: { input_tokens: 10, output_tokens: 0 } });

    const err = await draftTicketFromEmail(baseInput).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(EmailDraftFailedError);
    expect((err as Error).message).toContain('no text block in model response');
    expect((err as Error).message).not.toContain('undefined');
    expect((err as EmailDraftFailedError).inputTokens).toBe(20); // both attempts metered
  });

  it("attempt 2's no-text failure does not erase attempt 1's parse error", async () => {
    createMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'not json' }], usage: {} })
      .mockResolvedValueOnce({ content: [], usage: {} });

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
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'not json' }], usage: { input_tokens: 25, output_tokens: 5 } })
      .mockRejectedValueOnce(new Error('overloaded'));

    const err = await draftTicketFromEmail(baseInput).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(EmailDraftFailedError);
    expect((err as Error).message).toContain('attempt 1:');
    expect((err as Error).message).toContain('overloaded');
    expect((err as EmailDraftFailedError).inputTokens).toBe(25);
    expect((err as EmailDraftFailedError).outputTokens).toBe(5);
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
