import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();
const { getAnthropicClientForPartnerMock, resolveWireModelMock } = vi.hoisted(() => ({
  getAnthropicClientForPartnerMock: vi.fn(),
  resolveWireModelMock: vi.fn<(resolved: unknown, model: string) => { model: string; catalogPricing?: unknown }>((_resolved: unknown, model: string) => ({ model })),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: createMock }; },
}));
vi.mock('./llm/llmConfigResolver', () => ({
  getAnthropicClientForPartner: getAnthropicClientForPartnerMock,
  resolveWireModel: resolveWireModelMock,
}));

import { draftTicketFromTranscript, ThinTranscriptError } from './aiTicketDraft';

function reply(json: object, inTok = 100, outTok = 50) {
  return { content: [{ type: 'text', text: JSON.stringify(json) }], usage: { input_tokens: inTok, output_tokens: outTok } };
}

const transcript = [
  { role: 'user', content: 'Outlook will not open on my PC' },
  { role: 'assistant', content: 'I rebuilt your mail profile; it is working now.' },
];

beforeEach(() => {
  createMock.mockReset();
  getAnthropicClientForPartnerMock.mockReset();
  getAnthropicClientForPartnerMock.mockResolvedValue({
    client: { messages: { create: createMock } },
    resolved: { source: 'partner', partnerId: 'partner-1', apiKey: 'partner-key', model: 'claude-x' },
  });
});

describe('draftTicketFromTranscript', () => {
  it('returns a structured draft and maps wasFixed', async () => {
    createMock.mockResolvedValueOnce(reply({ subject: 'Outlook would not open', problemSummary: 'Outlook would not start.', resolutionSummary: 'Rebuilt the mail profile.', wasFixed: true, suggestedTimeMinutes: 15 }));
    const r = await draftTicketFromTranscript({ messages: transcript, contextSnapshot: null, elapsedMinutes: 25, model: 'claude-x', partnerId: 'partner-1' });
    expect(r.wasFixed).toBe(true);
    expect(r.subject).toBe('Outlook would not open');
    expect(r.outputTokens).toBe(50);
  });

  it('clamps suggestedTimeMinutes to the elapsed ceiling', async () => {
    createMock.mockResolvedValueOnce(reply({ subject: 's', problemSummary: 'p', resolutionSummary: '', wasFixed: false, suggestedTimeMinutes: 999 }));
    const r = await draftTicketFromTranscript({ messages: transcript, contextSnapshot: null, elapsedMinutes: 25, model: 'claude-x', partnerId: 'partner-1' });
    expect(r.suggestedTimeMinutes).toBeLessThanOrEqual(25);
  });

  it('blanks resolutionSummary when the issue was not fixed', async () => {
    createMock.mockResolvedValueOnce(reply({ subject: 's', problemSummary: 'p', resolutionSummary: 'leaked resolution text', wasFixed: false, suggestedTimeMinutes: 5 }));
    const r = await draftTicketFromTranscript({ messages: transcript, contextSnapshot: null, elapsedMinutes: 25, model: 'claude-x', partnerId: 'partner-1' });
    expect(r.resolutionSummary).toBe('');
  });

  it('recovers when retry returns valid JSON', async () => {
    createMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'not json' }], usage: {} })
      .mockResolvedValueOnce(reply({ subject: 'Recovered', problemSummary: 'p', resolutionSummary: 'r', wasFixed: true, suggestedTimeMinutes: 5 }));

    const r = await draftTicketFromTranscript({ messages: transcript, contextSnapshot: null, elapsedMinutes: 25, model: 'claude-x', partnerId: 'partner-1' });

    expect(r.subject).toBe('Recovered');
    expect(r.resolutionSummary).toBe('r');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on invalid JSON then throws', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'not json' }], usage: {} });
    await expect(draftTicketFromTranscript({ messages: transcript, contextSnapshot: null, elapsedMinutes: 25, model: 'claude-x', partnerId: 'partner-1' })).rejects.toThrow();
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('throws ThinTranscriptError when there is no assistant turn', async () => {
    await expect(draftTicketFromTranscript({ messages: [{ role: 'user', content: 'hi' }], contextSnapshot: null, elapsedMinutes: 5, model: 'claude-x', partnerId: 'partner-1' })).rejects.toBeInstanceOf(ThinTranscriptError);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('uses the Anthropic client resolved for the authenticated partner', async () => {
    createMock.mockResolvedValueOnce(reply({ subject: 'S', problemSummary: 'P', resolutionSummary: '', wasFixed: false, suggestedTimeMinutes: 5 }));

    await draftTicketFromTranscript({
      messages: transcript,
      contextSnapshot: null,
      elapsedMinutes: 5,
      model: 'claude-x',
      partnerId: 'partner-1',
    });

    expect(getAnthropicClientForPartnerMock).toHaveBeenCalledWith('partner-1', { surface: 'one_shot_ticket_draft', orgId: null });
  });

  it('translates the model for the client it resolved itself', async () => {
    // On the self-resolving path the caller never saw the endpoint, so the
    // translation has to happen here — otherwise a catalog endpoint receives
    // the platform-logical id and 404s.
    resolveWireModelMock.mockReturnValueOnce({ model: 'anthropic/claude-x' });
    createMock.mockResolvedValueOnce(reply({ subject: 'S', problemSummary: 'P', resolutionSummary: '', wasFixed: false, suggestedTimeMinutes: 5 }));

    await draftTicketFromTranscript({
      messages: transcript,
      contextSnapshot: null,
      elapsedMinutes: 5,
      model: 'claude-x',
      partnerId: 'partner-1',
    });

    expect(resolveWireModelMock).toHaveBeenCalledWith(expect.anything(), 'claude-x');
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'anthropic/claude-x' }),
    );
  });

  it('uses an injected resolved client without resolving a second time', async () => {
    createMock.mockResolvedValueOnce(reply({
      subject: 'S',
      problemSummary: 'P',
      resolutionSummary: '',
      wasFixed: false,
      suggestedTimeMinutes: 5,
    }));

    await draftTicketFromTranscript({
      messages: transcript,
      contextSnapshot: null,
      elapsedMinutes: 5,
      model: 'claude-x',
      partnerId: 'partner-1',
      client: { messages: { create: createMock } } as any,
    });

    expect(getAnthropicClientForPartnerMock).not.toHaveBeenCalled();
  });
});
