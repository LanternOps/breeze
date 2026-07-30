import { z } from 'zod';

/**
 * Typed action catalog for the M365 communications-delegated executor (design §7).
 *
 * Mail only, and deliberately small: the actions executor shipped with exactly two write
 * actions and that restraint is the precedent. Teams, attachments, reply/forward variants,
 * calendar, and mail move/categorize are all deferred — see design §11.
 *
 * Unlike its siblings this catalog is `user`-axis: every action runs as a named human via
 * a delegated grant, against `/me`, never against a tenant-wide app-only identity.
 */

// ---------------------------------------------------------------------------
// Caps — stated once here because three layers otherwise disagree (design §7).
// ---------------------------------------------------------------------------

/** Total recipients across to + cc + bcc, counted after normalization. */
export const M365_COMMS_MAX_RECIPIENTS = 20;
export const M365_COMMS_MAX_SUBJECT_CHARS = 500;
/** Counted in CODE POINTS, not UTF-16 code units — see `boundedText`. */
export const M365_COMMS_MAX_BODY_TEXT_CHARS = 32_000;
export const M365_COMMS_MAX_LIST_PAGE_SIZE = 25;
export const M365_COMMS_MAX_SINCE_HOURS = 720;
/** Executor truncates a retrieved body past this and flags it, mirroring `graph_response_too_large`. */
export const M365_COMMS_MAX_RETRIEVED_BODY_BYTES = 64 * 1024;
/**
 * Executor request-body ceiling. Deliberately 128 KiB rather than the sibling executors'
 * 16 KiB default: a 32,000-code-point body of astral characters is ~128 KB of UTF-8 before
 * JSON escaping, so the sibling default would reject valid mail.
 */
export const M365_COMMS_MAX_REQUEST_BODY_BYTES = 128 * 1024;

// ---------------------------------------------------------------------------
// Primitive schemas
// ---------------------------------------------------------------------------

/**
 * Rejects text that validates in Node but cannot survive the round trip to storage
 * and back (design §7, "the wire and text contract"):
 *
 * - **U+0000** — `JSON.stringify` escapes it happily; PostgreSQL `jsonb` rejects it
 *   outright. Without this check an intent that passes API validation fails on INSERT.
 * - **Ill-formed surrogate pairs** — an unpaired surrogate is escaped by well-formed
 *   `JSON.stringify` (ES2019) but is not valid UTF-8. It can round-trip differently
 *   than it was digested, which silently breaks the binding between approved and sent
 *   content.
 *
 * The scan is written out rather than using `String.prototype.isWellFormed` so this
 * module does not require an ES2024 lib target in every consumer.
 */
function isWellFormedText(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x0000) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: the next unit must be a low surrogate.
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : NaN;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++; // consume the pair
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Low surrogate with no preceding high surrogate.
      return false;
    }
  }
  return true;
}

/** Code-point length. `'\u{1F600}'.length` is 2; this returns 1. */
export function countCodePoints(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
}

/**
 * Bounded free text. `max` is in CODE POINTS: a user pasting emoji or CJK should get the
 * same allowance as one pasting ASCII, and a UTF-16-unit cap would silently halve it.
 */
function boundedText(max: number, label: string) {
  return z
    .string()
    .refine((v) => countCodePoints(v) <= max, {
      message: `${label} exceeds ${max} characters`,
    })
    .refine(isWellFormedText, {
      message: `${label} contains a NUL character or an ill-formed surrogate pair`,
    });
}

/**
 * Recipient address. Strict by intent: a single `@`, no quoting, no display-name form,
 * no comment syntax. Real RFC 5322 addresses are far more permissive, and that
 * permissiveness is a liability here — `"a@b"@c` and friends are parsed differently by
 * different mail stacks, which is precisely the kind of divergence the effect digest
 * exists to rule out. An address this rejects can be sent from Outlook; it cannot be
 * sent by an approved automated action, which is the intended trade.
 */
export const m365CommsEmailSchema = z
  .string()
  .min(3)
  .max(320)
  .regex(/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/, {
    message: 'must be a plain addr-spec email address',
  })
  .refine((v) => !v.includes('..'), { message: 'must not contain consecutive dots' });

/** Same constrained charset as `readActions.ts` — safe to splice into a Graph `$search`. */
const searchTermSchema = z.string().min(1).max(120).regex(/^[^"'\\]+$/);

/** Graph well-known folder names this catalog will address. */
export const M365_COMMS_MAIL_FOLDERS = ['inbox', 'sentitems', 'drafts', 'archive'] as const;
export type M365CommsMailFolder = typeof M365_COMMS_MAIL_FOLDERS[number];

/** Graph message ids are long, opaque, and base64url-ish with padding characters. */
const messageIdSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_\-=+/]+$/);

// ---------------------------------------------------------------------------
// Action ids, tiers, and projections
// ---------------------------------------------------------------------------

export const M365_COMMS_ACTION_IDS = [
  'm365.comms.mail.list',
  'm365.comms.mail.get',
  'm365.comms.mail.draft.create',
  'm365.comms.mail.send',
] as const;

export type M365CommsActionId = typeof M365_COMMS_ACTION_IDS[number];

/**
 * Guardrail tier per action. `send` is Tier 3 because its effect is a message attributable
 * to a named human; `draft.create` is Tier 2 because it is reversible (design §9.1).
 */
export const M365_COMMS_ACTION_TIERS: Record<M365CommsActionId, 1 | 2 | 3> = {
  'm365.comms.mail.list': 1,
  'm365.comms.mail.get': 1,
  'm365.comms.mail.draft.create': 2,
  'm365.comms.mail.send': 3,
};

/**
 * Per-action projection allowlists. The executor projects every returned object through
 * these; they are the only fields that ever leave it.
 *
 * Note `m365.comms.mail.list` has **no `body`** — a list operation must not be a bulk
 * mailbox export. `bodyPreview` is Graph's own short excerpt and is the deliberate
 * compromise.
 */
export const M365_COMMS_ACTION_FIELDS: Record<M365CommsActionId, readonly string[]> = {
  'm365.comms.mail.list': [
    'id', 'subject', 'from', 'toRecipients', 'receivedDateTime', 'sentDateTime',
    'isRead', 'hasAttachments', 'bodyPreview', 'conversationId', 'internetMessageId',
  ],
  'm365.comms.mail.get': [
    'id', 'subject', 'from', 'toRecipients', 'ccRecipients', 'receivedDateTime', 'sentDateTime',
    'isRead', 'hasAttachments', 'bodyPreview', 'conversationId', 'internetMessageId',
    'body', 'attachments',
  ],
  'm365.comms.mail.draft.create': ['id', 'webLink'],
  // A send returns no content to project; the result carries only status metadata.
  'm365.comms.mail.send': [],
};

/**
 * Nested allowlist for `attachments` on `m365.comms.mail.get`. Names and sizes only —
 * attachment *content* is never returned in v1, since exfiltrating a mailbox one
 * attachment at a time would otherwise be a supported feature.
 */
export const M365_COMMS_ATTACHMENT_FIELDS: readonly string[] = [
  'id', 'name', 'contentType', 'size', 'isInline',
];

// ---------------------------------------------------------------------------
// Action union
// ---------------------------------------------------------------------------

/**
 * `inReplyToMessageId` is absent from every action here, deliberately (design §5.3). It is
 * the one field whose Graph plan is not a pure function of the envelope: `createReply`
 * builds a mutable draft partly from the original message and needs a second call to send
 * it, which is exactly the draft-send shape §8 bans for breaking content binding.
 * Threading returns with properly-designed reply variants.
 */
const mailListActionSchema = z.object({
  type: z.literal('m365.comms.mail.list'),
  folder: z.enum(M365_COMMS_MAIL_FOLDERS),
  search: searchTermSchema.optional(),
  sinceHours: z.number().int().min(1).max(M365_COMMS_MAX_SINCE_HOURS).optional(),
  pageSize: z.number().int().min(1).max(M365_COMMS_MAX_LIST_PAGE_SIZE).optional(),
}).strict().refine(
  (a) => a.search === undefined || a.sinceHours === undefined,
  { message: 'search and sinceHours are mutually exclusive: Graph rejects $search combined with $filter' },
);

const mailGetActionSchema = z.object({
  type: z.literal('m365.comms.mail.get'),
  messageId: messageIdSchema,
}).strict();

const mailDraftCreateActionSchema = z.object({
  type: z.literal('m365.comms.mail.draft.create'),
  to: z.array(m365CommsEmailSchema),
  cc: z.array(m365CommsEmailSchema).optional(),
  subject: boundedText(M365_COMMS_MAX_SUBJECT_CHARS, 'subject'),
  bodyText: boundedText(M365_COMMS_MAX_BODY_TEXT_CHARS, 'bodyText'),
}).strict();

const mailSendActionSchema = z.object({
  type: z.literal('m365.comms.mail.send'),
  to: z.array(m365CommsEmailSchema),
  cc: z.array(m365CommsEmailSchema).optional(),
  bcc: z.array(m365CommsEmailSchema).optional(),
  subject: boundedText(M365_COMMS_MAX_SUBJECT_CHARS, 'subject'),
  bodyText: boundedText(M365_COMMS_MAX_BODY_TEXT_CHARS, 'bodyText'),
}).strict();

/**
 * The Tier-1/2 actions that execute inline without an intent. The send variant is
 * deliberately excluded: a send reaches the executor only as the stored effect
 * envelope (commsExecutorContracts.ts), never as tool-input shape.
 */
export const m365CommsInlineActionSchema = z.discriminatedUnion('type', [
  mailListActionSchema, mailGetActionSchema, mailDraftCreateActionSchema,
]);
export type M365CommsInlineAction = z.infer<typeof m365CommsInlineActionSchema>;

export const m365CommsActionSchema = z.discriminatedUnion('type', [
  mailListActionSchema, mailGetActionSchema, mailDraftCreateActionSchema, mailSendActionSchema,
]);

export type M365CommsAction = z.infer<typeof m365CommsActionSchema>;

// ---------------------------------------------------------------------------
// Failure codes
// ---------------------------------------------------------------------------

/**
 * The sibling read set plus the codes this executor alone can produce. Each of the
 * comms-specific codes maps to a distinct operator action, which is why they are not
 * collapsed into a generic failure:
 *
 * - `delegated_reauth_required` — the human must sign in again (Reconnect UX).
 * - `credential_rotation_failed` — a refresh token was redeemed but the new one was lost;
 *   the connection is degraded and needs reconnecting.
 * - `effect_digest_mismatch` — what arrived is not what was approved. Never retry.
 * - `binding_stale` / `consent_superseded` — the mailbox was reconnected after approval;
 *   the request must be re-made and re-approved.
 */
export const m365CommsFailureCodeSchema = z.enum([
  'credential_unavailable',
  'application_token_invalid',
  'graph_permission_missing',
  'graph_license_required',
  'graph_not_found',
  'graph_throttled',
  'graph_response_too_large',
  'graph_request_timeout',
  'graph_transport_failed',
  'graph_response_invalid',
  'tenant_mismatch',
  'identity_token_invalid',
  'invalid_action',
  'delegated_reauth_required',
  'credential_rotation_failed',
  'mailbox_not_found',
  'message_not_found',
  'recipient_rejected',
  'effect_digest_mismatch',
  'binding_stale',
  'consent_superseded',
]);

export type M365CommsFailureCode = z.infer<typeof m365CommsFailureCodeSchema>;
