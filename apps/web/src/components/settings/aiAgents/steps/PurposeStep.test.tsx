import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AiAgentDto } from '@breeze/shared';
import PurposeStep from './PurposeStep';
import { draftFrom, type Draft } from '../agentDraft';

function setup(overrides: Partial<Draft> = {}, propOverrides: Partial<Parameters<typeof PurposeStep>[0]> = {}) {
  const draft: Draft = { ...draftFrom(null, { ownerScope: 'organization', kind: 'triage' }), ...overrides };
  const patch = vi.fn();
  const onActAckChange = vi.fn();
  const props = {
    draft,
    patch,
    agents: [] as AiAgentDto[],
    orgId: 'org-1',
    showOwnerScope: false,
    partnerBaselineKinds: new Set<string>(),
    actSupported: true,
    actAck: false,
    onActAckChange,
    actKeysWillBeOmitted: false,
    forceNameError: false,
    ...propOverrides,
  };
  render(<PurposeStep {...props} />);
  return { patch, onActAckChange };
}

describe('PurposeStep — Fleet Designer (W01)', () => {
  it('renders the designer kind card with its own blurb, runsWhen and recommended copy', () => {
    setup();
    const card = screen.getByTestId('ai-agent-kind-card-designer');
    expect(card).toHaveTextContent('Fleet designer');
    expect(card).toHaveTextContent(
      'Reads the whole fleet and writes a justified monitoring design for a technician to approve.',
    );
    expect(card).toHaveTextContent('you start a Fleet Design for an organization, or on a quarterly schedule');
    expect(card).toHaveTextContent('a clean-slate migration, or a quarterly configuration audit');
  });

  it('passes the draft kind through to ModeChoice, disabling shadow for a designer draft', () => {
    setup({ kind: 'designer', mode: 'off' });
    expect(screen.getByTestId('ai-agent-mode-shadow')).toBeDisabled();
    expect(screen.getByTestId('ai-agent-mode-shadow-unavailable')).toBeInTheDocument();
  });

  it('leaves shadow enabled for a non-designer draft', () => {
    setup({ kind: 'triage', mode: 'off' });
    expect(screen.getByTestId('ai-agent-mode-shadow')).not.toBeDisabled();
  });

  it('patches mode to off when switching to designer while shadow is selected', () => {
    const { patch } = setup({ kind: 'triage', mode: 'shadow' });
    fireEvent.click(screen.getByTestId('ai-agent-kind-card-designer'));
    expect(patch).toHaveBeenCalledWith({ kind: 'designer', mode: 'off' });
  });

  it('does not touch mode when switching to designer from a non-shadow mode', () => {
    const { patch } = setup({ kind: 'triage', mode: 'off' });
    fireEvent.click(screen.getByTestId('ai-agent-kind-card-designer'));
    expect(patch).toHaveBeenCalledWith({ kind: 'designer' });
  });

  it('does not touch mode when switching between two non-designer kinds from shadow', () => {
    const { patch } = setup({ kind: 'triage', mode: 'shadow', ownerScope: 'partner' });
    fireEvent.click(screen.getByTestId('ai-agent-kind-card-patch'));
    expect(patch).toHaveBeenCalledWith({ kind: 'patch' });
  });
});
