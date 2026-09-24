import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useForm, FormProvider } from 'react-hook-form';
import { expect, it, vi } from 'vitest';
import { monitorConditionSchemas, monitorResponsesSchema } from '@breeze/shared';
import { CompositeConditionFields, RestartResponseFields } from './MonitorAuthoringFields';

const child = { kind: 'cpu', condition: { operator: 'gt', value: 80 } };

function Harness({ submit }: { submit: (v: unknown) => void }) {
  const methods = useForm({
    defaultValues: {
      condition: { match: 'all', children: [child, child] },
      responses: [{ type: 'execute_command', kind: 'restart_service', command: '', maxAttempts: 0, cooldownSeconds: 86400 }],
    },
  });
  return (
    <FormProvider {...methods}>
      <form onSubmit={methods.handleSubmit(submit)}>
        <CompositeConditionFields name="condition" />
        <RestartResponseFields />
        <button>Save</button>
      </form>
    </FormProvider>
  );
}

it('edits child fields and restart bounds without losing zero attempts', async () => {
  const submit = vi.fn();
  render(<Harness submit={submit} />);
  expect(screen.getByTestId('restart-0-maxAttempts')).toHaveValue(0);
  const first = screen.getByTestId('composite-child-0');
  fireEvent.change(within(first).getByTestId('condition-field-value'), { target: { value: '91' } });
  fireEvent.change(screen.getByTestId('composite-match'), { target: { value: 'any' } });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(submit).toHaveBeenCalled());
  const value = submit.mock.calls[0]![0];
  expect(value.condition.children[0].condition.value).toBe(91);
  expect(value.condition.match).toBe('any');
  expect(monitorConditionSchemas.composite.safeParse(value.condition).success).toBe(true);
  expect(value.responses[0]).toMatchObject({ maxAttempts: 0, cooldownSeconds: 86400 });
  expect(monitorResponsesSchema.safeParse(value.responses).success).toBe(true);
});

it('enforces child count and excludes kinds that cannot supply child evidence', () => {
  render(<Harness submit={vi.fn()} />);
  expect(screen.getByTestId('composite-remove-0')).toBeDisabled();
  for (let n = 2; n < 10; n++) fireEvent.click(screen.getByTestId('composite-add'));
  expect(screen.getByTestId('composite-add')).toBeDisabled();
  const options = within(screen.getByTestId('composite-kind-0'))
    .getAllByRole('option')
    .map((o) => o.getAttribute('value'));
  for (const kind of ['composite', 'service', 'process', 'process_resource', 'script', 'network_check']) {
    expect(options).not.toContain(kind);
  }
});
