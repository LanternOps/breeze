import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ScriptAuthorizationPicker, { type ScriptOption } from './ScriptAuthorizationPicker';

const S_ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const S_PARTNER = 'aaaaaaaa-0000-4000-8000-000000000002';
const S_SYSTEM = 'aaaaaaaa-0000-4000-8000-000000000003';

const LIBRARY: ScriptOption[] = [
  { id: S_ORG, name: 'Clear print spooler', orgId: 'org-1', partnerId: null, isSystem: false },
  { id: S_PARTNER, name: 'Rotate logs', orgId: null, partnerId: 'p-1', isSystem: false },
  { id: S_SYSTEM, name: 'Disk report', orgId: null, partnerId: null, isSystem: true },
];

function renderPicker(props: Partial<React.ComponentProps<typeof ScriptAuthorizationPicker>> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <ScriptAuthorizationPicker
      ownerScope="partner"
      ceiling={null}
      runScriptAllowed
      selectedIds={[]}
      onChange={onChange}
      loadScripts={async () => LIBRARY}
      {...props}
    />,
  );
  return { ...utils, onChange };
}

describe('ScriptAuthorizationPicker', () => {
  it('lists the library with scope badges and toggles a script into the selection', async () => {
    const { onChange } = renderPicker();
    expect(await screen.findByTestId(`ai-agent-script-${S_ORG}`)).toBeInTheDocument();
    expect(screen.getByTestId('ai-agent-scripts-list')).toHaveTextContent('Partner-wide');

    fireEvent.click(screen.getByTestId(`ai-agent-script-${S_PARTNER}`));
    expect(onChange).toHaveBeenCalledWith([S_PARTNER]);
  });

  it('removes an already-selected script on a second click and counts the selection', async () => {
    const { onChange } = renderPicker({ selectedIds: [S_PARTNER, S_SYSTEM] });
    await screen.findByTestId(`ai-agent-script-${S_PARTNER}`);
    expect(screen.getByTestId('ai-agent-scripts-count')).toHaveTextContent('2 scripts authorized');

    fireEvent.click(screen.getByTestId(`ai-agent-script-${S_PARTNER}`));
    expect(onChange).toHaveBeenCalledWith([S_SYSTEM]);
  });

  it('disables every unticked script and says why while the allowlist does not admit run_script, but still lets a ticked one be removed', async () => {
    renderPicker({ runScriptAllowed: false, selectedIds: [S_ORG] });
    await screen.findByTestId(`ai-agent-script-${S_ORG}`);
    expect(screen.getByTestId('ai-agent-scripts-run-script-required')).toBeInTheDocument();
    expect(screen.getByTestId(`ai-agent-script-${S_PARTNER}`)).toBeDisabled();
    expect(screen.getByTestId(`ai-agent-script-${S_ORG}`)).not.toBeDisabled();
  });

  it('on an org draft, disables scripts outside the partner ceiling with the not-in-baseline badge, keeping a stale selection removable', async () => {
    renderPicker({
      ownerScope: 'organization',
      ceiling: { toolAllowlist: ['run_script'], supervisedActionKeys: [], scriptIds: [S_PARTNER] },
      selectedIds: [S_SYSTEM],
    });
    await screen.findByTestId(`ai-agent-script-${S_ORG}`);
    expect(screen.getByTestId(`ai-agent-script-${S_ORG}`)).toBeDisabled();
    expect(screen.getByTestId(`ai-agent-script-${S_ORG}-not-in-ceiling`)).toHaveTextContent('Not in partner baseline');
    expect(screen.getByTestId(`ai-agent-script-${S_PARTNER}`)).not.toBeDisabled();
    // Stale: selected but outside the ceiling — enabled so it can be unticked.
    expect(screen.getByTestId(`ai-agent-script-${S_SYSTEM}`)).not.toBeDisabled();
    expect(screen.queryByTestId('ai-agent-scripts-ceiling-hint')).toBeNull();
  });

  it('shows the ceiling hint on a partner draft, the empty state on an empty library, and the failure state on a load error', async () => {
    const { rerender } = renderPicker({ loadScripts: async () => [] });
    expect(screen.getByTestId('ai-agent-scripts-ceiling-hint')).toBeInTheDocument();
    expect(await screen.findByTestId('ai-agent-scripts-empty')).toBeInTheDocument();

    rerender(
      <ScriptAuthorizationPicker
        ownerScope="partner"
        ceiling={null}
        runScriptAllowed
        selectedIds={[]}
        onChange={vi.fn()}
        loadScripts={async () => { throw new Error('boom'); }}
      />,
    );
    expect(await screen.findByTestId('ai-agent-scripts-failed')).toBeInTheDocument();
  });
});
