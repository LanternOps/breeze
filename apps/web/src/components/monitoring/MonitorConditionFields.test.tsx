import '@/lib/i18n';
import { fireEvent, render, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { describe, it, expect } from 'vitest';
import MonitorConditionFields from './MonitorConditionFields';
import { defaultConditionFor } from './monitorKindFields';

function Host() {
  const form = useForm({
    defaultValues: { condition: defaultConditionFor('network_check') },
  });
  return (
    <FormProvider {...form}>
      <MonitorConditionFields kind="network_check" name="condition" />
    </FormProvider>
  );
}

describe('MonitorConditionFields network_check target reset (MSA-1)', () => {
  it('clears the ping default target when the check type switches to HTTP check', () => {
    render(<Host />);
    const targetInput = screen.getByTestId('condition-field-target') as HTMLInputElement;
    expect(targetInput.value).toBe('8.8.8.8');

    const checkTypeSelect = screen.getByTestId('condition-field-checkType') as HTMLSelectElement;
    fireEvent.change(checkTypeSelect, { target: { value: 'http_check' } });

    expect(targetInput.value).not.toBe('8.8.8.8');
  });

  it('leaves a user-entered target alone when the check type changes', () => {
    render(<Host />);
    const targetInput = screen.getByTestId('condition-field-target') as HTMLInputElement;
    fireEvent.change(targetInput, { target: { value: 'my-custom-host.example.com' } });

    const checkTypeSelect = screen.getByTestId('condition-field-checkType') as HTMLSelectElement;
    fireEvent.change(checkTypeSelect, { target: { value: 'http_check' } });

    expect(targetInput.value).toBe('my-custom-host.example.com');
  });
});
