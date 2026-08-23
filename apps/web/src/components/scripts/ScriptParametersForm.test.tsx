import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ScriptParametersForm, { validateParameters } from './ScriptParametersForm';
import type { ScriptParameter } from './ScriptFormSchema';

// #3409 PR3 — a bound parameter is resolved per target device by the server.
// Deliberately `required: true`: the whole point is that "required" is evaluated
// at dispatch after resolution, so it must NOT make this form demand a value.
const boundVariable: ScriptParameter = {
  name: 'api_key',
  type: 'string',
  required: true,
  source: 'tenantVariable',
  variableKey: 'vendor_token',
};

describe('validateParameters', () => {
  it('returns null when there are no parameters', () => {
    expect(validateParameters([], {})).toBeNull();
  });

  it('returns null when all required parameters are present', () => {
    const params: ScriptParameter[] = [
      { name: 'message', type: 'string', required: true },
      { name: 'count', type: 'number', required: true }
    ];
    const values = { message: 'hello', count: 5 };
    expect(validateParameters(params, values)).toBeNull();
  });

  it('returns null when optional parameters are missing', () => {
    const params: ScriptParameter[] = [
      { name: 'message', type: 'string', required: false }
    ];
    expect(validateParameters(params, {})).toBeNull();
  });

  it('returns error string when a required string param is missing', () => {
    const params: ScriptParameter[] = [
      { name: 'message', type: 'string', required: true }
    ];
    expect(validateParameters(params, {})).toBe('Parameter "message" is required');
  });

  it('returns error string when a required string param is empty', () => {
    const params: ScriptParameter[] = [
      { name: 'message', type: 'string', required: true }
    ];
    expect(validateParameters(params, { message: '' })).toBe('Parameter "message" is required');
  });

  it('returns error string when a required string param is whitespace only', () => {
    const params: ScriptParameter[] = [
      { name: 'message', type: 'string', required: true }
    ];
    expect(validateParameters(params, { message: '   ' })).toBe('Parameter "message" is required');
  });

  it('returns the first missing required param error when multiple are missing', () => {
    const params: ScriptParameter[] = [
      { name: 'first', type: 'string', required: true },
      { name: 'second', type: 'string', required: true }
    ];
    const result = validateParameters(params, {});
    expect(result).toBe('Parameter "first" is required');
  });

  it('returns null when a required number param has value 0', () => {
    const params: ScriptParameter[] = [
      { name: 'count', type: 'number', required: true }
    ];
    // 0 is a valid number value — should not be treated as missing
    expect(validateParameters(params, { count: 0 })).toBeNull();
  });

  it('returns error when required param value is undefined', () => {
    const params: ScriptParameter[] = [
      { name: 'target', type: 'string', required: true }
    ];
    expect(validateParameters(params, { target: undefined })).toBe('Parameter "target" is required');
  });

  it('returns error when a required select param has empty string (placeholder)', () => {
    const params: ScriptParameter[] = [
      { name: 'env', type: 'select', required: true, options: 'a,b,c' }
    ];
    expect(validateParameters(params, { env: '' })).toBe('Parameter "env" is required');
  });

  it('returns null when a required boolean param has value false', () => {
    const params: ScriptParameter[] = [
      { name: 'flag', type: 'boolean', required: true }
    ];
    // false is an explicit choice — should not be treated as missing
    expect(validateParameters(params, { flag: false })).toBeNull();
  });

  it('returns error when a number param has NaN value', () => {
    const params: ScriptParameter[] = [
      { name: 'count', type: 'number', required: true }
    ];
    expect(validateParameters(params, { count: NaN })).toBe('Parameter "count" must be a valid number');
  });

  it('never requires a value for a bound parameter — the server resolves it per device', () => {
    expect(validateParameters([boundVariable], {})).toBeNull();
  });

  it('still enforces the runtime parameters alongside a bound one', () => {
    const params: ScriptParameter[] = [
      boundVariable,
      { name: 'message', type: 'string', required: true },
    ];
    expect(validateParameters(params, {})).toBe('Parameter "message" is required');
    expect(validateParameters(params, { message: 'hi' })).toBeNull();
  });

  it('does not number-check a bound parameter that happens to carry a stray value', () => {
    const params: ScriptParameter[] = [
      { name: 'count', type: 'number', required: false, source: 'builtin', builtinKey: 'org.id' },
    ];
    // A stale/injected value must not fail validation locally — dispatch ignores
    // it and reports it back in `ignoredParameters`.
    expect(validateParameters(params, { count: 'not-a-number' })).toBeNull();
  });
});

describe('ScriptParametersForm rendering', () => {
  it('renders a bound parameter read-only with its source, and no input', () => {
    render(
      <ScriptParametersForm
        parameters={[{ name: 'message', type: 'string' }, boundVariable]}
        values={{}}
        onChange={vi.fn()}
      />
    );

    // The runtime parameter is still an editable field.
    expect(screen.getByPlaceholderText('')).toBeInTheDocument();

    const chip = screen.getByTestId('script-bound-parameter-api_key');
    expect(chip).toHaveTextContent('Supplied automatically from variable vendor_token');
    // No control of any kind inside the bound cell — nothing can enter the
    // outgoing parameters map.
    expect(chip.querySelector('input')).toBeNull();
    expect(chip.querySelector('select')).toBeNull();
    expect(chip.querySelector('textarea')).toBeNull();
  });

  it('names the binding for each source', () => {
    render(
      <ScriptParametersForm
        parameters={[
          { name: 'message', type: 'string' },
          { name: 'tag', type: 'string', source: 'deviceCustomField', fieldKey: 'asset_tag' },
          { name: 'org', type: 'string', source: 'builtin', builtinKey: 'org.name' },
        ]}
        values={{}}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByTestId('script-bound-parameter-tag')).toHaveTextContent(
      'Supplied automatically from device custom field asset_tag'
    );
    expect(screen.getByTestId('script-bound-parameter-org')).toHaveTextContent(
      'Supplied automatically from org.name'
    );
  });

  it('renders a secret parameter as a locked chip with no input (#3409 PR4c-2)', () => {
    const params: ScriptParameter[] = [
      { name: 'api_token', source: 'tenantSecret', variableKey: 'vendor_password' },
    ];
    render(<ScriptParametersForm parameters={params} values={{}} onChange={vi.fn()} />);

    const chip = screen.getByTestId('script-bound-parameter-api_token');
    expect(chip).toHaveTextContent(
      'Supplied securely from secret variable vendor_password as an environment variable'
    );
    expect(chip.querySelector('input')).toBeNull();
    expect(screen.getByTestId('script-parameters-all-supplied')).toBeInTheDocument();
  });

  it('still shows the section when every parameter is bound — the operator must see what gets injected', () => {
    const { container } = render(
      <ScriptParametersForm parameters={[boundVariable]} values={{}} onChange={vi.fn()} />
    );

    expect(screen.getByText('Parameters')).toBeInTheDocument();
    expect(screen.getByTestId('script-bound-parameter-api_key')).toHaveTextContent(
      'Supplied automatically from variable vendor_token'
    );
    // Visible, but nothing to prompt for: no control anywhere in the form, and
    // an explicit note so the empty-looking section is not read as a bug.
    expect(screen.getByTestId('script-parameters-all-supplied')).toBeInTheDocument();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
  });

  it('renders nothing when the script has no parameters at all', () => {
    const { container } = render(
      <ScriptParametersForm parameters={[]} values={{}} onChange={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('does not show the all-supplied note when there is a runtime parameter to fill', () => {
    render(
      <ScriptParametersForm
        parameters={[{ name: 'message', type: 'string' }, boundVariable]}
        values={{}}
        onChange={vi.fn()}
      />
    );
    expect(screen.queryByTestId('script-parameters-all-supplied')).toBeNull();
  });
});
