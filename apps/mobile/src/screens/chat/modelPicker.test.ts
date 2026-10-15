import { describe, expect, it } from 'vitest';

import {
  classifySendFailure,
  commitSelection,
  continuationCopy,
  continuationTarget,
  describeTurnModel,
  effectiveChoice,
  formatCentsPerM,
  formatContextTokens,
  optionControls,
  parseChoicesResponse,
  parseModelPref,
  parseTurnModel,
  pendingChoice,
  pickerRows,
  resolvePersistedPref,
  selectOffering,
  showPicker,
  survivingSelection,
  withOption,
  type AiModelChoiceDto,
  type AiModelChoicesDto,
  type PickerState,
} from './modelPicker';

const SONNET = '11111111-1111-4111-8111-111111111111';
const OPUS = '22222222-2222-4222-8222-222222222222';
const HAIKU = '33333333-3333-4333-8333-333333333333';
const LOCKED = '44444444-4444-4444-8444-444444444444';

function choice(over: Partial<AiModelChoiceDto> & { offeringId: string; displayName: string }): AiModelChoiceDto {
  return {
    contextTokens: 200_000,
    funding: 'platform',
    priceHint: { inputCentsPerM: 300, outputCentsPerM: 1500, fast: null },
    thinkingMode: 'adaptive',
    options: { effort: [], speed: ['standard'], budgetThinking: false },
    defaults: {},
    disabled: null,
    ...over,
  };
}

const sonnet = choice({ offeringId: SONNET, displayName: 'Sonnet', defaults: { effort: 'medium' }, options: { effort: ['max', 'low', 'medium', 'high'], speed: ['standard'], budgetThinking: false } });
const opus = choice({
  offeringId: OPUS,
  displayName: 'Opus',
  contextTokens: 1_000_000,
  priceHint: { inputCentsPerM: 500, outputCentsPerM: 2500, fast: { inputCentsPerM: 3000, outputCentsPerM: 15000 } },
  options: { effort: ['low', 'high'], speed: ['standard', 'fast'], budgetThinking: false },
  defaults: { effort: 'high', speed: 'standard' },
});
const haiku = choice({
  offeringId: HAIKU,
  displayName: 'Haiku',
  contextTokens: null,
  priceHint: { inputCentsPerM: 75, outputCentsPerM: 1250, fast: null },
  thinkingMode: 'budget',
  options: { effort: [], speed: ['standard'], budgetThinking: true },
  defaults: { budgetThinking: 'off' },
});
const locked = choice({
  offeringId: LOCKED,
  displayName: 'Premium',
  disabled: { reason: 'permission_required', permission: 'ai:premium', roleNames: ['Admin', 'Lead'] },
});

function menu(over: Partial<AiModelChoicesDto> = {}): AiModelChoicesDto {
  return {
    surface: 'chat',
    allowUserChoice: true,
    defaultOfferingId: SONNET,
    choices: [sonnet, opus, haiku, locked],
    current: null,
    ...over,
  };
}

const state = (over: Partial<PickerState> = {}): PickerState => ({ choices: menu(), loading: false, selection: null, ...over });

describe('formatting (mirrors web modelPickerFormat.ts)', () => {
  it('formats context sizes', () => {
    expect(formatContextTokens(1_000_000)).toBe('1M');
    expect(formatContextTokens(1_500_000)).toBe('1.5M');
    expect(formatContextTokens(200_000)).toBe('200K');
    expect(formatContextTokens(null)).toBeNull();
    expect(formatContextTokens(0)).toBeNull();
  });

  it('formats cents per million', () => {
    expect(formatCentsPerM(300)).toBe('$3');
    expect(formatCentsPerM(75)).toBe('$0.75');
    expect(formatCentsPerM(1250)).toBe('$12.50');
  });
});

describe('parseChoicesResponse', () => {
  it('accepts a well-formed menu', () => {
    expect(parseChoicesResponse(200, { data: menu() })).toEqual({ ok: true, choices: menu() });
  });

  it('treats registry_unavailable (503) as unavailable, not a crash', () => {
    expect(parseChoicesResponse(503, { error: 'x', code: 'registry_unavailable' })).toEqual({ ok: false, status: 503, code: 'registry_unavailable' });
  });

  it('treats a non-ok status without a code as unavailable', () => {
    expect(parseChoicesResponse(400, { error: 'Organization context required' })).toEqual({ ok: false, status: 400, code: null });
  });

  it('rejects a malformed body', () => {
    expect(parseChoicesResponse(200, { data: { choices: 'nope' } })).toEqual({ ok: false, status: 200, code: 'malformed' });
    expect(parseChoicesResponse(200, null)).toEqual({ ok: false, status: 200, code: 'malformed' });
  });

  it('drops choice rows that are malformed but keeps the rest', () => {
    const body = { data: { ...menu(), choices: [sonnet, { offeringId: 5 }] } };
    const parsed = parseChoicesResponse(200, body);
    expect(parsed.ok && parsed.choices.choices.map((c) => c.offeringId)).toEqual([SONNET]);
  });
});

describe('showPicker', () => {
  it('hides the menu when choice is locked, empty, or unloaded', () => {
    expect(showPicker(null)).toBe(false);
    expect(showPicker(menu({ allowUserChoice: false }))).toBe(false);
    expect(showPicker(menu({ choices: [] }))).toBe(false);
    expect(showPicker(menu())).toBe(true);
  });
});

describe('pickerRows', () => {
  it('labels default, selection, context and price like the web', () => {
    const rows = pickerRows(menu(), OPUS, []);
    expect(rows[0]).toMatchObject({ offeringId: SONNET, title: 'Sonnet', isDefault: true, selected: false, disabled: false, detail: '200K context · $3 in / $15 out per M tokens', gatedNote: null });
    expect(rows[1]).toMatchObject({ offeringId: OPUS, selected: true, isDefault: false, detail: '1M context · $5 in / $25 out per M tokens' });
    expect(rows[2].detail).toBe('$0.75 in / $12.50 out per M tokens');
  });

  it('lists a permission-gated offering disabled with its roles', () => {
    const row = pickerRows(menu(), SONNET, []).find((r) => r.offeringId === LOCKED)!;
    expect(row.disabled).toBe(true);
    expect(row.gatedNote).toBe('Requires Admin, Lead');
    const noRoles = pickerRows(menu({ choices: [{ ...locked, disabled: { ...locked.disabled!, roleNames: [] } }] }), SONNET, []);
    expect(noRoles[0].gatedNote).toBe('Requires the premium AI models permission');
  });

  it('marks refusal alternatives as suggested', () => {
    expect(pickerRows(menu(), SONNET, [HAIKU]).find((r) => r.offeringId === HAIKU)!.suggested).toBe(true);
    expect(pickerRows(menu(), SONNET, [HAIKU]).find((r) => r.offeringId === OPUS)!.suggested).toBe(false);
  });
});

describe('optionControls (same gates as AiModelPicker.tsx)', () => {
  it('offers effort levels in canonical order, only those supported', () => {
    expect(optionControls(sonnet).effort).toEqual(['low', 'medium', 'high', 'max']);
    expect(optionControls(haiku).effort).toBeNull();
  });

  it('offers fast only when speed includes fast AND a fast price exists', () => {
    expect(optionControls(opus).fast).toEqual({ label: 'Fast ($30 in / $150 out per M)' });
    expect(optionControls({ ...opus, priceHint: { ...opus.priceHint, fast: null } }).fast).toBeNull();
    expect(optionControls(sonnet).fast).toBeNull();
  });

  it('offers thinking only for budget-thinking offerings', () => {
    expect(optionControls(haiku).thinking).toBe(true);
    expect(optionControls(opus).thinking).toBe(false);
  });

  it('offers nothing without a chosen offering', () => {
    expect(optionControls(null)).toEqual({ effort: null, fast: null, thinking: false });
  });
});

describe('selection state (mirrors aiModelPickerStore)', () => {
  it('effective falls back from selection → current → default', () => {
    expect(effectiveChoice(state())).toEqual({ offeringId: SONNET, options: { effort: 'medium' } });
    const withCurrent = state({ choices: menu({ current: { offeringId: OPUS, options: { effort: 'low' } } }) });
    expect(effectiveChoice(withCurrent)).toEqual({ offeringId: OPUS, options: { effort: 'low' } });
    expect(effectiveChoice({ ...withCurrent, selection: { offeringId: HAIKU, options: {} } })).toEqual({ offeringId: HAIKU, options: {} });
    expect(effectiveChoice(state({ choices: null }))).toEqual({ offeringId: null, options: {} });
  });

  it('select takes the offering defaults, or the stamped options when re-picking current', () => {
    expect(selectOffering(state(), OPUS)).toEqual({ offeringId: OPUS, options: { effort: 'high', speed: 'standard' } });
    const withCurrent = state({ choices: menu({ current: { offeringId: OPUS, options: { effort: 'low' } } }) });
    expect(selectOffering(withCurrent, OPUS)).toEqual({ offeringId: OPUS, options: { effort: 'low' } });
  });

  it('refuses to select a gated or unknown offering', () => {
    expect(selectOffering(state(), LOCKED)).toBeNull();
    expect(selectOffering(state(), 'nope')).toBeNull();
  });

  it('setOption edits the effective choice and deletes a cleared key', () => {
    expect(withOption(state(), 'effort', 'high')).toEqual({ offeringId: SONNET, options: { effort: 'high' } });
    expect(withOption(state(), 'effort', undefined)).toEqual({ offeringId: SONNET, options: {} });
    expect(withOption(state({ choices: null }), 'effort', 'high')).toBeNull();
  });

  it('pending is nothing while loading, without a selection, or when choice is locked', () => {
    const sel = { offeringId: OPUS, options: { effort: 'high' as const } };
    expect(pendingChoice(state({ selection: sel }))).toEqual(sel);
    expect(pendingChoice(state({ selection: sel, loading: true }))).toBeUndefined();
    expect(pendingChoice(state())).toBeUndefined();
    expect(pendingChoice(state({ selection: sel, choices: menu({ allowUserChoice: false }) }))).toBeUndefined();
  });

  it('pending is nothing when the selection equals the stamped current (key order/undefined ignored)', () => {
    const choices = menu({ current: { offeringId: OPUS, options: { speed: 'standard', effort: 'high' } } });
    expect(pendingChoice(state({ choices, selection: { offeringId: OPUS, options: { effort: 'high', speed: 'standard' } } }))).toBeUndefined();
    expect(pendingChoice(state({ choices, selection: { offeringId: OPUS, options: { effort: 'low', speed: 'standard' } } }))).toBeDefined();
  });

  it('commit stamps the selection as current and clears it', () => {
    const next = commitSelection(state({ selection: { offeringId: HAIKU, options: { budgetThinking: 'on' } } }));
    expect(next.selection).toBeNull();
    expect(next.choices?.current).toEqual({ offeringId: HAIKU, options: { budgetThinking: 'on' } });
  });

  it('a selection survives a reload only while still selectable', () => {
    const sel = { offeringId: OPUS, options: {} };
    expect(survivingSelection(menu(), sel)).toEqual(sel);
    expect(survivingSelection(menu({ choices: [sonnet] }), sel)).toBeNull();
    expect(survivingSelection(menu({ choices: [{ ...opus, disabled: locked.disabled }] }), sel)).toBeNull();
    expect(survivingSelection(null, sel)).toBeNull();
  });
});

describe('persisted preference', () => {
  it('parses only a well-formed stored pref', () => {
    expect(parseModelPref(JSON.stringify({ offeringId: OPUS, options: { effort: 'high' } }))).toEqual({ offeringId: OPUS, options: { effort: 'high' } });
    expect(parseModelPref(null)).toBeNull();
    expect(parseModelPref('{oops')).toBeNull();
    expect(parseModelPref(JSON.stringify({ offeringId: 3 }))).toBeNull();
    expect(parseModelPref(JSON.stringify({ offeringId: OPUS, options: { effort: 'turbo', speed: 'fast', junk: 1 } }))).toEqual({ offeringId: OPUS, options: { speed: 'fast' } });
  });

  it('applies a pref whose offering is still offered', () => {
    expect(resolvePersistedPref(menu(), { offeringId: OPUS, options: { effort: 'low', speed: 'fast' } })).toEqual({ offeringId: OPUS, options: { effort: 'low', speed: 'fast' } });
  });

  it('falls back to the default silently when the offering is gone, gated, or choice is locked', () => {
    expect(resolvePersistedPref(menu({ choices: [sonnet] }), { offeringId: OPUS, options: {} })).toBeNull();
    expect(resolvePersistedPref(menu(), { offeringId: LOCKED, options: {} })).toBeNull();
    expect(resolvePersistedPref(menu({ allowUserChoice: false }), { offeringId: OPUS, options: {} })).toBeNull();
    expect(resolvePersistedPref(null, { offeringId: OPUS, options: {} })).toBeNull();
    expect(resolvePersistedPref(menu(), null)).toBeNull();
  });

  it('drops options the offering no longer supports', () => {
    // Opus: effort low/high only; Sonnet: no fast; Haiku: no effort but thinking.
    expect(resolvePersistedPref(menu(), { offeringId: OPUS, options: { effort: 'max', speed: 'fast', budgetThinking: 'on' } })).toEqual({ offeringId: OPUS, options: { speed: 'fast' } });
    expect(resolvePersistedPref(menu(), { offeringId: SONNET, options: { speed: 'fast', effort: 'high' } })).toEqual({ offeringId: SONNET, options: { effort: 'high' } });
    expect(resolvePersistedPref(menu(), { offeringId: HAIKU, options: { budgetThinking: 'on', effort: 'low' } })).toEqual({ offeringId: HAIKU, options: { budgetThinking: 'on' } });
  });

  it('a persisted pick equal to the default is not pending once stamped', () => {
    const sel = resolvePersistedPref(menu(), { offeringId: SONNET, options: { effort: 'medium' } });
    expect(sel).toEqual({ offeringId: SONNET, options: { effort: 'medium' } });
  });
});

describe('classifySendFailure (mirrors aiStore.sendMessage 409 handling)', () => {
  const required = {
    error: 'x',
    code: 'continuation_required',
    reason: 'cross_connection',
    recoverable: true,
    target: { offeringId: OPUS, displayName: 'Opus' },
  };

  it('parks a continuation_required 409', () => {
    expect(classifySendFailure(409, required)).toEqual({ kind: 'continuation', required });
  });

  it('a malformed continuation body is treated as a generic failure', () => {
    expect(classifySendFailure(409, { code: 'continuation_required', reason: 'nope' }).kind).toBe('other');
  });

  it('refreshes the menu and drops the bubble on a recoverable model code', () => {
    for (const code of ['model_unavailable', 'not_permitted', 'permission_required', 'plan_required', 'residency_unavailable', 'unpriced', 'connection_unavailable', 'tools_unsupported']) {
      expect(classifySendFailure(409, { error: 'Pick another', code })).toEqual({ kind: 'model_unavailable', code, message: 'Pick another' });
    }
  });

  it('leaves other failures to the existing handling', () => {
    expect(classifySendFailure(409, { error: 'busy', code: 'turn_in_progress' }).kind).toBe('other');
    expect(classifySendFailure(500, { error: 'boom', code: 'model_unavailable' }).kind).toBe('other');
    expect(classifySendFailure(409, null).kind).toBe('other');
  });
});

describe('continuation copy (mirrors AiContinuationPrompt.tsx / en ai.json)', () => {
  const base = { error: 'x', code: 'continuation_required' as const, recoverable: true as const, target: { offeringId: OPUS, displayName: 'Opus' } };

  it('renders the reason, kept-message note and both actions', () => {
    expect(continuationCopy({ ...base, reason: 'cross_connection' })).toEqual({
      reason: "Opus runs on a different AI connection, so this chat can't switch to it.",
      kept: 'Your message is kept. Continue in a new chat that starts from a summary of this one, or keep the current model.',
      continueLabel: 'Continue with Opus in a new chat',
      keepLabel: 'Keep the current model',
    });
    expect(continuationCopy({ ...base, reason: 'connection_changed' }).reason).toBe("The AI connection changed since the last reply, so this chat can't switch models.");
    expect(continuationCopy({ ...base, reason: 'transcript_too_large' }).reason).toBe('This conversation is too long for Opus.');
    expect(continuationCopy({ ...base, reason: 'fit_unverifiable' }).reason).toBe("Breeze couldn't confirm this conversation fits Opus.");
  });

  it('continues with the pending pick, else the target offering', () => {
    const sel = { offeringId: OPUS, options: { effort: 'low' as const } };
    expect(continuationTarget({ ...base, reason: 'cross_connection' }, sel)).toEqual(sel);
    expect(continuationTarget({ ...base, reason: 'cross_connection' }, null)).toEqual({ offeringId: OPUS });
    expect(continuationTarget({ ...base, reason: 'cross_connection', target: { offeringId: null, displayName: 'X' } }, null)).toBeNull();
  });
});

describe('turn model (mirrors AiTurnModelBadge.tsx)', () => {
  const tm = {
    requestedModel: 'm1',
    requestedDisplayName: 'Opus',
    servedModel: 'm1',
    servedDisplayName: 'Opus',
    fallbackUsed: false,
    appliedOptions: {},
    fastDowngraded: false,
  };

  it('parses the SSE / history payload and rejects junk', () => {
    expect(parseTurnModel(tm)).toEqual(tm);
    expect(parseTurnModel({ ...tm, servedDisplayName: 3 })).toBeNull();
    expect(parseTurnModel(null)).toBeNull();
  });

  it('describes what ran', () => {
    expect(describeTurnModel(tm)).toBe('Answered by Opus');
    expect(describeTurnModel({ ...tm, appliedOptions: { effort: 'xhigh', speed: 'fast', budgetThinking: 'on' } })).toBe('Answered by Opus · Extra high · Fast · Thinking');
    expect(describeTurnModel({ ...tm, servedDisplayName: 'Sonnet', fallbackUsed: true })).toBe('Answered by Sonnet · Opus declined; another model answered');
    expect(describeTurnModel({ ...tm, fastDowngraded: true })).toBe('Answered by Opus · Fast was unavailable; ran at standard speed');
  });
});
