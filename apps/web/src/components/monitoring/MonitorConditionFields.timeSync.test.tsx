// apps/web/src/components/monitoring/MonitorConditionFields.timeSync.test.tsx
import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { expect, it, vi } from 'vitest';
import { TIME_SYNC_FINDING_CODES } from '@breeze/shared';
import MonitorConditionFields from './MonitorConditionFields';
import { defaultConditionFor } from './monitorKindFields';
function Harness({ submit }: { submit: (value: unknown) => void }) {
  const form = useForm({
    defaultValues: { condition: defaultConditionFor('time_sync') },
  });
  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(submit)}>
        <MonitorConditionFields kind="time_sync" name="condition" />
        <button type="submit" data-testid="save">
          Save
        </button>
        <button
          type="button"
          data-testid="reset"
          onClick={() =>
            form.reset({
              condition: {
                ...defaultConditionFor('time_sync'),
                findings: ['timezone_mismatch'],
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
            form.setError('condition.findings', {
              message: 'Select at least one finding',
            })
          }
        >
          Error
        </button>
      </form>
    </FormProvider>
  );
}
it('selects, clears, resets, localizes and exposes validation errors', async () => {
  const submit = vi.fn();
  render(<Harness submit={submit} />);
  const checkbox = (key: string) =>
    screen.getByTestId(`condition-field-findings-${key}`) as HTMLInputElement;
  for (const code of TIME_SYNC_FINDING_CODES)
    expect(checkbox(code)).toBeTruthy();
  expect(checkbox('sync_stale').checked).toBe(true);
  expect(checkbox('sync_disabled').checked).toBe(true);
  expect(screen.getByText('No recent successful synchronization')).toBeTruthy();
  fireEvent.click(checkbox('timezone_mismatch'));
  fireEvent.click(screen.getByTestId('save'));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0]![0].condition).toEqual({
    findings: ['sync_disabled', 'sync_stale', 'timezone_mismatch'],
    consecutiveSnapshots: 2,
  });
  for (const key of ['sync_disabled', 'sync_stale', 'timezone_mismatch'])
    fireEvent.click(checkbox(key));
  fireEvent.click(screen.getByTestId('save'));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  expect(submit.mock.calls[1]![0].condition.findings).toEqual([]);
  fireEvent.click(screen.getByTestId('reset'));
  expect(checkbox('timezone_mismatch').checked).toBe(true);
  expect(checkbox('sync_stale').checked).toBe(false);
  fireEvent.click(screen.getByTestId('error'));
  expect(screen.getByText('Select at least one finding')).toBeTruthy();
});
