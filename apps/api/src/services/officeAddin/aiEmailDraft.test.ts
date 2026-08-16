import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: createMock }; },
}));

import { draftTicketFromEmail } from './aiEmailDraft';

function reply(json: object, inTok = 100, outTok = 50) {
  return { content: [{ type: 'text', text: JSON.stringify(json) }], usage: { input_tokens: inTok, output_tokens: outTok } };
}

const baseInput = {
  subject: 'Outlook will not open',
  bodyText: 'My Outlook crashes every time I open it. Please help ASAP.',
  threadContext: null,
  model: 'claude-x',
};

beforeEach(() => createMock.mockReset());

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
  });

  it('recovers when the retry returns valid JSON', async () => {
    createMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'not json' }], usage: {} })
      .mockResolvedValueOnce(reply({ subject: 'Recovered subject', summary: 'A summary with enough words to be plausible for a ticket body description here.', suggestedTimeMinutes: 15 }));

    const r = await draftTicketFromEmail(baseInput);

    expect(r.subject).toBe('Recovered subject');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on malformed JSON then throws', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'not json' }], usage: {} });
    await expect(draftTicketFromEmail(baseInput)).rejects.toThrow();
    expect(createMock).toHaveBeenCalledTimes(2);
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
