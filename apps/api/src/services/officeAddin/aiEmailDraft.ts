import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

/**
 * AI email -> ticket draft (spec Task 19, Outlook tech add-in).
 *
 * Mirrors ../aiTicketDraft.ts's shape (direct `new Anthropic()`, 2-attempt
 * retry, zod-validated JSON-only output) but over a raw customer email
 * instead of a chat transcript.
 *
 * IMPORTANT: this is a PREFILL only. The model must never invent or choose
 * customer identity, org, contact, or thread fields — those are resolved
 * deterministically by the route/pane from the email envelope. The output
 * schema below intentionally has no room for any such field.
 */

export interface EmailDraftInput {
  subject: string;
  bodyText: string;
  threadContext?: string | null;
  model: string;
}

export interface EmailDraftResult {
  subject: string;
  summary: string;
  suggestedTimeMinutes: number;
  inputTokens: number;
  outputTokens: number;
}

const MIN_SUGGESTED_MINUTES = 5;
const MAX_SUGGESTED_MINUTES = 480;

const llmSchema = z.object({
  subject: z.string().min(1).max(120),
  summary: z.string().min(1),
  suggestedTimeMinutes: z.number().int(),
});

const SYSTEM_PROMPT = [
  'You turn a customer support email into a prefill for a support ticket.',
  'Return ONLY a JSON object with keys: subject (<=120 chars, an imperative problem statement, e.g. "Fix Outlook crash on launch"), summary (3-6 sentences describing the issue for the ticket body), suggestedTimeMinutes (integer, estimated hands-on minutes to resolve).',
  'Never invent or state the customer\'s identity, organization, contact details, or email thread information — those are not yours to decide. Describe only the technical problem.',
  'Write plain English. No jargon, no markdown, no internal tool names.',
].join(' ');

function lastTextBlock(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i] as { type?: string; text?: string };
    if (b?.type === 'text' && typeof b.text === 'string') return b.text;
  }
  return null;
}

function buildUserContent(input: EmailDraftInput): string {
  const ctx = input.threadContext?.trim() ? `Prior thread context:\n${input.threadContext.trim()}\n\n` : '';
  return `${ctx}Subject: ${input.subject}\n\nBody:\n${input.bodyText}`;
}

function clamp(value: number): number {
  return Math.min(MAX_SUGGESTED_MINUTES, Math.max(MIN_SUGGESTED_MINUTES, Math.round(value)));
}

export async function draftTicketFromEmail(input: EmailDraftInput): Promise<EmailDraftResult> {
  const client = new Anthropic();
  const userContent = buildUserContent(input);
  let lastErr: unknown;
  let inTok = 0;
  let outTok = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await client.messages.create({
      model: input.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });
    inTok = resp.usage?.input_tokens ?? 0;
    outTok = resp.usage?.output_tokens ?? 0;
    const text = lastTextBlock(resp.content);
    if (text) {
      try {
        const parsed = llmSchema.parse(JSON.parse(text));
        return {
          subject: parsed.subject,
          summary: parsed.summary,
          suggestedTimeMinutes: clamp(parsed.suggestedTimeMinutes),
          inputTokens: inTok,
          outputTokens: outTok,
        };
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw new Error(`Failed to draft ticket from email: ${String(lastErr)}`);
}
