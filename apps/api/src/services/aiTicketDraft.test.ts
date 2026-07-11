import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: createMock }; },
}));

import { draftTicketFromTranscript, ThinTranscriptError } from './aiTicketDraft';

function reply(json: object, inTok = 100, outTok = 50) {
  return { content: [{ type: 'text', text: JSON.stringify(json) }], usage: { input_tokens: inTok, output_tokens: outTok } };
}

const transcript = [
  { role: 'user', content: 'Outlook will not open on my PC' },
  { role: 'assistant', content: 'I rebuilt your mail profile; it is working now.' },
];

beforeEach(() => createMock.mockReset());

describe('draftTicketFromTranscript', () => {
  it('returns a structured draft and maps wasFixed', async () => {
    createMock.mockResolvedValueOnce(reply({ subject: 'Outlook would not open', problemSummary: 'Outlook would not start.', resolutionSummary: 'Rebuilt the mail profile.', wasFixed: true, suggestedTimeMinutes: 15 }));
    const r = await draftTicketFromTranscript({ messages: transcript, contextSnapshot: null, elapsedMinutes: 25, model: 'claude-x' });
    expect(r.wasFixed).toBe(true);
    expect(r.subject).toBe('Outlook would not open');
    expect(r.outputTokens).toBe(50);
  });

  it('clamps suggestedTimeMinutes to the elapsed ceiling', async () => {
    createMock.mockResolvedValueOnce(reply({ subject: 's', problemSummary: 'p', resolutionSummary: '', wasFixed: false, suggestedTimeMinutes: 999 }));
    const r = await draftTicketFromTranscript({ messages: transcript, contextSnapshot: null, elapsedMinutes: 25, model: 'claude-x' });
    expect(r.suggestedTimeMinutes).toBeLessThanOrEqual(25);
  });

  it('blanks resolutionSummary when the issue was not fixed', async () => {
    createMock.mockResolvedValueOnce(reply({ subject: 's', problemSummary: 'p', resolutionSummary: 'leaked resolution text', wasFixed: false, suggestedTimeMinutes: 5 }));
    const r = await draftTicketFromTranscript({ messages: transcript, contextSnapshot: null, elapsedMinutes: 25, model: 'claude-x' });
    expect(r.resolutionSummary).toBe('');
  });

  it('recovers when retry returns valid JSON', async () => {
    createMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'not json' }], usage: {} })
      .mockResolvedValueOnce(reply({ subject: 'Recovered', problemSummary: 'p', resolutionSummary: 'r', wasFixed: true, suggestedTimeMinutes: 5 }));

    const r = await draftTicketFromTranscript({ messages: transcript, contextSnapshot: null, elapsedMinutes: 25, model: 'claude-x' });

    expect(r.subject).toBe('Recovered');
    expect(r.resolutionSummary).toBe('r');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on invalid JSON then throws', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'not json' }], usage: {} });
    await expect(draftTicketFromTranscript({ messages: transcript, contextSnapshot: null, elapsedMinutes: 25, model: 'claude-x' })).rejects.toThrow();
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('throws ThinTranscriptError when there is no assistant turn', async () => {
    await expect(draftTicketFromTranscript({ messages: [{ role: 'user', content: 'hi' }], contextSnapshot: null, elapsedMinutes: 5, model: 'claude-x' })).rejects.toBeInstanceOf(ThinTranscriptError);
    expect(createMock).not.toHaveBeenCalled();
  });
});
