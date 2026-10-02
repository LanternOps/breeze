import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('./auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import { useAiModelPickerStore } from './aiModelPickerStore';
import type { AiModelChoicesDto } from '@breeze/shared';

const CHOICES: AiModelChoicesDto = {
  surface: 'chat', allowUserChoice: true, defaultOfferingId: 'def',
  current: { offeringId: 'def', options: { effort: 'medium' } },
  choices: [
    { offeringId: 'def', displayName: 'Sonnet 5.5', contextTokens: 1_000_000, funding: 'platform',
      priceHint: { inputCentsPerM: 300, outputCentsPerM: 1500, fast: null }, thinkingMode: 'adaptive',
      options: { effort: ['low', 'medium', 'high'], speed: ['standard'], budgetThinking: false }, defaults: { effort: 'medium' }, disabled: null },
    { offeringId: 'haiku', displayName: 'Haiku 4.5', contextTokens: 200_000, funding: 'platform',
      priceHint: { inputCentsPerM: 100, outputCentsPerM: 500, fast: null }, thinkingMode: 'budget',
      options: { effort: [], speed: ['standard'], budgetThinking: true }, defaults: {}, disabled: null },
  ],
};

beforeEach(() => {
  useAiModelPickerStore.getState().reset();
  fetchWithAuth.mockReset();
  fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ data: CHOICES }) });
});

describe('aiModelPickerStore', () => {
  it('loads the session\'s choices', async () => {
    await useAiModelPickerStore.getState().load({ sessionId: 's1' });
    expect(fetchWithAuth).toHaveBeenCalledWith('/ai/models/choices/chat?sessionId=s1');
    expect(useAiModelPickerStore.getState().choices).toEqual(CHOICES);
  });
  it('nothing pending until the user changes something', async () => {
    await useAiModelPickerStore.getState().load({ sessionId: 's1' });
    expect(useAiModelPickerStore.getState().pendingChoice()).toBeUndefined();
    useAiModelPickerStore.getState().select('def');
    expect(useAiModelPickerStore.getState().pendingChoice()).toBeUndefined();   // same model, same options
  });
  it('picking another model sends its defaults; changing an option sends the change', async () => {
    await useAiModelPickerStore.getState().load({ sessionId: 's1' });
    useAiModelPickerStore.getState().select('haiku');
    useAiModelPickerStore.getState().setOption('budgetThinking', 'on');
    expect(useAiModelPickerStore.getState().pendingChoice()).toEqual({ offeringId: 'haiku', options: { budgetThinking: 'on' } });
  });
  it('a disabled (permission-gated) entry cannot be selected', async () => {
    fetchWithAuth.mockResolvedValueOnce({ ok: true, json: async () => ({ data: {
      ...CHOICES, choices: [...CHOICES.choices, { ...CHOICES.choices[0]!, offeringId: 'opus', disabled: { reason: 'permission_required', permission: 'ai_models:premium', roleNames: [] } }],
    } }) });
    await useAiModelPickerStore.getState().load({ sessionId: 's1' });
    useAiModelPickerStore.getState().select('opus');
    expect(useAiModelPickerStore.getState().selection).toBeNull();
  });
  it('commitSelection makes the sent choice current and clears it', async () => {
    await useAiModelPickerStore.getState().load({ sessionId: 's1' });
    useAiModelPickerStore.getState().select('haiku');
    useAiModelPickerStore.getState().commitSelection();
    expect(useAiModelPickerStore.getState().choices!.current).toEqual({ offeringId: 'haiku', options: {} });
    expect(useAiModelPickerStore.getState().pendingChoice()).toBeUndefined();
  });
  it('a failed load leaves no choices (the menu stays hidden), never stale ones', async () => {
    await useAiModelPickerStore.getState().load({ sessionId: 's1' });
    fetchWithAuth.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    await useAiModelPickerStore.getState().load({ sessionId: 's2' });
    expect(useAiModelPickerStore.getState().choices).toBeNull();
  });
});
