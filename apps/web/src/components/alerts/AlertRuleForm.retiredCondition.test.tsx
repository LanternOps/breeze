import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Regression coverage for #2948. The `custom` condition type was offered by
// this editor but never had a handler registered in the API's condition
// registry, so `conditionRegistry.evaluate()` answered "Unknown condition type"
// and — a root-level conditions array being an implicit AND — the whole rule
// could never fire. The type is gone from the editor, and a stored one is now
// rendered read-only so the type <select> cannot silently coerce it into a live
// CPU rule on the next save.

import AlertRuleForm from './AlertRuleForm';

const CUSTOM_CONDITION = { type: 'custom', field: 'reg_key', customCondition: '> 100' };
const METRIC_CONDITION = { type: 'metric', metric: 'cpu', operator: 'gt', value: 85 };

function renderForm(conditions: unknown[], onSubmit = vi.fn()) {
  render(
    <AlertRuleForm
      onSubmit={onSubmit}
      defaultValues={{
        name: 'A rule',
        severity: 'high',
        targetType: 'all',
        targetIds: [],
        notificationChannelIds: [],
        cooldownMinutes: 15,
        autoResolve: false,
        conditions: conditions as never,
      }}
    />
  );
  return onSubmit;
}

describe('AlertRuleForm retired `custom` condition (#2948)', () => {
  it('no longer offers `custom` in the condition type selector', () => {
    renderForm([METRIC_CONDITION]);

    const options = screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).not.toContain('custom');
    // The types that DO have handlers are still offered.
    expect(options).toContain('metric');
    expect(options).toContain('status');
  });

  it('renders a stored `custom` condition read-only, with its stored value and a warning', () => {
    renderForm([CUSTOM_CONDITION]);

    const retired = screen.getByTestId('condition-retired-0');
    expect(retired).toBeTruthy();
    expect(retired.textContent).toContain('custom');
    // The tech has to be able to see what they are being asked to delete.
    expect(retired.textContent).toContain('reg_key');
    expect(retired.textContent).toContain('> 100');
    expect(retired.textContent).toMatch(/no longer supported/i);
    // Crucially: no type <select> for this row, which would have coerced the
    // stored `custom` to the first option ("metric") on the next save.
    expect(retired.querySelector('select')).toBeNull();
  });

  it('blocks the save while a retired condition is present, and says why on submit', async () => {
    const onSubmit = renderForm([METRIC_CONDITION, CUSTOM_CONDITION]);

    fireEvent.submit(screen.getByTestId('condition-retired-1').closest('form')!);

    await waitFor(() => {
      expect(onSubmit).not.toHaveBeenCalled();
    });
    // A blocked submit that renders nothing new is indistinguishable from a
    // broken Save button. The refinement's message lives at
    // errors.conditions[1].type, which the top-level errors.conditions.message
    // paragraph never reads.
    const submitError = await screen.findByTestId('condition-error-1');
    expect(submitError.textContent).toMatch(/custom/);
  });

  // The registry resolves a dozen condition types and the API accepts all of
  // them; this form can only render two. The rest must be shown read-only and
  // round-tripped verbatim — NOT branded "no longer supported" and NOT blocking
  // the save, which would tell a tech their working offline rule never fired
  // and refuse to save until they deleted it.
  it.each([
    ['offline', { type: 'offline', durationMinutes: 15 }],
    ['event_log', { type: 'event_log', category: 'system', level: 'error', countThreshold: 3, windowMinutes: 30 }],
    ['cert_expiry', { type: 'cert_expiry', withinDays: 30 }],
  ])('renders a supported-but-uneditable %s condition read-only without blocking the save', async (_name, condition) => {
    const onSubmit = renderForm([condition]);

    const row = screen.getByTestId('condition-readonly-0');
    expect(row.textContent).toContain(condition.type);
    expect(row.textContent).not.toMatch(/no longer supported/i);
    expect(screen.queryByTestId('condition-retired-0')).toBeNull();

    fireEvent.submit(row.closest('form')!);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    // And every field survives: Zod's default strip mode would have deleted
    // category/level/windowMinutes/withinDays, turning a working condition into
    // an unevaluable one on save.
    expect(onSubmit.mock.calls[0][0].conditions[0]).toEqual(condition);
  });

  it('lets the retired condition be removed even as the only condition', async () => {
    renderForm([CUSTOM_CONDITION]);

    const removeButtons = screen.getAllByTitle(/remove condition/i) as HTMLButtonElement[];
    expect(removeButtons).toHaveLength(1);
    // Without the retired-row exemption this is disabled (fields.length === 1),
    // leaving the rule permanently unsaveable AND unfixable.
    expect(removeButtons[0].disabled).toBe(false);

    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      expect(screen.queryByTestId('condition-retired-0')).toBeNull();
    });
  });

  it('still submits a rule whose conditions are all supported', async () => {
    const onSubmit = renderForm([METRIC_CONDITION]);

    fireEvent.submit(screen.getByRole('button', { name: /save|create/i }).closest('form')!);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0][0].conditions).toEqual([
      expect.objectContaining({ type: 'metric', metric: 'cpu', operator: 'gt', value: 85 }),
    ]);
  });
});
