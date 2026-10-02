import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import AiModelPicker from './AiModelPicker';
import { useAiModelPickerStore } from '@/stores/aiModelPickerStore';
import type { AiModelChoicesDto } from '@breeze/shared';

const base: AiModelChoicesDto = {
  surface: 'chat', allowUserChoice: true, defaultOfferingId: 'def', current: { offeringId: 'def', options: null },
  choices: [
    { offeringId: 'def', displayName: 'Sonnet 5.5', contextTokens: 1_000_000, funding: 'platform',
      priceHint: { inputCentsPerM: 300, outputCentsPerM: 1500, fast: null }, thinkingMode: 'adaptive',
      options: { effort: ['low', 'medium', 'high'], speed: ['standard'], budgetThinking: false }, defaults: { effort: 'medium' }, disabled: null },
    { offeringId: 'opus', displayName: 'Opus 5.5', contextTokens: 1_000_000, funding: 'platform',
      priceHint: { inputCentsPerM: 500, outputCentsPerM: 2500, fast: { inputCentsPerM: 1000, outputCentsPerM: 5000 } }, thinkingMode: 'adaptive',
      options: { effort: ['low', 'high', 'max'], speed: ['standard', 'fast'], budgetThinking: false }, defaults: {},
      disabled: { reason: 'permission_required', permission: 'ai_models:premium', roleNames: ['Senior Tech'] } },
    { offeringId: 'haiku', displayName: 'Haiku 4.5', contextTokens: 200_000, funding: 'platform',
      priceHint: { inputCentsPerM: 100, outputCentsPerM: 500, fast: null }, thinkingMode: 'budget',
      options: { effort: [], speed: ['standard'], budgetThinking: true }, defaults: {}, disabled: null },
  ],
};

function setChoices(c: AiModelChoicesDto | null) {
  useAiModelPickerStore.setState({ choices: c, selection: null, loading: false });
}

beforeEach(() => useAiModelPickerStore.getState().reset());

describe('AiModelPicker (spec §11)', () => {
  it('lists each offering with name, context size and price hint', () => {
    setChoices(base);
    render(<AiModelPicker />);
    fireEvent.click(screen.getByTestId('ai-model-picker-button'));
    const def = screen.getByTestId('ai-model-option-def');
    expect(def.textContent).toContain('Sonnet 5.5');
    expect(def.textContent).toContain('1M');
    expect(def.textContent).toContain('$3');
    expect(def.textContent).toContain('$15');
  });
  it('a permission-gated offering is disabled with "requires <role>"', () => {
    setChoices(base);
    render(<AiModelPicker />);
    fireEvent.click(screen.getByTestId('ai-model-picker-button'));
    const opus = screen.getByTestId('ai-model-option-opus');
    expect(opus).toHaveAttribute('aria-disabled', 'true');
    expect(opus.textContent).toContain('Senior Tech');
  });
  it('shows only the options the selected model supports: effort for adaptive, thinking for budget', () => {
    setChoices(base);
    render(<AiModelPicker />);
    expect(screen.getByTestId('ai-model-effort')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-model-thinking')).toBeNull();
    fireEvent.click(screen.getByTestId('ai-model-picker-button'));
    fireEvent.click(screen.getByTestId('ai-model-option-haiku'));
    expect(screen.queryByTestId('ai-model-effort')).toBeNull();
    expect(screen.getByTestId('ai-model-thinking')).toBeInTheDocument();
  });
  it('Fast shows its higher rate, and only where Fast is selectable', () => {
    setChoices({ ...base, choices: base.choices.map((c) => (c.offeringId === 'opus' ? { ...c, disabled: null } : c)) });
    render(<AiModelPicker />);
    expect(screen.queryByTestId('ai-model-fast')).toBeNull();
    fireEvent.click(screen.getByTestId('ai-model-picker-button'));
    fireEvent.click(screen.getByTestId('ai-model-option-opus'));
    expect(screen.getByTestId('ai-model-fast').textContent).toContain('$10');
  });
  it('everything is hidden when the surface is locked', () => {
    setChoices({ ...base, allowUserChoice: false, choices: [] });
    const { container } = render(<AiModelPicker />);
    expect(container).toBeEmptyDOMElement();
  });
  it('is disabled while a reply streams (switch only between turns)', () => {
    setChoices(base);
    render(<AiModelPicker disabled />);
    expect(screen.getByTestId('ai-model-picker-button')).toBeDisabled();
  });
});
