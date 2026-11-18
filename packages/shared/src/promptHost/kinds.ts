/**
 * Prompt host contract (#10190): the closed kind registry and the contract
 * constants every implementation (Go agent, Rust/React Assist, API) shares.
 *
 * Spec: docs/superpowers/specs/helper/2026-10-26-on-device-dialogs-design.md
 * §3.1 "Kind registry" and "Copy class and scopes". The Go class table
 * (agent/internal/ipc/prompt_kinds.go) and the Assist tracker must agree with
 * this file; the golden fixtures in src/fixtures/prompt-host pin the wire.
 */

/** Envelope/common-field version a renderer advertises as `promptProtocolVersion`. */
export const PROMPT_PROTOCOL_VERSION = 1;

/** `breeze`: Breeze-owned copy only. `operator`: may carry MSP copy verbatim. */
export const PROMPT_COPY_CLASSES = ['breeze', 'operator'] as const;
export type PromptCopyClass = (typeof PROMPT_COPY_CLASSES)[number];

/** IPC scopes. Each is granted only for kinds the session advertised. */
export const PROMPT_SCOPE = 'prompt';
export const PROMPT_OPERATOR_SCOPE = 'prompt_operator';
export const PROMPT_SCOPES = [PROMPT_SCOPE, PROMPT_OPERATOR_SCOPE] as const;
export type PromptScope = (typeof PROMPT_SCOPES)[number];

export const PROMPT_STATES = ['pending', 'waiting', 'approved', 'denied', 'expired', 'cancelled', 'failed'] as const;
export type PromptState = (typeof PROMPT_STATES)[number];
export const PROMPT_TERMINAL_STATES = ['approved', 'denied', 'expired', 'cancelled', 'failed'] as const satisfies readonly PromptState[];

export const PROMPT_PRESENTATIONS = ['modal', 'card', 'indicator', 'list_only'] as const;
export type PromptPresentation = (typeof PROMPT_PRESENTATIONS)[number];

export const PROMPT_ACTION_ROLES = ['safe', 'proceed', 'neutral'] as const;
export type PromptActionRole = (typeof PROMPT_ACTION_ROLES)[number];

export const PROMPT_FOCUS_MODES = ['steal', 'no_activate'] as const;
export type PromptFocusMode = (typeof PROMPT_FOCUS_MODES)[number];

export const PROMPT_DIRECTIONS = ['ltr', 'rtl'] as const;
export type PromptDirection = (typeof PROMPT_DIRECTIONS)[number];

/** Reasons the agent closes a prompt (`prompt_close.reason`). */
export const PROMPT_CLOSE_REASONS = ['resolved', 'superseded', 'withdrawn', 'expired', 'fenced'] as const;
export type PromptCloseReason = (typeof PROMPT_CLOSE_REASONS)[number];

/** Reasons a renderer reports a window gone (`prompt_closed.reason`). Hiding is never a domain action. */
export const PROMPT_CLOSED_REASONS = ['hidden', 'render_failed', 'replaced'] as const;
export type PromptClosedReason = (typeof PROMPT_CLOSED_REASONS)[number];

export const PROMPT_ACTION_RESULTS = ['accepted', 'rejected_stale', 'rejected_invalid'] as const;
export type PromptActionResult = (typeof PROMPT_ACTION_RESULTS)[number];

export const PROMPT_ACTION_VIAS = ['click', 'keyboard', 'list'] as const;
export type PromptActionVia = (typeof PROMPT_ACTION_VIAS)[number];

export const PROMPT_MESSAGE_TYPES = {
  // agent -> renderer
  show: 'prompt_show',
  update: 'prompt_update',
  close: 'prompt_close',
  actionResult: 'prompt_action_result',
  brandingSync: 'prompt_branding_sync',
  // renderer -> agent
  presented: 'prompt_presented',
  action: 'prompt_action',
  closed: 'prompt_closed',
} as const;
export type PromptMessageType = (typeof PROMPT_MESSAGE_TYPES)[keyof typeof PROMPT_MESSAGE_TYPES];

/** The eight product locales (spec §3.1 "Who renders copy"). */
export const PROMPT_LOCALES = ['en', 'de-DE', 'es-419', 'fr-FR', 'fr-CA', 'it-IT', 'pt-BR', 'tr-TR'] as const;
export type PromptLocale = (typeof PROMPT_LOCALES)[number];

/** Contract timings and caps (plan "Global Constraints"; fixed, not policy). */
export const PROMPT_LIMITS = {
  maxActionsPerState: 3,
  presentWithinMs: 10_000,
  terminalLingerMs: 8_000,
  promptTombstoneMs: 24 * 60 * 60 * 1000,
  messageTombstoneMs: 168 * 60 * 60 * 1000,
  assistDisconnectGraceMs: 10_000,
  watcherRespawnCheckMs: 30_000,
  listEntryTtlMs: 7 * 24 * 60 * 60 * 1000,
  listEntriesPerOwner: 50,
  visibleCardsPerSession: 3,
  newCardsPerWindow: 10,
  newCardsWindowMs: 10 * 60 * 1000,
  focusIntervalMs: 5 * 60 * 1000,
  announceAtSeconds: [60, 30, 10],
} as const;

export interface PromptKindDefinition {
  copyClass: PromptCopyClass;
  scope: PromptScope;
  /** The wave that first ships (advertises) the kind. Nothing is advertised in W02. */
  wave: 'W04' | 'W05' | 'W06' | 'W07';
  /** The kind's usual presentation (spec kind registry). */
  presentation: PromptPresentation;
}

/**
 * The closed kind registry (spec §3.1). Kinds not listed here are never
 * granted a scope and never sent; renderers answer one with
 * `prompt_closed{render_failed}`.
 */
export const PROMPT_KINDS = {
  'notice.info': { copyClass: 'breeze', scope: PROMPT_SCOPE, wave: 'W04', presentation: 'card' },
  'restart.prompt': { copyClass: 'operator', scope: PROMPT_OPERATOR_SCOPE, wave: 'W05', presentation: 'card' },
  'restart.final': { copyClass: 'operator', scope: PROMPT_OPERATOR_SCOPE, wave: 'W05', presentation: 'card' },
  'remote.consent': { copyClass: 'breeze', scope: PROMPT_SCOPE, wave: 'W06', presentation: 'modal' },
  'remote.session': { copyClass: 'breeze', scope: PROMPT_SCOPE, wave: 'W06', presentation: 'indicator' },
  'elevation.request': { copyClass: 'breeze', scope: PROMPT_SCOPE, wave: 'W07', presentation: 'card' },
} as const satisfies Record<string, PromptKindDefinition>;

export type PromptKind = keyof typeof PROMPT_KINDS;
export const PROMPT_KIND_NAMES = Object.keys(PROMPT_KINDS) as PromptKind[];

export function isPromptKind(value: string): value is PromptKind {
  return Object.prototype.hasOwnProperty.call(PROMPT_KINDS, value);
}

/**
 * A prompt is a decision while it waits on the person at the keyboard
 * (`pending`) and is not a session indicator. A decision carries exactly one
 * `safe` action and `defaultActionId` names it; Esc and the close box map to
 * that action. Everywhere else Esc / close means "hide".
 */
export function isPromptDecision(state: PromptState, presentation: PromptPresentation): boolean {
  return state === 'pending' && presentation !== 'indicator';
}

/** `"<kind>@<n>"` as advertised in `AuthRequest.promptKinds`. */
export const PROMPT_KIND_AD_PATTERN = /^[a-z]+(\.[a-z_]+)+@[1-9]\d{0,2}$/;
/** A bare kind name (`"notice.info"`). */
export const PROMPT_KIND_NAME_PATTERN = /^[a-z]+(\.[a-z_]+)+$/;

export interface PromptKindAd {
  name: string;
  version: number;
}

/** Parses `"<kind>@<n>"`; version must be >= 1. Returns null when malformed. */
export function parsePromptKindAd(value: string): PromptKindAd | null {
  if (!PROMPT_KIND_AD_PATTERN.test(value)) return null;
  const at = value.lastIndexOf('@');
  const version = Number(value.slice(at + 1));
  if (!Number.isInteger(version) || version < 1) return null;
  return { name: value.slice(0, at), version };
}

/**
 * Reference implementation of per-kind negotiation (spec §3.1 rule 1 + rule 2,
 * plan "Compatibility order" 2). Returns the version the agent should speak
 * for `kind` on this renderer, or null when the prompt must take the legacy
 * path. All three switches must be on for one version:
 *  - the agent build speaks `kind@v`;
 *  - the renderer advertised `kind@v` at its live authentication (null = a
 *    renderer that predates the contract and advertised nothing);
 *  - the server enables the bare `kind` (all versions) or `kind@v`.
 * The highest such version wins. The Go host's selection must agree with this
 * function on every row of fixtures/prompt-host/skew-matrix.json.
 */
export function negotiatePromptKindVersion(
  kind: string,
  agentSpeaks: readonly string[],
  rendererAdvertises: readonly string[] | null,
  enabled: readonly string[],
): number | null {
  if (!isPromptKind(kind) || rendererAdvertises === null) return null;
  const versionsOf = (entries: readonly string[]): Set<number> => {
    const out = new Set<number>();
    for (const entry of entries) {
      const ad = parsePromptKindAd(entry);
      if (ad && ad.name === kind) out.add(ad.version);
    }
    return out;
  };
  const agent = versionsOf(agentSpeaks);
  const renderer = versionsOf(rendererAdvertises);
  const allVersionsEnabled = enabled.includes(kind);
  const enabledVersions = versionsOf(enabled);
  let best: number | null = null;
  for (const v of agent) {
    if (!renderer.has(v)) continue;
    if (!allVersionsEnabled && !enabledVersions.has(v)) continue;
    if (best === null || v > best) best = v;
  }
  return best;
}
