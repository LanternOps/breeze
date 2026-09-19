import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PolicyKeysCheckboxes, { policyActionLabel, sentenceCase, type PolicyDecidableKeyOption } from './PolicyKeysCheckboxes';

const REGISTRY: PolicyDecidableKeyOption[] = [
  { key: 'manage_services:restart', toolName: 'manage_services', action: 'restart', note: 'Restarts a service.' },
  { key: 'manage_services:stop', toolName: 'manage_services', action: 'stop', note: 'Stops a service.' },
];

describe('PolicyKeysCheckboxes (Task 13, #5051 — extracted from AiAgentForm)', () => {
  it('shows a failure message when the registry could not be loaded', () => {
    render(<PolicyKeysCheckboxes policyKeys={[]} policyKeysFailed selectedKeys={[]} onToggle={vi.fn()} />);
    expect(screen.getByTestId('ai-agent-policy-keys-failed')).toBeInTheDocument();
  });

  it('shows an empty message when the registry is empty and not a failure', () => {
    render(<PolicyKeysCheckboxes policyKeys={[]} policyKeysFailed={false} selectedKeys={[]} onToggle={vi.fn()} />);
    expect(screen.getByTestId('ai-agent-policy-keys-empty')).toBeInTheDocument();
  });

  it('groups entries by tool, reflects the selection, and reports a toggle by key', () => {
    const onToggle = vi.fn();
    render(<PolicyKeysCheckboxes policyKeys={REGISTRY} policyKeysFailed={false} selectedKeys={['manage_services:restart']} onToggle={onToggle} />);

    expect(screen.getByTestId('ai-agent-supervised-key-manage_services:restart')).toBeChecked();
    expect(screen.getByTestId('ai-agent-supervised-key-manage_services:stop')).not.toBeChecked();

    fireEvent.click(screen.getByTestId('ai-agent-supervised-key-manage_services:stop'));
    expect(onToggle).toHaveBeenCalledWith('manage_services:stop');
  });

  it('wires the registry note as the checkbox\'s accessible description', () => {
    render(<PolicyKeysCheckboxes policyKeys={REGISTRY} policyKeysFailed={false} selectedKeys={[]} onToggle={vi.fn()} />);
    const checkbox = screen.getByTestId('ai-agent-supervised-key-manage_services:restart');
    const describedBy = checkbox.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent('Restarts a service.');
  });
});

describe('sentenceCase / policyActionLabel', () => {
  it('sentence-cases a raw token', () => {
    expect(sentenceCase('manage_startup_items')).toBe('Manage startup items');
  });

  it('falls back to the sentence-cased action when no translation exists, via a plain t function', () => {
    const t = (_key: string, opts?: Record<string, unknown>) => (opts?.defaultValue as string) ?? _key;
    const label = policyActionLabel(t, { key: 'manage_services:restart', toolName: 'manage_services', action: 'restart', note: '' });
    expect(label).toBe('Restart');
  });

  it('a bare-tool entry (action: null) reads as the tool label', () => {
    const t = (_key: string, opts?: Record<string, unknown>) => (opts?.defaultValue as string) ?? _key;
    const label = policyActionLabel(t, { key: 'manage_services', toolName: 'manage_services', action: null, note: '' });
    expect(label).toBe('Manage services');
  });
});
