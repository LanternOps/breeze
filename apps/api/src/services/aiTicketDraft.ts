import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { maxOutputTokensForAiBudget } from './aiBudgetReservations';
import { appendCall, attemptsOf, createMessage, type MessageAttempt } from './aiModels/connectionFactory';
import type { ResolvedModel } from './aiModels/resolveModel';
import { costEstimator } from './aiModels/settleInvocation';

export interface DraftInput {
  messages: Array<{ role: string; content: string | null }>;
  contextSnapshot: unknown;
  elapsedMinutes: number;
  /** The registry resolution this draft dispatches on (wire model, params, rates). */
  resolved: ResolvedModel;
  client: Anthropic;
  /** Finite amount reserved for the complete two-attempt operation. */
  budgetCents?: number;
}
export interface DraftResult {
  subject: string;
  problemSummary: string;
  resolutionSummary: string;
  wasFixed: boolean;
  suggestedTimeMinutes: number;
  /** Every provider attempt made (tagged by `call`), for the route to bill via messagesUsage. */
  attempts: MessageAttempt[];
}
export class ThinTranscriptError extends Error {
  constructor() { super('Not enough conversation to draft a ticket'); this.name = 'ThinTranscriptError'; }
}
export class TicketDraftFailedError extends Error {
  constructor(
    message: string,
    public readonly attempts: MessageAttempt[],
    public readonly providerOutcomeUnknown: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TicketDraftFailedError';
  }
}

const llmSchema = z.object({
  subject: z.string().min(1).max(120),
  problemSummary: z.string().min(1),
  resolutionSummary: z.string(),
  wasFixed: z.boolean(),
  suggestedTimeMinutes: z.number().int().min(0),
});

const SYSTEM_PROMPT = [
  'You turn an IT support chat transcript into a support ticket for a non-technical reader (a customer or office manager).',
  'Write plain English. No jargon, no command output, no internal tool names.',
  'Return ONLY a JSON object with keys: subject (<=120 chars), problemSummary, resolutionSummary, wasFixed (boolean), suggestedTimeMinutes (integer).',
  'The resolution text is shown to the customer. Leave resolutionSummary as an empty string if the issue was not resolved.',
  'Set wasFixed true ONLY if the transcript shows the issue was actually verified fixed — not merely attempted.',
  'suggestedTimeMinutes is hands-on work time; seed it from the elapsed ceiling provided but reduce it for idle gaps or non-work chatter. Never exceed the elapsed ceiling.',
].join(' ');

function lastTextBlock(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i] as { type?: string; text?: string };
    if (b?.type === 'text' && typeof b.text === 'string') return b.text;
  }
  return null;
}

function buildUserContent(input: DraftInput): string {
  const lines = input.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && m.content.trim().length > 0)
    .map((m) => `${m.role === 'user' ? 'Technician/User' : 'Assistant'}: ${m.content!.trim()}`);
  const ctx = input.contextSnapshot ? `Context: ${JSON.stringify(input.contextSnapshot)}\n` : '';
  return `${ctx}Elapsed ceiling (minutes): ${input.elapsedMinutes}\n\nTranscript:\n${lines.join('\n')}`;
}

export async function draftTicketFromTranscript(input: DraftInput): Promise<DraftResult> {
  const hasAssistant = input.messages.some((m) => m.role === 'assistant' && m.content && m.content.trim().length > 0);
  if (!hasAssistant) throw new ThinTranscriptError();

  const userContent = buildUserContent(input);
  const maxTokens = input.budgetCents === undefined
    ? 1024
    : maxOutputTokensForAiBudget({
      prompt: `${SYSTEM_PROMPT}\n${userContent}`,
      requestedMaxOutputTokens: 1024,
      // Either attempt may consume its full output ceiling.
      budgetCents: input.budgetCents / 2,
      calculateCostCents: costEstimator(input.resolved), // registry rate, never a model-id table
    });
  if (maxTokens === null) {
    throw new TicketDraftFailedError('Ticket draft prompt exceeds the reserved budget', [], false);
  }
  const attempts: MessageAttempt[] = [];
  let lastErr: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    let outcome;
    try {
      outcome = await createMessage(input.client, input.resolved, {
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      });
    } catch (error) {
      // A refused attempt completed before its fallback threw: billed, keep it.
      appendCall(attempts, attemptsOf(error));
      throw new TicketDraftFailedError(
        'Ticket draft provider outcome is unknown',
        attempts,
        true,
        { cause: error },
      );
    }
    appendCall(attempts, outcome.attempts);
    const text = lastTextBlock(outcome.message.content);
    if (text) {
      try {
        const parsed = llmSchema.parse(JSON.parse(text));
        return {
          subject: parsed.subject,
          problemSummary: parsed.problemSummary,
          resolutionSummary: parsed.wasFixed ? parsed.resolutionSummary : '',
          wasFixed: parsed.wasFixed,
          suggestedTimeMinutes: Math.min(parsed.suggestedTimeMinutes, Math.max(0, Math.round(input.elapsedMinutes))),
          attempts,
        };
      } catch (err) { lastErr = err; }
    }
  }
  throw new TicketDraftFailedError(
    `Failed to draft ticket from transcript: ${String(lastErr)}`,
    attempts,
    false,
  );
}
