import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { McpToolListMode, ResolvedMcpToolListMode } from '@breeze/shared';
import '../../lib/i18n';
import McpToolListModeField, { type McpToolListModeFieldValue } from './McpToolListModeField';

function setup(opts: {
  initial: McpToolListModeFieldValue;
  deploymentDefault?: McpToolListMode;
  effective?: ResolvedMcpToolListMode | null;
  variant?: 'key' | 'connection';
  disabled?: boolean;
}) {
  const onChange = vi.fn();
  function Harness() {
    const [value, setValue] = useState<McpToolListModeFieldValue>(opts.initial);
    return (
      <McpToolListModeField
        idPrefix="t"
        variant={opts.variant ?? 'key'}
        value={value}
        effective={value === opts.initial ? opts.effective ?? null : null}
        deploymentDefault={opts.deploymentDefault ?? 'full'}
        disabled={opts.disabled}
        onChange={(v) => { onChange(v); setValue(v); }}
      />
    );
  }
  render(<Harness />);
  return onChange;
}

const select = () => screen.getByTestId('mcp-tool-list-mode') as HTMLSelectElement;
const options = () => within(select()).getAllByRole('option').map((o) => o.textContent);
const effective = () => screen.getByTestId('mcp-tool-list-effective').textContent;

describe('McpToolListModeField', () => {
  it('offers inherit (naming the deployment default), full and progressive', () => {
    setup({ initial: null, deploymentDefault: 'progressive' });
    expect(options()).toEqual(['Inherit (deployment default: Progressive)', 'Full', 'Progressive']);
    expect(screen.getByLabelText('MCP tool list')).toBe(select());
  });

  it.each([
    [null, 'full', 'Full — deployment default'],
    [null, 'progressive', 'Progressive — deployment default'],
    ['full', 'progressive', 'Full — set on this key'],
    ['progressive', 'full', 'Progressive — set on this key'],
  ] as const)('value %s under default %s shows "%s"', (initial, deploymentDefault, text) => {
    setup({ initial, deploymentDefault });
    expect(effective()).toContain(text);
  });

  it('a connection says so, and each variant says organizations cannot override it', () => {
    setup({ initial: 'full', variant: 'connection' });
    expect(effective()).toContain('Full — set on this connection');
    expect(screen.getByText(/Set per connection\. Organizations cannot override it\./)).toBeTruthy();
  });

  it("shows the server's effective mode for the stored value", () => {
    setup({ initial: null, deploymentDefault: 'full', effective: { mode: 'progressive', source: 'deployment_default' } });
    expect(effective()).toContain('Progressive — deployment default');
  });

  it('emits the mode, and null for inherit; clearing an explicit value shows what is inherited', () => {
    const onChange = setup({ initial: 'full', deploymentDefault: 'progressive' });
    fireEvent.change(select(), { target: { value: 'progressive' } });
    expect(onChange).toHaveBeenLastCalledWith('progressive');
    fireEvent.change(select(), { target: { value: 'inherit' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(effective()).toContain('Progressive — deployment default');
  });

  it('mixed shows "Multiple values", which is not a choice, and no effective line', () => {
    const onChange = setup({ initial: 'mixed' });
    expect(select().value).toBe('mixed');
    expect(options()[0]).toBe('Multiple values');
    expect(within(select()).getByRole('option', { name: 'Multiple values' })).toBeDisabled();
    expect(screen.queryByTestId('mcp-tool-list-effective')).toBeNull();
    fireEvent.change(select(), { target: { value: 'inherit' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(options()).not.toContain('Multiple values');
  });

  it('can be disabled, and never says when the value was fixed', () => {
    setup({ initial: 'full', disabled: true });
    expect(select()).toBeDisabled();
    expect(document.body.textContent).not.toMatch(/created/i);
  });
});
