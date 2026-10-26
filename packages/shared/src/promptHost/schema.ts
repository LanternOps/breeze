import '../validators/topologyZod';
import { z } from 'zod';
import {
  PROMPT_ACTION_RESULTS,
  PROMPT_ACTION_ROLES,
  PROMPT_ACTION_VIAS,
  PROMPT_CLOSE_REASONS,
  PROMPT_CLOSED_REASONS,
  PROMPT_DIRECTIONS,
  PROMPT_FOCUS_MODES,
  PROMPT_KINDS,
  PROMPT_KIND_AD_PATTERN,
  PROMPT_KIND_NAME_PATTERN,
  PROMPT_LIMITS,
  PROMPT_PRESENTATIONS,
  PROMPT_STATES,
  isPromptDecision,
  isPromptKind,
} from './kinds';

/**
 * Zod schemas for the prompt host wire contract (#10190, spec §3.1). Every
 * payload is lowerCamel. These schemas pin the golden fixtures under
 * src/fixtures/prompt-host that the Go agent and the Rust Assist suites decode
 * and re-encode; they are the reference, not a runtime dependency of either
 * renderer.
 *
 * Rules every implementation mirrors:
 *  - Additive and forward compatible: decoders IGNORE unknown keys (these
 *    schemas strip them). New fields are optional.
 *  - Optional strings and arrays: absent and empty are the same (Go
 *    `omitempty`). Fixtures never carry `""` in an optional slot. Two
 *    exceptions are always emitted: `timing.expiry.actionId` (`null` = the
 *    expiry is not an action) and `prompt_update.actions` when present (`[]`
 *    means "no actions now", distinct from absent = unchanged).
 *  - String limits count Unicode code points (zod 4.6), not bytes: Go mirrors
 *    with utf8.RuneCountInString, Rust with chars().count().
 *  - Decision rule: a prompt is a decision while `state == "pending"` and
 *    `presentation != "indicator"`. A decision carries exactly one `safe`
 *    action and `defaultActionId` names it. After a `prompt_update`, the
 *    merged state must still satisfy `promptShowSchema` (`applyPromptUpdate`).
 *  - A kind outside the registry is treated as breeze-class (fails closed).
 *
 * Field notes beyond the spec's field list (each additive):
 *  - `prompt_show.kindVersion`: the version of `kind` the agent negotiated
 *    with this renderer (highest version both sides speak and the server
 *    enables). Without it a renderer advertising two versions cannot tell
 *    which one it was sent.
 *  - `lease.rendererSession` is the broker's session id for the renderer (the
 *    key the agent routes by), NOT the IPC HMAC session key: a lease is
 *    echoed in payloads and logs and must never carry a secret.
 *  - `prompt_closed.detail`: a short machine token saying why a renderer
 *    refused (`render_failed`), for the agent log.
 *  - In `prompt_update`, `actions` and `defaultActionId` travel together: when
 *    `actions` is present it replaces the actions AND the default (absent
 *    default = none); a default without actions is invalid.
 *  - `prompt_branding_sync.cleared` is always present (`true` | `false`).
 */

const MAX_U32 = 4_294_967_295;

/** Domain-derived, never random: `elevation:<id>`, `restart:<gen>`, `notice:<source>:<id>`. */
export const promptIdSchema = z
  .string()
  .max(200)
  .regex(/^[a-z][a-z_]*:[A-Za-z0-9._:-]+$/, 'promptId must be <domain>:<id>');

export const promptRevSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const promptLeaseSchema = z.object({
  rendererSession: z.string().min(1).max(200),
  epoch: z.number().int().min(1).max(MAX_U32),
});

export const promptKindNameSchema = z.string().max(64).regex(PROMPT_KIND_NAME_PATTERN);
export const promptKindAdSchema = z.string().max(68).regex(PROMPT_KIND_AD_PATTERN);

const actionIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

export const promptActionSpecSchema = z.object({
  id: actionIdSchema,
  label: z.string().min(1).max(80),
  role: z.enum(PROMPT_ACTION_ROLES),
});

export const promptCopySchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(2000).optional(),
  consequence: z.string().max(500).optional(),
  operatorNote: z.string().max(1000).optional(),
  stateDetail: z.string().max(500).optional(),
});

export const promptFactSchema = z.object({
  label: z.string().min(1).max(60),
  value: z.string().max(4000),
});

export const promptExpirySchema = z.object({
  /** Always emitted: the action expiry applies, or `null` when expiry is a stated consequence only. */
  actionId: actionIdSchema.nullable(),
  text: z.string().max(500),
});

export const promptTimingSchema = z
  .object({
    presentWithinMs: z.number().int().min(1).max(60_000),
    /** Absolute domain deadline (restart time, server request expiry). */
    deadlineUnixMs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    /** A window that starts at presentation; consent only. */
    responseMs: z
      .number()
      .int()
      .min(1)
      .max(24 * 60 * 60 * 1000)
      .optional(),
    expiry: promptExpirySchema.optional(),
  })
  .refine((t) => t.deadlineUnixMs === undefined || t.responseMs === undefined, {
    message: 'deadlineUnixMs and responseMs are exclusive',
  });

export const promptListEntrySchema = z.object({
  persistent: z.boolean(),
  expiresAtUnixMs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});

export const promptIdentityRefSchema = z.object({
  scopeId: z.string().regex(/^[0-9a-f]{32}$/),
  logoSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

const localeSchema = z
  .string()
  .max(35)
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);

type ActionList = Array<z.infer<typeof promptActionSpecSchema>>;

function checkActions(actions: ActionList, defaultActionId: string | undefined, ctx: z.core.$RefinementCtx): void {
  const ids = new Set<string>();
  for (const action of actions) {
    if (ids.has(action.id)) {
      ctx.addIssue({ code: 'custom', path: ['actions'], message: `duplicate action id ${action.id}` });
    }
    ids.add(action.id);
  }
  if (defaultActionId !== undefined && !ids.has(defaultActionId)) {
    ctx.addIssue({ code: 'custom', path: ['defaultActionId'], message: 'defaultActionId names no action' });
  }
}

const actionsSchema = z.array(promptActionSpecSchema).max(PROMPT_LIMITS.maxActionsPerState);
const factsSchema = z.array(promptFactSchema).max(8);

const promptShowObject = z.object({
  promptId: promptIdSchema,
  rev: promptRevSchema,
  lease: promptLeaseSchema,
  kind: promptKindNameSchema,
  kindVersion: z.number().int().min(1).max(999),
  state: z.enum(PROMPT_STATES),
  presentation: z.enum(PROMPT_PRESENTATIONS),
  copy: promptCopySchema,
  facts: factsSchema.optional(),
  actions: actionsSchema,
  defaultActionId: actionIdSchema.optional(),
  timing: promptTimingSchema,
  focus: z.enum(PROMPT_FOCUS_MODES),
  listEntry: promptListEntrySchema,
  locale: localeSchema,
  direction: z.enum(PROMPT_DIRECTIONS),
  identityRef: promptIdentityRefSchema.optional(),
});

/** `prompt_show` (agent → renderer): the full current state of one prompt. */
export const promptShowSchema = promptShowObject.superRefine((show, ctx) => {
  checkActions(show.actions, show.defaultActionId, ctx);
  if (isPromptDecision(show.state, show.presentation)) {
    const safe = show.actions.filter((a) => a.role === 'safe');
    if (safe.length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['actions'], message: 'a decision carries exactly one safe action' });
    } else if (show.defaultActionId !== safe[0]!.id) {
      ctx.addIssue({ code: 'custom', path: ['defaultActionId'], message: 'a decision defaults to its safe action' });
    }
  }
  const expiryAction = show.timing.expiry?.actionId;
  if (expiryAction && !show.actions.some((a) => a.id === expiryAction)) {
    ctx.addIssue({ code: 'custom', path: ['timing', 'expiry', 'actionId'], message: 'expiry names no action' });
  }
  const operatorClass = isPromptKind(show.kind) && PROMPT_KINDS[show.kind].copyClass === 'operator';
  if (!operatorClass && show.copy.operatorNote) {
    ctx.addIssue({ code: 'custom', path: ['copy', 'operatorNote'], message: 'operator text on a breeze-class kind' });
  }
});

/** `prompt_update` (agent → renderer): a present field replaces the old one. */
export const promptUpdateSchema = z
  .object({
    promptId: promptIdSchema,
    rev: promptRevSchema,
    lease: promptLeaseSchema,
    state: z.enum(PROMPT_STATES).optional(),
    copy: promptCopySchema.optional(),
    facts: factsSchema.optional(),
    actions: actionsSchema.optional(),
    defaultActionId: actionIdSchema.optional(),
    timing: promptTimingSchema.optional(),
  })
  .superRefine((update, ctx) => {
    if (update.defaultActionId !== undefined && update.actions === undefined) {
      ctx.addIssue({ code: 'custom', path: ['defaultActionId'], message: 'defaultActionId travels with actions' });
    }
    if (update.actions) checkActions(update.actions, update.defaultActionId, ctx);
  });

/** `prompt_close` (agent → renderer). */
export const promptCloseSchema = z.object({
  promptId: promptIdSchema,
  rev: promptRevSchema,
  lease: promptLeaseSchema,
  reason: z.enum(PROMPT_CLOSE_REASONS),
});

/** `prompt_presented` (renderer → agent): a window was created; `visible` is the renderer's honest answer. */
export const promptPresentedSchema = z.object({
  promptId: promptIdSchema,
  rev: promptRevSchema,
  lease: promptLeaseSchema,
  visible: z.boolean(),
});

/** `prompt_action` (renderer → agent). */
export const promptActionSchema = z.object({
  promptId: promptIdSchema,
  rev: promptRevSchema,
  lease: promptLeaseSchema,
  actionId: actionIdSchema,
  via: z.enum(PROMPT_ACTION_VIAS),
});

/** `prompt_action_result` (agent → renderer, on the `prompt_action` envelope). */
export const promptActionResultSchema = z.object({
  promptId: promptIdSchema,
  actionId: actionIdSchema,
  result: z.enum(PROMPT_ACTION_RESULTS),
  /** The prompt's rev after the action was applied (or the current rev when rejected). */
  rev: promptRevSchema,
});

/** `prompt_closed` (renderer → agent). Hiding is never a domain action. */
export const promptClosedSchema = z.object({
  promptId: promptIdSchema,
  rev: promptRevSchema,
  lease: promptLeaseSchema,
  reason: z.enum(PROMPT_CLOSED_REASONS),
  detail: z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/)
    .optional(),
});

export const PROMPT_LOGO_MAX_BYTES = 262_144;
export const PROMPT_LOGO_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;

function base64DecodedLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

export const promptLogoSchema = z
  .object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    mime: z.enum(PROMPT_LOGO_MIMES),
    bytes: z.number().int().min(1).max(PROMPT_LOGO_MAX_BYTES),
    /** Standard, padded base64 of the image bytes. The logo is bytes, never a URL. */
    data: z
      .string()
      .max(Math.ceil(PROMPT_LOGO_MAX_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .refine((d) => d.length % 4 === 0, { message: 'logo data is not padded base64' }),
  })
  .refine((logo) => logo.data.length % 4 !== 0 || base64DecodedLength(logo.data) === logo.bytes, {
    message: 'logo bytes disagree with the decoded data',
  });

/**
 * `prompt_branding_sync` (agent → renderer): the effective MSP identity
 * (spec §3.6) or `{cleared: true}`; always carries the negotiated `locale`
 * so Assist can localize its chrome (plan P6).
 */
export const promptBrandingSyncSchema = z.discriminatedUnion('cleared', [
  z.strictObject({
    cleared: z.literal(true),
    locale: localeSchema,
  }),
  z.object({
    cleared: z.literal(false),
    scopeId: z.string().regex(/^[0-9a-f]{32}$/),
    partnerName: z.string().min(1).max(120),
    primaryColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional(),
    logo: promptLogoSchema.optional(),
    locale: localeSchema,
  }),
]);

/**
 * The prompt additions to `AuthRequest` (Go `ipc.AuthRequest`). The legacy
 * fields are owned by the IPC layer; this schema checks the additions and
 * keeps the rest.
 */
export const promptAuthRequestSchema = z.looseObject({
  protocolVersion: z.literal(1),
  helperRole: z.string().optional(),
  promptProtocolVersion: z.number().int().min(0).max(16).optional(),
  promptKinds: z.array(promptKindAdSchema).max(16).optional(),
  rendererVersion: z.string().max(32).optional(),
});

/**
 * Heartbeat `helperCapabilities.promptHost`: what the console session's Assist
 * advertised at its live authentication. `kinds` is always present and may be
 * `[]` (a renderer that speaks the protocol but advertises no kind).
 */
export const promptHostTelemetrySchema = z.object({
  protocolVersion: z.number().int().min(0).max(16),
  kinds: z.array(promptKindAdSchema).max(16),
  rendererVersion: z.string().max(32),
});

/**
 * Heartbeat response `promptHost`: the server kill switch (spec §3.1 rule 2).
 * Always sent; `[]` enables nothing, and an absent block also means nothing.
 */
export const promptHostSettingsSchema = z.object({
  enabledKinds: z.array(z.union([promptKindNameSchema, promptKindAdSchema])).max(32),
});

export const promptHostHeartbeatFixtureSchema = z.object({
  telemetry: promptHostTelemetrySchema,
  settings: promptHostSettingsSchema,
});

export const promptSkewRowSchema = z
  .object({
    name: z.string().min(1),
    kind: promptKindNameSchema,
    renderer: z.enum(['assist', 'native']),
    agentSpeaks: z.array(z.string()),
    /** null = a renderer that predates the contract and advertised nothing. */
    rendererAdvertises: z.array(z.string()).nullable(),
    enabled: z.array(z.string()),
    expectedPath: z.enum(['prompt', 'legacy']),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .refine((row) => (row.expectedPath === 'prompt') === (row.expectedVersion !== undefined), {
    message: 'expectedVersion is set exactly when expectedPath is prompt',
  });

export const promptSkewMatrixSchema = z.array(promptSkewRowSchema).min(1);

export type PromptLease = z.infer<typeof promptLeaseSchema>;
export type PromptActionSpec = z.infer<typeof promptActionSpecSchema>;
export type PromptCopy = z.infer<typeof promptCopySchema>;
export type PromptFact = z.infer<typeof promptFactSchema>;
export type PromptTiming = z.infer<typeof promptTimingSchema>;
export type PromptShow = z.infer<typeof promptShowSchema>;
export type PromptUpdate = z.infer<typeof promptUpdateSchema>;
export type PromptClose = z.infer<typeof promptCloseSchema>;
export type PromptPresented = z.infer<typeof promptPresentedSchema>;
export type PromptAction = z.infer<typeof promptActionSchema>;
export type PromptActionResultMessage = z.infer<typeof promptActionResultSchema>;
export type PromptClosed = z.infer<typeof promptClosedSchema>;
export type PromptBrandingSync = z.infer<typeof promptBrandingSyncSchema>;
export type PromptHostTelemetry = z.infer<typeof promptHostTelemetrySchema>;
export type PromptHostSettings = z.infer<typeof promptHostSettingsSchema>;
export type PromptSkewRow = z.infer<typeof promptSkewRowSchema>;

export type PromptUpdateResult =
  | { success: true; data: PromptShow; error?: undefined }
  | { success: false; data?: undefined; error: { issues: Array<{ message: string; path: PropertyKey[] }> } };

/**
 * Applies a `prompt_update` to the current `prompt_show` state the way every
 * renderer must: a present field replaces the old one, `actions` and
 * `defaultActionId` travel together, the update's `rev` and `lease` become
 * current, and the merged state must still be a valid `prompt_show` (so an
 * update can never leave a pending decision without its single safe default,
 * or add operator text to a breeze-class prompt).
 */
export function applyPromptUpdate(show: PromptShow, update: PromptUpdate): PromptUpdateResult {
  if (update.promptId !== show.promptId) {
    return { success: false, error: { issues: [{ message: 'update is for another prompt', path: ['promptId'] }] } };
  }
  if (update.rev <= show.rev) {
    return { success: false, error: { issues: [{ message: 'rev is not newer', path: ['rev'] }] } };
  }
  const merged: PromptShow = {
    ...show,
    rev: update.rev,
    lease: update.lease,
    ...(update.state !== undefined ? { state: update.state } : {}),
    ...(update.copy !== undefined ? { copy: update.copy } : {}),
    ...(update.facts !== undefined ? { facts: update.facts } : {}),
    ...(update.timing !== undefined ? { timing: update.timing } : {}),
  };
  if (update.actions !== undefined) {
    merged.actions = update.actions;
    if (update.defaultActionId !== undefined) merged.defaultActionId = update.defaultActionId;
    else delete merged.defaultActionId;
  }
  const result = promptShowSchema.safeParse(merged);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    error: { issues: result.error.issues.map((i) => ({ message: i.message, path: i.path as PropertyKey[] })) },
  };
}
