import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { getAnthropicClientForPartner, resolveWireModel } from '../llm/llmConfigResolver';

/**
 * AI email -> ticket draft (spec Task 19, Outlook tech add-in).
 *
 * Mirrors ../aiTicketDraft.ts's shape (resolved Anthropic client, 2-attempt
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
  partnerId: string | null;
  /**
   * Tenant axis for the LLM egress audit when this function has to resolve its
   * own client (#3922). Callers that pass `client` have already attributed the
   * call themselves.
   */
  orgId?: string | null;
  client?: Anthropic;
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

/**
 * Thrown when every attempt fails. Carries the token spend ACCUMULATED across
 * all attempts so the caller can still meter the burned tokens — a failed
 * draft is not a free one. The message concatenates every per-attempt error
 * (parse failure, "no text block", API error) so attempt 2 never erases
 * attempt 1's diagnosis.
 */
export class EmailDraftFailedError extends Error {
  constructor(
    message: string,
    public readonly inputTokens: number,
    public readonly outputTokens: number,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'EmailDraftFailedError';
  }
}

export async function draftTicketFromEmail(input: EmailDraftInput): Promise<EmailDraftResult> {
  // `input.model` is the WIRE model when the caller supplies its own client
  // (the caller already translated it via `resolveWireModel`). On the fallback
  // path we resolve the client here, so we must translate it here too.
  let client = input.client;
  let wireModel = input.model;
  if (!client) {
    const llm = await getAnthropicClientForPartner(input.partnerId, {
      surface: 'one_shot_email_draft',
      orgId: input.orgId ?? null,
    });
    client = llm.client;
    wireModel = resolveWireModel(llm.resolved, input.model).model;
  }
  const userContent = buildUserContent(input);
  const attemptErrors: string[] = [];
  // Accumulated across attempts: a successful retry still reports (and the
  // route still meters) attempt 1's burned tokens, and the failure error below
  // carries the full spend.
  let inTok = 0;
  let outTok = 0;

  const fail = (cause?: unknown): never => {
    throw new EmailDraftFailedError(
      `Failed to draft ticket from email: ${attemptErrors.join('; ')}`,
      inTok,
      outTok,
      cause === undefined ? undefined : { cause }
    );
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    let resp;
    try {
      resp = await client.messages.create({
        model: wireModel,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      });
    } catch (err) {
      // API/network error: same no-retry behavior as before (the pane has a
      // deterministic fallback), but wrapped so prior attempts' tokens meter.
      attemptErrors.push(`attempt ${attempt + 1}: ${String(err)}`);
      return fail(err);
    }
    inTok += resp.usage?.input_tokens ?? 0;
    outTok += resp.usage?.output_tokens ?? 0;
    const text = lastTextBlock(resp.content);
    if (!text) {
      attemptErrors.push(`attempt ${attempt + 1}: no text block in model response`);
      continue;
    }
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
      attemptErrors.push(`attempt ${attempt + 1}: ${String(err)}`);
    }
  }
  return fail();
}
