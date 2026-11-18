import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InheritChoice, type InheritChoiceOption } from './InheritChoice';

const OPTIONS: InheritChoiceOption<'allowed' | 'sso_only'>[] = [
  { value: 'allowed', label: 'Allowed', testId: 'pw-allowed' },
  { value: 'sso_only', label: 'Off', testId: 'pw-sso-only', disabled: true, hint: 'Turn on SSO first.' },
];

function renderChoice(props: Partial<Parameters<typeof InheritChoice<'allowed' | 'sso_only'>>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <InheritChoice<'allowed' | 'sso_only'>
      id="pw"
      legend="Password"
      options={OPTIONS}
      value={null}
      inheritedValue="allowed"
      inheritedSourceLabel="Partner default"
      allowInherit
      onChange={onChange}
      {...props}
    />,
  );
  return onChange;
}

describe('InheritChoice', () => {
  it('shows the inherited value and source and emits null for inherit', () => {
    const onChange = renderChoice({ value: 'allowed' });
    const inherit = screen.getByTestId('pw-inherit') as HTMLInputElement;
    expect(inherit.checked).toBe(false);
    expect(screen.getByText('Inherit — Allowed (Partner default)')).toBeInTheDocument();
    fireEvent.click(inherit);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('checks the inherit radio while the value is null', () => {
    renderChoice();
    expect((screen.getByTestId('pw-inherit') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('pw-allowed') as HTMLInputElement).checked).toBe(false);
  });

  it('emits the option value and never emits a disabled option', () => {
    const onChange = renderChoice();
    fireEvent.click(screen.getByTestId('pw-allowed'));
    expect(onChange).toHaveBeenCalledWith('allowed');
    const off = screen.getByTestId('pw-sso-only') as HTMLInputElement;
    expect(off.disabled).toBe(true);
    expect(screen.getByText('Turn on SSO first.')).toBeInTheDocument();
  });

  it('without allowInherit, a null value checks the inherited option and labels its source', () => {
    renderChoice({ allowInherit: false, inheritedSourceLabel: 'Breeze default' });
    expect(screen.queryByTestId('pw-inherit')).toBeNull();
    expect((screen.getByTestId('pw-allowed') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('pw-source')).toHaveTextContent('Breeze default');
  });

  it('supports boolean values', () => {
    const onChange = vi.fn();
    render(
      <InheritChoice<boolean>
        id="ms"
        legend="Microsoft"
        options={[
          { value: true, label: 'On', testId: 'ms-on' },
          { value: false, label: 'Off', testId: 'ms-off' },
        ]}
        value={false}
        inheritedValue={true}
        inheritedSourceLabel="Partner default"
        allowInherit
        onChange={onChange}
      />,
    );
    expect((screen.getByTestId('ms-off') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Inherit — On (Partner default)')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ms-on'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('disables every radio when disabled', () => {
    renderChoice({ disabled: true });
    expect((screen.getByTestId('pw-inherit') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('pw-allowed') as HTMLInputElement).disabled).toBe(true);
  });
});
