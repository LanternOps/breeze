import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AgentVersionPinSelectors, { type PinnableVersions } from './AgentVersionPinSelectors';

const pinnable: PinnableVersions = {
  components: {
    agent: { versions: ['0.88.0', '0.87.0'], promoted: ['0.88.0'] },
    watchdog: { versions: ['0.88.0'], promoted: ['0.88.0'] },
  },
};

describe('AgentVersionPinSelectors', () => {
  it('offers Latest promoted plus each registered version', () => {
    render(
      <AgentVersionPinSelectors context="organization" value={{}} onChange={vi.fn()} pinnable={pinnable} />,
    );
    const agent = screen.getByTestId('agent-pin-organization-agent') as HTMLSelectElement;
    const values = Array.from(agent.options).map((o) => o.value);
    expect(values).toEqual(['', '0.88.0', '0.87.0']);
    // Empty option surfaces the promoted version for context.
    expect(agent.options[0].textContent).toContain('0.88.0');
  });

  it('emits the "latest" sentinel when the empty option is chosen', () => {
    const onChange = vi.fn();
    render(
      <AgentVersionPinSelectors
        context="organization"
        value={{ agent: '0.87.0' }}
        onChange={onChange}
        pinnable={pinnable}
      />,
    );
    fireEvent.change(screen.getByTestId('agent-pin-organization-agent'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ agent: 'latest' });
  });

  it('shows the org-pin provenance when a version is pinned', () => {
    render(
      <AgentVersionPinSelectors
        context="organization"
        value={{ agent: '0.87.0' }}
        onChange={vi.fn()}
        pinnable={pinnable}
      />,
    );
    expect(screen.getByTestId('agent-pin-source-organization-agent').textContent).toMatch(
      /Pinned for this organization/i,
    );
  });

  it('shows the inherited partner default (editable) when the org has not set its own pin', () => {
    render(
      <AgentVersionPinSelectors
        context="organization"
        value={{}}
        onChange={vi.fn()}
        pinnable={pinnable}
        inheritedPins={{ agent: '0.87.0' }}
      />,
    );
    const agent = screen.getByTestId('agent-pin-organization-agent') as HTMLSelectElement;
    // Inherit-with-override: never disabled — the org can override.
    expect(agent.disabled).toBe(false);
    // The org's OWN value is empty (inheriting), and the empty option surfaces
    // the inherited partner value.
    expect(agent.value).toBe('');
    expect(agent.options[0].textContent).toMatch(/Inherit partner default \(0\.87\.0\)/i);
    expect(screen.getByTestId('agent-pin-source-organization-agent').textContent).toMatch(
      /Inherited from partner: 0\.87\.0/i,
    );
  });

  it('marks an org pin that overrides the partner default', () => {
    render(
      <AgentVersionPinSelectors
        context="organization"
        value={{ agent: '0.88.0' }}
        onChange={vi.fn()}
        pinnable={pinnable}
        inheritedPins={{ agent: '0.87.0' }}
      />,
    );
    const agent = screen.getByTestId('agent-pin-organization-agent') as HTMLSelectElement;
    expect(agent.value).toBe('0.88.0');
    expect(screen.getByTestId('agent-pin-source-organization-agent').textContent).toMatch(
      /Overrides partner default \(0\.87\.0\)/i,
    );
  });

  it('preserves a stored pin whose build is no longer registered', () => {
    render(
      <AgentVersionPinSelectors
        context="partner"
        value={{ agent: '0.50.0' }}
        onChange={vi.fn()}
        pinnable={pinnable}
      />,
    );
    const agent = screen.getByTestId('agent-pin-partner-agent') as HTMLSelectElement;
    expect(agent.value).toBe('0.50.0');
    expect(Array.from(agent.options).some((o) => o.textContent?.includes('unregistered'))).toBe(true);
  });
});
