import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { expect, it, vi } from 'vitest';
import { MONITOR_KINDS } from '@breeze/shared';
import MonitorConditionFields from './MonitorConditionFields';
import { defaultConditionFor, MONITOR_KIND_FIELDS } from './monitorKindFields';

function Harness({ submit }: { submit: (value: unknown) => void }) {
  const form = useForm({ defaultValues: { condition: defaultConditionFor('container_image_currency') } });
  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(submit)}>
        <MonitorConditionFields kind="container_image_currency" name="condition" />
        <button type="submit" data-testid="save">Save</button>
      </form>
    </FormProvider>
  );
}

it('every monitor kind has editor fields and a default condition', () => {
  for (const kind of MONITOR_KINDS) {
    expect(MONITOR_KIND_FIELDS[kind], kind).toBeDefined();
    expect(defaultConditionFor(kind), kind).toBeDefined();
  }
});

it('edits the minimum days behind, defaulting to 7', async () => {
  const submit = vi.fn();
  render(<Harness submit={submit} />);
  expect(screen.getByText('Minimum days behind')).toBeTruthy();
  const input = screen.getByTestId('condition-field-minDaysBehind') as HTMLInputElement;
  expect(input.value).toBe('7');
  fireEvent.change(input, { target: { value: '14' } });
  fireEvent.click(screen.getByTestId('save'));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0]![0].condition).toEqual({ minDaysBehind: 14 });
});
