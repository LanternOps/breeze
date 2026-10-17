/**
 * The chat composer's model menu (AI model registry W05, #7603), mobile side.
 *
 * Mirrors the web's `apps/web/src/stores/aiModelPickerStore.ts`,
 * `components/ai/AiModelPicker.tsx`, `AiTurnModelBadge.tsx`,
 * `AiContinuationPrompt.tsx` and `modelPickerFormat.ts`. A choice is PENDING
 * until the next message carries it (on the session create for a new chat);
 * the server resolves it strictly and the turn claim stamps it, so a switch
 * only ever lands between turns.
 *
 * Types are declared locally rather than imported from `@breeze/shared`
 * (`types/aiModelChoices.ts`, `validators/aiModelOptions.ts`): the mobile app
 * deliberately has no dependency on the shared package (Metro bundles from
 * source, and the validators would drag zod into the bundle). The API route
 * tests own the wire contract on the server side.
 *
 * Pure: no React Native, no storage, no network — so Vitest can cover it.
 */

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export type ModelSpeed = 'standard' | 'fast';
export type BudgetThinking = 'off' | 'on';

/** Per-call knobs the composer can set. Absent = inherit the assignment / offering default. */
export interface OfferingOptions {
  effort?: EffortLevel;
  thinkingDisplay?: string;
  speed?: ModelSpeed;
  budgetThinking?: BudgetThinking;
}

/** What rides on `POST /ai/sessions/:id/messages` as `model` (aiModelChoiceSchema). */
export interface ModelChoice {
  offeringId: string;
  options?: Partial<OfferingOptions>;
}

export interface AiModelChoiceDto {
  offeringId: string;
  displayName: string;
  contextTokens: number | null;
  funding: 'platform' | 'partner_key';
  priceHint: {
    inputCentsPerM: number;
    outputCentsPerM: number;
    fast: { inputCentsPerM: number; outputCentsPerM: number } | null;
  };
  thinkingMode: 'adaptive' | 'budget' | 'none' | 'unknown';
  options: { effort: EffortLevel[]; speed: ModelSpeed[]; budgetThinking: boolean };
  defaults: OfferingOptions;
  disabled: null | { reason: 'permission_required'; permission: string; roleNames: string[] };
}

export interface AiModelChoicesDto {
  surface: 'chat' | 'ai_agents';
  allowUserChoice: boolean;
  defaultOfferingId: string | null;
  choices: AiModelChoiceDto[];
  current: { offeringId: string | null; options: OfferingOptions | null } | null;
}

export type AiContinuationReason = 'cross_connection' | 'connection_changed' | 'transcript_too_large' | 'fit_unverifiable';

/** Body of the 409 the messages route returns when a switch cannot resume. */
export interface AiContinuationRequired {
  error: string;
  code: 'continuation_required';
  reason: AiContinuationReason;
  recoverable: true;
  target: { offeringId: string | null; displayName: string };
}

/** What actually ran a turn (`turn_model` SSE event; `lastTurnModel` on session GET). */
export interface AiTurnModel {
  requestedModel: string;
  requestedDisplayName: string;
  servedModel: string;
  servedDisplayName: string;
  fallbackUsed: boolean;
  appliedOptions: OfferingOptions;
  fastDowngraded: boolean;
}

// ---------------------------------------------------------------------------
// Formatting (modelPickerFormat.ts)
// ---------------------------------------------------------------------------

/** Compact context size: 1_000_000 → '1M', 200_000 → '200K'. */
export function formatContextTokens(tokens: number | null): string | null {
  if (tokens === null || !Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/** Cents per million tokens → '$3', '$0.75', '$12.50'. */
export function formatCentsPerM(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** en `aiModelPicker.effortLevels`. */
export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Keep only option values this client understands; drop the rest. */
function parseOptions(raw: unknown): OfferingOptions {
  if (!isObj(raw)) return {};
  const out: OfferingOptions = {};
  if ((EFFORT_LEVELS as readonly unknown[]).includes(raw.effort)) out.effort = raw.effort as EffortLevel;
  if (raw.speed === 'standard' || raw.speed === 'fast') out.speed = raw.speed;
  if (raw.budgetThinking === 'off' || raw.budgetThinking === 'on') out.budgetThinking = raw.budgetThinking;
  if (isStr(raw.thinkingDisplay)) out.thinkingDisplay = raw.thinkingDisplay;
  return out;
}

function parseChoice(raw: unknown): AiModelChoiceDto | null {
  if (!isObj(raw) || !isStr(raw.offeringId) || !isStr(raw.displayName)) return null;
  const price = raw.priceHint;
  const opts = raw.options;
  if (!isObj(price) || !isNum(price.inputCentsPerM) || !isNum(price.outputCentsPerM) || !isObj(opts)) return null;
  const fast = isObj(price.fast) && isNum(price.fast.inputCentsPerM) && isNum(price.fast.outputCentsPerM)
    ? { inputCentsPerM: price.fast.inputCentsPerM, outputCentsPerM: price.fast.outputCentsPerM }
    : null;
  const disabled = isObj(raw.disabled)
    ? {
        reason: 'permission_required' as const,
        permission: isStr(raw.disabled.permission) ? raw.disabled.permission : '',
        roleNames: Array.isArray(raw.disabled.roleNames) ? raw.disabled.roleNames.filter(isStr) : [],
      }
    : null;
  return {
    offeringId: raw.offeringId,
    displayName: raw.displayName,
    contextTokens: isNum(raw.contextTokens) ? raw.contextTokens : null,
    funding: raw.funding === 'partner_key' ? 'partner_key' : 'platform',
    priceHint: { inputCentsPerM: price.inputCentsPerM, outputCentsPerM: price.outputCentsPerM, fast },
    thinkingMode: (['adaptive', 'budget', 'none'] as const).find((m) => m === raw.thinkingMode) ?? 'unknown',
    options: {
      effort: Array.isArray(opts.effort)
        ? (opts.effort.filter((e) => (EFFORT_LEVELS as readonly unknown[]).includes(e)) as EffortLevel[])
        : [],
      speed: Array.isArray(opts.speed) ? (opts.speed.filter((s) => s === 'standard' || s === 'fast') as ModelSpeed[]) : ['standard'],
      budgetThinking: opts.budgetThinking === true,
    },
    defaults: parseOptions(raw.defaults),
    disabled,
  };
}

export type ChoicesResult =
  | { ok: true; choices: AiModelChoicesDto }
  | { ok: false; status: number; code: string | null };

/**
 * `GET /ai/models/choices/chat` → the menu, or why there is none. Any failure
 * (503 `registry_unavailable`, 400 no org context, 404) leaves the composer on
 * the server default — the picker simply does not render.
 */
export function parseChoicesResponse(status: number, body: unknown): ChoicesResult {
  if (status < 200 || status >= 300) {
    const code = isObj(body) && isStr(body.code) ? body.code : null;
    return { ok: false, status, code };
  }
  const data = isObj(body) ? body.data : null;
  if (!isObj(data) || !Array.isArray(data.choices)) return { ok: false, status, code: 'malformed' };
  const current = isObj(data.current)
    ? {
        offeringId: isStr(data.current.offeringId) ? data.current.offeringId : null,
        options: isObj(data.current.options) ? parseOptions(data.current.options) : null,
      }
    : null;
  return {
    ok: true,
    choices: {
      surface: data.surface === 'ai_agents' ? 'ai_agents' : 'chat',
      allowUserChoice: data.allowUserChoice === true,
      defaultOfferingId: isStr(data.defaultOfferingId) ? data.defaultOfferingId : null,
      choices: data.choices.map(parseChoice).filter((c): c is AiModelChoiceDto => c !== null),
      current,
    },
  };
}

export function parseTurnModel(raw: unknown): AiTurnModel | null {
  if (!isObj(raw)) return null;
  const { requestedModel, requestedDisplayName, servedModel, servedDisplayName, fallbackUsed, fastDowngraded } = raw;
  if (!isStr(requestedModel) || !isStr(requestedDisplayName) || !isStr(servedModel) || !isStr(servedDisplayName)) return null;
  return {
    requestedModel,
    requestedDisplayName,
    servedModel,
    servedDisplayName,
    fallbackUsed: fallbackUsed === true,
    appliedOptions: parseOptions(raw.appliedOptions),
    fastDowngraded: fastDowngraded === true,
  };
}

// ---------------------------------------------------------------------------
// Picker rows + option gating (AiModelPicker.tsx)
// ---------------------------------------------------------------------------

/** Chat: `allowUserChoice: false` hides the whole menu and the option controls. */
export function showPicker(choices: AiModelChoicesDto | null): choices is AiModelChoicesDto {
  return !!choices && choices.allowUserChoice && choices.choices.length > 0;
}

export interface PickerRow {
  offeringId: string;
  title: string;
  isDefault: boolean;
  selected: boolean;
  suggested: boolean;
  disabled: boolean;
  /** "200K context · $3 in / $15 out per M tokens" */
  detail: string;
  gatedNote: string | null;
}

export function pickerRows(choices: AiModelChoicesDto, effectiveOfferingId: string | null, suggestedIds: readonly string[]): PickerRow[] {
  return choices.choices.map((c) => {
    const context = formatContextTokens(c.contextTokens);
    const price = `${formatCentsPerM(c.priceHint.inputCentsPerM)} in / ${formatCentsPerM(c.priceHint.outputCentsPerM)} out per M tokens`;
    const gated = c.disabled !== null;
    return {
      offeringId: c.offeringId,
      title: c.displayName,
      isDefault: c.offeringId === choices.defaultOfferingId,
      selected: c.offeringId === effectiveOfferingId,
      suggested: suggestedIds.includes(c.offeringId),
      disabled: gated,
      detail: [context ? `${context} context` : null, price].filter(Boolean).join(' · '),
      gatedNote: gated
        ? c.disabled!.roleNames.length > 0
          ? `Requires ${c.disabled!.roleNames.join(', ')}`
          : 'Requires the premium AI models permission'
        : null,
    };
  });
}

export interface OptionControls {
  /** Selectable effort levels in canonical order; null hides the control. */
  effort: EffortLevel[] | null;
  fast: { label: string } | null;
  thinking: boolean;
}

/** The options the chosen offering supports — gated exactly like the web composer. */
export function optionControls(chosen: AiModelChoiceDto | null): OptionControls {
  if (!chosen) return { effort: null, fast: null, thinking: false };
  const effort = chosen.options.effort.length > 0 ? EFFORT_LEVELS.filter((e) => chosen.options.effort.includes(e)) : null;
  const fastPrice = chosen.priceHint.fast;
  const fast = chosen.options.speed.includes('fast') && fastPrice
    ? { label: `Fast (${formatCentsPerM(fastPrice.inputCentsPerM)} in / ${formatCentsPerM(fastPrice.outputCentsPerM)} out per M)` }
    : null;
  return { effort, fast, thinking: chosen.options.budgetThinking };
}

// ---------------------------------------------------------------------------
// Selection state (aiModelPickerStore)
// ---------------------------------------------------------------------------

export interface PickerState {
  choices: AiModelChoicesDto | null;
  /** A load is in flight: the menu on screen is not the one a send is checked against. */
  loading: boolean;
  selection: ModelChoice | null;
}

const findChoice = (choices: AiModelChoicesDto | null, offeringId: string | null) =>
  offeringId ? choices?.choices.find((c) => c.offeringId === offeringId) ?? null : null;

export function chosenOffering(state: PickerState): AiModelChoiceDto | null {
  return findChoice(state.choices, effectiveChoice(state).offeringId);
}

/** selection → the session's stamped choice → the menu default. */
export function effectiveChoice(state: PickerState): { offeringId: string | null; options: Partial<OfferingOptions> } {
  const { selection, choices } = state;
  if (selection) return { offeringId: selection.offeringId, options: selection.options ?? {} };
  const current = choices?.current;
  const offeringId = current?.offeringId ?? choices?.defaultOfferingId ?? null;
  return { offeringId, options: current?.options ?? findChoice(choices, offeringId)?.defaults ?? {} };
}

/** A pick takes the offering defaults — or the stamped options when re-picking the current one. */
export function selectOffering(state: PickerState, offeringId: string): ModelChoice | null {
  const choice = findChoice(state.choices, offeringId);
  if (!choice || choice.disabled) return null;
  const current = state.choices?.current;
  const options = current?.offeringId === offeringId && current.options ? current.options : choice.defaults;
  return { offeringId, options: { ...options } };
}

export function withOption<K extends keyof OfferingOptions>(
  state: PickerState,
  key: K,
  value: OfferingOptions[K] | undefined,
): ModelChoice | null {
  const { offeringId, options } = effectiveChoice(state);
  if (!offeringId) return null;
  const next: Partial<OfferingOptions> = { ...options, [key]: value };
  if (value === undefined) delete next[key];
  return { offeringId, options: next };
}

function sameOptions(a: Partial<OfferingOptions> | null | undefined, b: Partial<OfferingOptions> | null | undefined): boolean {
  const norm = (o: Partial<OfferingOptions> | null | undefined) =>
    JSON.stringify(Object.entries(o ?? {}).filter(([, v]) => v !== undefined).sort(([x], [y]) => x.localeCompare(y)));
  return norm(a) === norm(b);
}

/**
 * The choice the next message (or session create) must carry, if any. A
 * reload in flight does not hide it: the pill keeps showing the pick, so a
 * send must carry it (the server resolves it strictly and refuses a pick the
 * new menu no longer offers).
 */
export function pendingChoice(state: PickerState): ModelChoice | undefined {
  const { selection, choices } = state;
  if (!selection || !choices?.allowUserChoice) return undefined;
  const current = choices.current;
  if (current?.offeringId === selection.offeringId && sameOptions(current.options, selection.options)) return undefined;
  return selection;
}

/** The turn (or create) that carried the pick succeeded: it is the session's choice now. */
export function commitSelection(state: PickerState): PickerState {
  const { selection, choices } = state;
  if (!selection || !choices) return state;
  return {
    ...state,
    choices: { ...choices, current: { offeringId: selection.offeringId, options: selection.options ?? {} } },
    selection: null,
  };
}

/** Keep a pick across a menu reload only while it is still selectable. */
export function survivingSelection(next: AiModelChoicesDto | null, selection: ModelChoice | null): ModelChoice | null {
  if (!selection || !next) return null;
  const still = next.choices.find((c) => c.offeringId === selection.offeringId);
  return still && !still.disabled ? selection : null;
}

export interface ChoicesLoadFailure {
  status: number;
  code: string | null;
}

/** 400 (no org context), 403, 404: the server says there is no menu here. */
function isDefinitiveNoMenu(failure: ChoicesLoadFailure): boolean {
  return failure.status === 400 || failure.status === 403 || failure.status === 404;
}

/**
 * A failed menu load worth a Sentry report: the user sees no picker either
 * way, but a 5xx, a 2xx the app cannot read, or a throw that was not the
 * network means the contract or the registry broke — not "no menu here"
 * (4xx) or a blip (offline `status 0`, 503 `registry_unavailable`).
 */
export function shouldReportChoicesFailure(failure: ChoicesLoadFailure): boolean {
  if (failure.code === 'malformed' || failure.code === 'threw') return true;
  return failure.status >= 500 && failure.code !== 'registry_unavailable';
}

/**
 * The picker after a failed menu load. Only a definitive "no menu" clears
 * the menu and the pick; a transport failure, a 5xx or 503
 * `registry_unavailable` is transient and keeps both (`sameKey`: the menu on
 * screen is this chat's — another chat's menu is never shown for this one).
 */
export function stateAfterFailedLoad(prev: PickerState, failure: ChoicesLoadFailure, sameKey: boolean): PickerState {
  if (isDefinitiveNoMenu(failure)) return { choices: null, loading: false, selection: null };
  return { choices: sameKey ? prev.choices : null, loading: false, selection: prev.selection };
}

/** How long a new chat's first send waits for a menu it does not have yet. */
export const FIRST_SEND_MENU_CAP_MS = 1_500;

/**
 * A new chat's first send without a menu. A 400 (a partner-scope token has
 * no org menu before the session exists) is answered by the session's menu,
 * so it is worth waiting for; anything else (registry down, bad link, still
 * loading) is only raced against FIRST_SEND_MENU_CAP_MS.
 */
export function firstSendMenuWait(lastFailure: ChoicesLoadFailure | null): 'await' | 'race' {
  return lastFailure?.status === 400 ? 'await' : 'race';
}

/** `work`'s value if it settles within `ms`, else `{ done: false }`. */
export function withinCap<T>(work: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  return Promise.race([work.then((value) => ({ done: true as const, value })), cap]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Persisted on-device preference
// ---------------------------------------------------------------------------

/** Read back what `JSON.stringify(ModelChoice)` wrote; anything else is no pref. */
export function parseModelPref(stored: string | null): ModelChoice | null {
  if (!stored) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!isObj(raw) || !isStr(raw.offeringId)) return null;
  const options = parseOptions(raw.options);
  delete options.thinkingDisplay;
  return { offeringId: raw.offeringId, options };
}

/**
 * The stored pick as a selection for a NEW chat, or null (= the default,
 * silently) when its offering is gone, gated, or choice is locked. Options
 * the offering no longer supports are dropped rather than sent: the server
 * resolves a choice strictly and would refuse the create.
 */
export function resolvePersistedPref(choices: AiModelChoicesDto | null, pref: ModelChoice | null): ModelChoice | null {
  if (!pref || !showPicker(choices)) return null;
  const choice = findChoice(choices, pref.offeringId);
  if (!choice || choice.disabled) return null;
  const controls = optionControls(choice);
  const src = pref.options ?? {};
  const options: Partial<OfferingOptions> = {};
  if (src.effort && controls.effort?.includes(src.effort)) options.effort = src.effort;
  if (src.speed === 'fast' ? controls.fast : src.speed === 'standard') options.speed = src.speed;
  if (src.budgetThinking && controls.thinking) options.budgetThinking = src.budgetThinking;
  return { offeringId: choice.offeringId, options };
}

// ---------------------------------------------------------------------------
// Send failures (aiStore.sendMessage)
// ---------------------------------------------------------------------------

/** Codes after which the chosen / stored model is no longer usable: refresh the menu. */
export const RECOVERABLE_MODEL_CODES: ReadonlySet<string> = new Set([
  'model_unavailable', 'not_permitted', 'permission_required', 'plan_required',
  'residency_unavailable', 'unpriced', 'connection_unavailable', 'tools_unsupported',
]);

const CONTINUATION_REASONS: readonly AiContinuationReason[] = ['cross_connection', 'connection_changed', 'transcript_too_large', 'fit_unverifiable'];

export type SendFailure =
  | { kind: 'continuation'; required: AiContinuationRequired }
  | { kind: 'model_unavailable'; code: string; message: string }
  | { kind: 'other' };

export function classifySendFailure(status: number, body: unknown): SendFailure {
  if (status !== 409 || !isObj(body) || !isStr(body.code)) return { kind: 'other' };
  if (body.code === 'continuation_required') {
    const target = body.target;
    if (
      !(CONTINUATION_REASONS as readonly unknown[]).includes(body.reason)
      || !isObj(target)
      || !isStr(target.displayName)
      || !(target.offeringId === null || isStr(target.offeringId))
    ) {
      return { kind: 'other' };
    }
    return {
      kind: 'continuation',
      required: {
        error: isStr(body.error) ? body.error : '',
        code: 'continuation_required',
        reason: body.reason as AiContinuationReason,
        recoverable: true,
        target: { offeringId: target.offeringId as string | null, displayName: target.displayName },
      },
    };
  }
  if (RECOVERABLE_MODEL_CODES.has(body.code)) {
    return { kind: 'model_unavailable', code: body.code, message: isStr(body.error) ? body.error : 'That model is unavailable. Choose another.' };
  }
  return { kind: 'other' };
}

export const SESSION_CREATE_FAILED = 'Could not start a session.';

/**
 * A refused `POST /ai/sessions`. A model code means the pick (usually the
 * stored pref) is not usable: show the server's reason and drop the pref, or
 * every new chat would re-apply it and fail the same way. Anything else keeps
 * the static message (the raw error is internal, issue #3141).
 */
export function sessionCreateFailure(status: number, body: unknown): { message: string; modelRefused: boolean } {
  if (status >= 400 && status < 500 && isObj(body) && isStr(body.code) && RECOVERABLE_MODEL_CODES.has(body.code)) {
    return { message: isStr(body.error) ? body.error : 'That model is unavailable. Choose another.', modelRefused: true };
  }
  return { message: SESSION_CREATE_FAILED, modelRefused: false };
}

// ---------------------------------------------------------------------------
// Continuation prompt (AiContinuationPrompt.tsx; en `aiContinuation`)
// ---------------------------------------------------------------------------

export function continuationCopy(required: AiContinuationRequired): {
  reason: string;
  kept: string;
  continueLabel: string;
  keepLabel: string;
} {
  const model = required.target.displayName;
  const reasons: Record<AiContinuationReason, string> = {
    cross_connection: `${model} runs on a different AI connection, so this chat can't switch to it.`,
    connection_changed: "The AI connection changed since the last reply, so this chat can't switch models.",
    transcript_too_large: `This conversation is too long for ${model}.`,
    fit_unverifiable: `Breeze couldn't confirm this conversation fits ${model}.`,
  };
  return {
    reason: reasons[required.reason],
    kept: 'Your message is kept. Continue in a new chat that starts from a summary of this one, or keep the current model.',
    continueLabel: `Continue with ${model} in a new chat`,
    keepLabel: 'Keep the current model',
  };
}

export const CONTINUATION_FAILED = "Couldn't start the new chat. Try again.";
export const CONTINUATION_OPEN_FAILED =
  "The new chat was created but couldn't be opened. Try again, or find it in your chat history; your message was not sent.";

/** The model the new chat starts on: the pending pick, else the refused target. */
export function continuationTarget(required: AiContinuationRequired, selection: ModelChoice | null): ModelChoice | null {
  if (selection) return selection;
  return required.target.offeringId ? { offeringId: required.target.offeringId } : null;
}

/**
 * What the prompt's Continue does. Once `/continue` has created the new chat
 * (`createdSessionId`), a retry only opens it: another POST would create a
 * second linked chat and bill a second summary.
 */
export function continuationStep(
  parked: { required: AiContinuationRequired; createdSessionId?: string },
  selection: ModelChoice | null,
): { kind: 'open'; sessionId: string } | { kind: 'continue'; target: ModelChoice } | null {
  if (parked.createdSessionId) return { kind: 'open', sessionId: parked.createdSessionId };
  const target = continuationTarget(parked.required, selection);
  return target ? { kind: 'continue', target } : null;
}

// ---------------------------------------------------------------------------
// Turn provenance (AiTurnModelBadge.tsx; en `aiTurnModel`)
// ---------------------------------------------------------------------------

export function describeTurnModel(turnModel: AiTurnModel): string {
  const parts = [`Answered by ${turnModel.servedDisplayName}`];
  const { effort, speed, budgetThinking } = turnModel.appliedOptions;
  if (effort) parts.push(EFFORT_LABELS[effort]);
  if (speed === 'fast') parts.push('Fast');
  if (budgetThinking === 'on') parts.push('Thinking');
  if (turnModel.fallbackUsed) parts.push(`${turnModel.requestedDisplayName} declined; another model answered`);
  if (turnModel.fastDowngraded) parts.push('Fast was unavailable; ran at standard speed');
  return parts.join(' · ');
}
