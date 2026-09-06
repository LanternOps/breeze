import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ScriptAuthorizationPicker, { type ScriptOption } from './ScriptAuthorizationPicker';

const S_ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const S_PARTNER = 'aaaaaaaa-0000-4000-8000-000000000002';
const S_SYSTEM = 'aaaaaaaa-0000-4000-8000-000000000003';

const S_OTHER_ORG = 'aaaaaaaa-0000-4000-8000-000000000004';

const LIBRARY: ScriptOption[] = [
  { id: S_ORG, name: 'Clear print spooler', orgId: 'org-1', partnerId: null, isSystem: false },
  { id: S_PARTNER, name: 'Rotate logs', orgId: null, partnerId: 'p-1', isSystem: false },
  { id: S_SYSTEM, name: 'Disk report', orgId: null, partnerId: null, isSystem: true },
  { id: S_OTHER_ORG, name: 'Other org script', orgId: 'org-2', partnerId: null, isSystem: false },
];

function renderPicker(props: Partial<React.ComponentProps<typeof ScriptAuthorizationPicker>> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <ScriptAuthorizationPicker
      ownerScope="partner"
      ownerOrgId={null}
      ceiling={null}
      ceilingResolved
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
  it('on a partner draft lists only what a partner row may authorize — partner-wide and system scripts, never an org\'s private one (#5089 review)', async () => {
    const { onChange } = renderPicker();
    expect(await screen.findByTestId(`ai-agent-script-${S_PARTNER}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ai-agent-script-${S_SYSTEM}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`ai-agent-script-${S_ORG}`)).toBeNull();
    expect(screen.queryByTestId(`ai-agent-script-${S_OTHER_ORG}`)).toBeNull();
    expect(screen.getByTestId('ai-agent-scripts-list')).toHaveTextContent('Partner-wide');

    fireEvent.click(screen.getByTestId(`ai-agent-script-${S_PARTNER}`));
    expect(onChange).toHaveBeenCalledWith([S_PARTNER]);
  });

  it('on an org draft loads the OWNER org\'s library (not the switcher\'s) and lists its own, partner-wide and system scripts only (#5089 review)', async () => {
    const loadScripts = vi.fn(async () => LIBRARY);
    renderPicker({ ownerScope: 'organization', ownerOrgId: 'org-1', loadScripts });
    expect(await screen.findByTestId(`ai-agent-script-${S_ORG}`)).toBeInTheDocument();
    expect(loadScripts).toHaveBeenCalledWith({ orgId: 'org-1' });
    expect(screen.getByTestId(`ai-agent-script-${S_PARTNER}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ai-agent-script-${S_SYSTEM}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`ai-agent-script-${S_OTHER_ORG}`)).toBeNull();
  });

  it('keeps a selected script the owner rule would hide, so a stale authorization can still be removed', async () => {
    renderPicker({ selectedIds: [S_ORG] });
    expect(await screen.findByTestId(`ai-agent-script-${S_ORG}`)).not.toBeDisabled();
  });

  it('drops a malformed row and says so on the console rather than silently (#5089 review)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPicker({ loadScripts: async () => [...LIBRARY, { id: 'x' } as ScriptOption] });
    await screen.findByTestId(`ai-agent-script-${S_PARTNER}`);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[ScriptAuthorizationPicker]'), expect.anything());
    error.mockRestore();
  });

  it('on an org draft whose ceiling is still loading, disables every unticked script and says it is checking (#5089 review)', async () => {
    renderPicker({ ownerScope: 'organization', ownerOrgId: 'org-1', ceiling: null, ceilingResolved: false, selectedIds: [S_ORG] });
    await screen.findByTestId(`ai-agent-script-${S_PARTNER}`);
    expect(screen.getByTestId('ai-agent-scripts-ceiling-loading')).toBeInTheDocument();
    expect(screen.getByTestId(`ai-agent-script-${S_PARTNER}`)).toBeDisabled();
    expect(screen.getByTestId(`ai-agent-script-${S_ORG}`)).not.toBeDisabled();
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
      ownerOrgId: 'org-1',
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
        ownerOrgId={null}
        ceiling={null}
        ceilingResolved
        runScriptAllowed
        selectedIds={[]}
        onChange={vi.fn()}
        loadScripts={async () => { throw new Error('boom'); }}
      />,
    );
    expect(await screen.findByTestId('ai-agent-scripts-failed')).toBeInTheDocument();
  });

  it('on an org draft whose ceiling could not be loaded, disables every unticked script and says why, keeping a ticked one removable (#5089 review)', async () => {
    renderPicker({ ownerScope: 'organization', ownerOrgId: 'org-1', ceiling: null, ceilingUnavailable: true, selectedIds: [S_ORG] });
    await screen.findByTestId(`ai-agent-script-${S_PARTNER}`);
    expect(screen.getByTestId('ai-agent-scripts-ceiling-unavailable')).toBeInTheDocument();
    expect(screen.getByTestId(`ai-agent-script-${S_PARTNER}`)).toBeDisabled();
    expect(screen.getByTestId(`ai-agent-script-${S_SYSTEM}`)).toBeDisabled();
    expect(screen.getByTestId(`ai-agent-script-${S_ORG}`)).not.toBeDisabled();
  });

  it('on an org draft whose partner baseline bars run_script, disables every unticked script and names the baseline, not the draft, as the reason (#5089 review)', async () => {
    renderPicker({
      ownerScope: 'organization',
      ownerOrgId: 'org-1',
      ceiling: { toolAllowlist: ['manage_services:restart'], supervisedActionKeys: [], scriptIds: [S_PARTNER] },
      runScriptAllowed: true,
      selectedIds: [],
    });
    await screen.findByTestId(`ai-agent-script-${S_PARTNER}`);
    expect(screen.getByTestId('ai-agent-scripts-run-script-not-in-ceiling')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-scripts-run-script-required')).toBeNull();
    expect(screen.getByTestId(`ai-agent-script-${S_PARTNER}`)).toBeDisabled();
  });
});
