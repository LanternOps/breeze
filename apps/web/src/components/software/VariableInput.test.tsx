import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VariableInput, { type DeviceCustomField } from './VariableInput';
import type { TenantVariableEntry } from '@/lib/tenantVariableTokens';

function Harness({
  initial = '',
  customFields = [],
  tenantVariables = [],
}: {
  initial?: string;
  customFields?: DeviceCustomField[];
  tenantVariables?: TenantVariableEntry[];
}) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <VariableInput
        value={value}
        onChange={setValue}
        customFields={customFields}
        tenantVariables={tenantVariables}
        placeholder="url"
      />
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

// #3409 PR2 — tenant variables are dynamic like custom fields, offered under
// their own group and inserted as `{{var.<key>}}`.
describe('VariableInput tenant variables', () => {
  const tenantVariables: TenantVariableEntry[] = [
    { key: 'vendor_token', description: 'Vendor portal token', isSecret: false },
    { key: 'api_password', description: 'Vendor API password', isSecret: true },
  ];

  it('renders tenant variables under their own group and inserts at the caret', () => {
    render(<Harness initial="AB" tenantVariables={tenantVariables} />);
    const input = screen.getByPlaceholderText('url') as HTMLInputElement;
    input.setSelectionRange(1, 1);

    openMenu();
    expect(screen.getByText('Variables')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /Vendor portal token/i }));

    expect(screen.getByTestId('value')).toHaveTextContent('A{{var.vendor_token}}B');
  });

  // PR 2 rejects a secret token at save time (there is no delivery channel for
  // it until PR 4), so the picker must not be able to write one.
  it('offers a secret variable as disabled with a reason instead of insertable', () => {
    render(<Harness tenantVariables={tenantVariables} />);
    openMenu();
    const secret = screen.getByRole('menuitem', { name: /Vendor API password/i });
    expect(secret).toBeDisabled();
    expect(secret).toHaveTextContent(/environment variable/i);

    fireEvent.click(secret);
    expect(screen.getByTestId('value')).toHaveTextContent('');
  });

  it('does not flag a known variable token', () => {
    render(<Harness initial="https://dl/{{var.vendor_token}}/app.msi" tenantVariables={tenantVariables} />);
    expect(screen.queryByText(/Unknown variable/i)).not.toBeInTheDocument();
  });

  it('flags a variable key that does not exist once the list has loaded', () => {
    render(<Harness initial="https://dl/{{var.ghost}}/app.msi" tenantVariables={tenantVariables} />);
    expect(screen.getByText(/Unknown variable/i)).toBeInTheDocument();
  });

  it('accepts a variable token on structure alone before the list loads', () => {
    render(<Harness initial="https://dl/{{var.ghost}}/app.msi" />);
    expect(screen.queryByText(/Unknown variable/i)).not.toBeInTheDocument();
  });
});
