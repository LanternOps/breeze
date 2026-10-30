import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { resolveInheritedAgentVersionPins } from '@breeze/shared';
import AgentVersionPinSelectors, { type PinnableVersions } from './AgentVersionPinSelectors';

const pinnable: PinnableVersions = {
  components: {
    agent: { versions: ['0.88.0', '0.87.0'], promoted: ['0.88.0'] },
    watchdog: { versions: ['0.88.0'], promoted: ['0.88.0'] },
  },
};

describe('AgentVersionPinSelectors', () => {
  it('partner: offers Latest promoted plus each registered version', () => {
    render(
      <AgentVersionPinSelectors context="partner" value={{}} onChange={vi.fn()} pinnable={pinnable} />,
    );
    const agent = screen.getByTestId('agent-pin-partner-agent') as HTMLSelectElement;
    const values = Array.from(agent.options).map((o) => o.value);
    expect(values).toEqual(['', '0.88.0', '0.87.0']);
    // Empty option surfaces the promoted version for context.
    expect(agent.options[0].textContent).toContain('0.88.0');
  });

  it('partner: emits the "latest" sentinel when the empty option is chosen', () => {
    const onChange = vi.fn();
    render(
      <AgentVersionPinSelectors
        context="partner"
        value={{ agent: '0.87.0' }}
        onChange={onChange}
        pinnable={pinnable}
      />,
    );
    fireEvent.change(screen.getByTestId('agent-pin-partner-agent'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ agent: 'latest' });
  });

  it("partner: a stored 'latest' shows as Latest promoted, not as an unregistered version", () => {
    render(
      <AgentVersionPinSelectors
        context="partner"
        value={{ agent: 'latest' }}
        onChange={vi.fn()}
        pinnable={pinnable}
      />,
    );
    const agent = screen.getByTestId('agent-pin-partner-agent') as HTMLSelectElement;
    expect(agent.value).toBe('');
    expect(Array.from(agent.options).map((o) => o.value)).toEqual(['', '0.88.0', '0.87.0']);
  });

  // Issue #10584: the org view used to label its empty option "Inherit partner
  // default" but save 'latest', which overrides the partner pin. Inherit and
  // "latest, ignoring the partner pin" are now two distinct options.
  it('org: offers Inherit, an explicit Latest override, and each registered version', () => {
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
    expect(Array.from(agent.options).map((o) => o.value)).toEqual(['', 'latest', '0.88.0', '0.87.0']);
    expect(agent.options[0].textContent).toMatch(/Inherit partner default \(0\.87\.0\)/i);
    expect(agent.options[1].textContent).toMatch(/latest promoted \(0\.88\.0\)/i);
    expect(agent.options[1].textContent).toMatch(/ignore partner pin/i);
  });

  it('org: offers Inherit even when the partner has no pin (a later partner pin must still apply)', () => {
    render(
      <AgentVersionPinSelectors context="organization" value={{}} onChange={vi.fn()} pinnable={pinnable} />,
    );
    const agent = screen.getByTestId('agent-pin-organization-agent') as HTMLSelectElement;
    expect(Array.from(agent.options).map((o) => o.value)).toEqual(['', 'latest', '0.88.0', '0.87.0']);
    expect(agent.options[0].textContent).toMatch(/Inherit partner default/i);
    expect(agent.value).toBe('');
  });

  it('org: choosing Inherit removes the org pin key, so the partner pin applies again', () => {
    const onChange = vi.fn();
    render(
      <AgentVersionPinSelectors
        context="organization"
        value={{ agent: '0.88.0', watchdog: '0.88.0' }}
        onChange={onChange}
        pinnable={pinnable}
        inheritedPins={{ agent: '0.87.0' }}
      />,
    );
    fireEvent.change(screen.getByTestId('agent-pin-organization-agent'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const saved = onChange.mock.calls[0][0];
    expect(saved).toEqual({ watchdog: '0.88.0' });
    expect('agent' in saved).toBe(false);
    // The resolver the heartbeat and Devices list use keys on presence: with the
    // key gone the org inherits the partner's agent pin.
    expect(
      resolveInheritedAgentVersionPins(
        { agentVersionPins: saved },
        { agentVersionPins: { agent: '0.87.0' } },
      ),
    ).toEqual({ agent: '0.87.0', watchdog: '0.88.0' });
  });

  it("org: choosing the Latest override saves 'latest', which overrides the partner pin", () => {
    const onChange = vi.fn();
    render(
      <AgentVersionPinSelectors
        context="organization"
        value={{}}
        onChange={onChange}
        pinnable={pinnable}
        inheritedPins={{ agent: '0.87.0' }}
      />,
    );
    fireEvent.change(screen.getByTestId('agent-pin-organization-agent'), { target: { value: 'latest' } });
    const saved = onChange.mock.calls[0][0];
    expect(saved).toEqual({ agent: 'latest' });
    expect(
      resolveInheritedAgentVersionPins(
        { agentVersionPins: saved },
        { agentVersionPins: { agent: '0.87.0' } },
      ).agent,
    ).toBeNull();
  });

  it("org: a stored 'latest' is shown as the Latest override, not as Inherit or an unregistered version", () => {
    render(
      <AgentVersionPinSelectors
        context="organization"
        value={{ agent: 'latest' }}
        onChange={vi.fn()}
        pinnable={pinnable}
        inheritedPins={{ agent: '0.87.0' }}
      />,
    );
    const agent = screen.getByTestId('agent-pin-organization-agent') as HTMLSelectElement;
    expect(agent.value).toBe('latest');
    expect(Array.from(agent.options).some((o) => o.textContent?.includes('unregistered'))).toBe(false);
    expect(screen.getByTestId('agent-pin-source-organization-agent').textContent).toMatch(
      /Overrides partner default \(0\.87\.0\)/i,
    );
  });

  it("org: a stored 'latest' with no partner pin says it is set for this organization", () => {
    render(
      <AgentVersionPinSelectors
        context="organization"
        value={{ agent: 'latest' }}
        onChange={vi.fn()}
        pinnable={pinnable}
      />,
    );
    expect((screen.getByTestId('agent-pin-organization-agent') as HTMLSelectElement).value).toBe('latest');
    expect(screen.getByTestId('agent-pin-source-organization-agent').textContent).toMatch(
      /this organization/i,
    );
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
