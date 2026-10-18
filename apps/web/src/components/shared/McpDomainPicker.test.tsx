import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MCP_GRANTABLE_DOMAINS, normalizeMcpDomainsInput, type McpGrantableDomain } from '@breeze/shared';
import '../../lib/i18n';
import McpDomainPicker, { isMcpDomainSelectionValid } from './McpDomainPicker';

function setup(initial: McpGrantableDomain[] | null = null, variant?: 'consent') {
  const onChange = vi.fn();
  function Harness() {
    const [value, setValue] = useState<McpGrantableDomain[] | null>(initial);
    return (
      <McpDomainPicker
        idPrefix="t"
        value={value}
        variant={variant}
        onChange={(v) => {
          onChange(v);
          setValue(v);
        }}
      />
    );
  }
  render(<Harness />);
  return onChange;
}

describe('McpDomainPicker', () => {
  it('defaults to all', () => {
    setup();
    expect((screen.getByTestId('mcp-domains-all') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('mcp-domains-selected') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByTestId('mcp-domain-tickets')).toBeNull();
    expect(screen.queryByTestId('mcp-domains-error')).toBeNull();
  });

  it('renders the always-on core entry and all 13 boxes once restricted', () => {
    setup();
    fireEvent.click(screen.getByTestId('mcp-domains-selected'));
    for (const d of MCP_GRANTABLE_DOMAINS) expect(screen.getByTestId(`mcp-domain-${d}`)).toBeTruthy();
    const core = screen.getByTestId('mcp-domain-core') as HTMLInputElement;
    expect(core.checked).toBe(true);
    expect(core.disabled).toBe(true);
  });

  it('selected + boxes emits the list', () => {
    const onChange = setup();
    fireEvent.click(screen.getByTestId('mcp-domains-selected'));
    fireEvent.click(screen.getByTestId('mcp-domain-tickets'));
    fireEvent.click(screen.getByTestId('mcp-domain-devices'));
    expect(onChange).toHaveBeenLastCalledWith(['devices', 'tickets']);
    expect(screen.queryByTestId('mcp-domains-error')).toBeNull();
  });

  it('selected + none shows the error', () => {
    const onChange = setup();
    fireEvent.click(screen.getByTestId('mcp-domains-selected'));
    expect(screen.getByTestId('mcp-domains-error')).toBeTruthy();
    const last = onChange.mock.calls.at(-1)![0] as McpGrantableDomain[];
    expect(last).toEqual([]);
    expect(isMcpDomainSelectionValid(last)).toBe(false);
    expect(isMcpDomainSelectionValid(null)).toBe(true);
    expect(isMcpDomainSelectionValid(['tickets'])).toBe(true);
  });

  it('selecting every box emits null', () => {
    const onChange = setup();
    fireEvent.click(screen.getByTestId('mcp-domains-selected'));
    for (const d of MCP_GRANTABLE_DOMAINS) fireEvent.click(screen.getByTestId(`mcp-domain-${d}`));
    expect(onChange).toHaveBeenLastCalledWith(normalizeMcpDomainsInput([...MCP_GRANTABLE_DOMAINS]));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('switching back to all emits null', () => {
    const onChange = setup(['tickets']);
    expect((screen.getByTestId('mcp-domains-selected') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('mcp-domains-all'));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('shows the reconnect note only in the consent variant', () => {
    setup(null, 'consent');
    expect(screen.getByTestId('mcp-domains-reconnect-note').textContent).toMatch(/Connected apps/);
  });

  it('omits the reconnect note by default', () => {
    setup();
    expect(screen.queryByTestId('mcp-domains-reconnect-note')).toBeNull();
  });
});
