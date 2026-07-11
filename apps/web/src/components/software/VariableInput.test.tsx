import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VariableInput, { type DeviceCustomField } from './VariableInput';

function Harness({
  initial = '',
  customFields = [],
}: {
  initial?: string;
  customFields?: DeviceCustomField[];
}) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <VariableInput value={value} onChange={setValue} customFields={customFields} placeholder="url" />
      <span data-testid="value">{value}</span>
    </div>
  );
}

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /insert variable/i }));

describe('VariableInput', () => {
  it('opens the menu and inserts a built-in token at the caret', () => {
    render(<Harness initial="AB" />);
    const input = screen.getByPlaceholderText('url') as HTMLInputElement;
    input.setSelectionRange(1, 1); // caret between A and B

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Organization name/i }));

    expect(screen.getByTestId('value')).toHaveTextContent('A{{org.name}}B');
  });

  it('replaces the current selection when inserting', () => {
    render(<Harness initial="keep-XXX-keep" />);
    const input = screen.getByPlaceholderText('url') as HTMLInputElement;
    input.setSelectionRange(5, 8); // select "XXX"

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Device hostname/i }));

    expect(screen.getByTestId('value')).toHaveTextContent('keep-{{device.hostname}}-keep');
  });

  it('offers device custom fields under their own group', () => {
    render(<Harness customFields={[{ fieldKey: 'license_key', name: 'License Key' }]} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /License Key/i }));
    expect(screen.getByTestId('value')).toHaveTextContent('{{device.customField.license_key}}');
  });

  it('warns and marks the field invalid on an unknown token', () => {
    render(<Harness initial="https://dl/{{bogus}}/app.msi" />);
    expect(screen.getByText(/Unknown variable/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('url')).toHaveAttribute('aria-invalid', 'true');
  });

  it('does not warn on a clean built-in token', () => {
    render(<Harness initial="https://dl/{{org.id}}/app.msi" />);
    expect(screen.queryByText(/Unknown variable/i)).not.toBeInTheDocument();
  });
});
