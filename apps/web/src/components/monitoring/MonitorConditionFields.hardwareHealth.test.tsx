import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { expect, it, vi } from 'vitest';
import MonitorConditionFields from './MonitorConditionFields';
import { defaultConditionFor } from './monitorKindFields';

function Harness({ submit }: { submit: (value: unknown) => void }) {
  const form = useForm({ defaultValues: { condition: defaultConditionFor('hardware_health') } });
  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(submit)}>
        <MonitorConditionFields kind="hardware_health" name="condition" />
        <button type="submit" data-testid="save">
          Save
        </button>
        <button
          type="button"
          data-testid="reset"
          onClick={() =>
            form.reset({
              condition: {
                ...defaultConditionFor('hardware_health'),
                componentTypes: ['collector'],
              },
            })
          }
        >
          Reset
        </button>
        <button
          type="button"
          data-testid="error"
          onClick={() =>
            form.setError('condition.componentTypes', {
              message: 'Select at least one component',
            })
          }
        >
          Error
        </button>
      </form>
    </FormProvider>
  );
}

it('submits a string array, clears it, resets from saved values and shows validation', async () => {
  const submit = vi.fn();
  render(<Harness submit={submit} />);
  const checkbox = (key: string) => screen.getByTestId(`condition-field-componentTypes-${key}`) as HTMLInputElement;
  expect(checkbox('virtual_disk').checked).toBe(true);
  expect(checkbox('physical_disk').checked).toBe(true);
  expect(screen.queryByTestId('condition-field-componentTypes-bmc')).toBeNull();
  expect(screen.getByText('Components')).toBeTruthy();
  expect(screen.getByText('Monitoring tools')).toBeTruthy();
  fireEvent.click(checkbox('controller'));
  fireEvent.click(screen.getByTestId('save'));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0]![0].condition).toEqual({
    componentTypes: ['controller', 'virtual_disk', 'physical_disk'],
    minHealth: 'critical',
    includePredictiveFailure: true,
    consecutiveSnapshots: 2,
  });
  for (const key of ['controller', 'virtual_disk', 'physical_disk']) fireEvent.click(checkbox(key));
  fireEvent.click(screen.getByTestId('save'));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  expect(submit.mock.calls[1]![0].condition.componentTypes).toEqual([]);
  fireEvent.click(screen.getByTestId('reset'));
  expect(checkbox('collector').checked).toBe(true);
  expect(checkbox('virtual_disk').checked).toBe(false);
  fireEvent.click(screen.getByTestId('error'));
  expect(screen.getByText('Select at least one component')).toBeTruthy();
});
