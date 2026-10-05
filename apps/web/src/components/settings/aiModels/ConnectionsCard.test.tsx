import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SNAPSHOT, GATEWAY_CONNECTION, GW } from './testFixtures';
import { offeringRow, snapWith } from './offeringFixtures';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import ConnectionsCard from './ConnectionsCard';

describe('ConnectionsCard', () => {
  it('keeps Add connection visible with an existing Anthropic connection; the Anthropic option is disabled', () => {
    render(<ConnectionsCard snapshot={SNAPSHOT} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-connection-add'));
    expect((screen.getByTestId('ai-connection-add-kind-anthropic') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('ai-connection-add-kind-openai') as HTMLButtonElement).disabled).toBe(false);
  });

  it('choosing OpenAI-compatible opens the drawer with that kind form', () => {
    render(<ConnectionsCard snapshot={SNAPSHOT} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-connection-add'));
    fireEvent.click(screen.getByTestId('ai-connection-add-kind-openai'));
    expect(screen.getByTestId('ai-connection-openai-form')).toBeTruthy();
  });

  it('choosing Anthropic (none connected) opens the key form', () => {
    render(<ConnectionsCard snapshot={{ ...SNAPSHOT, connections: [SNAPSHOT.connections[0]!] }} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-connection-add'));
    fireEvent.click(screen.getByTestId('ai-connection-add-kind-anthropic'));
    expect(screen.getByTestId('ai-connection-key')).toBeTruthy();
  });

  it('a gateway row shows the endpoint host and the key tail', () => {
    render(<ConnectionsCard snapshot={{ ...SNAPSHOT, connections: [...SNAPSHOT.connections, GATEWAY_CONNECTION] }} onChanged={vi.fn()} />);
    expect(screen.getByTestId(`ai-connection-row-host-${GW}`).textContent).toBe('llm.example.com');
    expect(screen.getByTestId(`ai-connection-row-${GW}`).textContent).toContain('••••1234');
    expect(screen.queryByTestId(`ai-connection-env-managed-${GW}`)).toBeNull();
  });

  it('a keyless gateway row says "No key"', () => {
    render(<ConnectionsCard snapshot={{ ...SNAPSHOT, connections: [{ ...GATEWAY_CONNECTION, keyLast4: null }] }} onChanged={vi.fn()} />);
    expect(screen.getByTestId(`ai-connection-key-${GW}`).textContent).toMatch(/no key/i);
  });

  it('shows the discovered-model count, or the scrubbed discovery error', () => {
    const found = { ...GATEWAY_CONNECTION, lastDiscoveredAt: new Date(Date.now() - 3 * 60_000).toISOString() };
    const snap = snapWith([offeringRow({ id: 'a', connectionId: GW }), offeringRow({ id: 'b', connectionId: GW })]);
    const { rerender } = render(<ConnectionsCard snapshot={{ ...snap, connections: [found] }} onChanged={vi.fn()} />);
    expect(screen.getByTestId(`ai-connection-discovery-${GW}`).textContent).toMatch(/2 models/);
    rerender(<ConnectionsCard snapshot={{ ...snap, connections: [{ ...found, discoveryError: 'Endpoint unreachable' }] }} onChanged={vi.fn()} />);
    expect(screen.getByTestId(`ai-connection-discovery-${GW}`).textContent).toContain('Endpoint unreachable');
  });

  it('an env-managed row carries the badge and opens a read-only drawer', () => {
    render(<ConnectionsCard snapshot={{ ...SNAPSHOT, connections: [{ ...GATEWAY_CONNECTION, managedBy: 'env' }] }} onChanged={vi.fn()} />);
    expect(screen.getByTestId(`ai-connection-env-managed-${GW}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId(`ai-connection-edit-${GW}`));
    expect((screen.getByTestId('ai-connection-openai-base-url') as HTMLInputElement).disabled).toBe(true);
  });
});
