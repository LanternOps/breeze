/**
 * Tool catalog W01 PR C (#5216) — the discovered-tools table.
 *
 * This is the surface where a tech decides what the assistant may call and at
 * what approval bar, so the assertions are about REFUSALS as much as actions:
 * a tool removed upstream cannot be re-enabled, and only a Tier-1 (read-only)
 * tool offers the test call — the API rejects a test on anything else with a
 * 403, and an offered-then-refused button is a worse lie than no button.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const patchSourceTool = vi.hoisted(() => vi.fn());
const bulkTools = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ patchSourceTool, bulkTools }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { DiscoveredToolsTable } from './DiscoveredToolsTable';
import { ActionError } from '../../lib/runAction';
import type { ToolSourceToolDto } from './api';

function tool(overrides: Partial<ToolSourceToolDto> = {}): ToolSourceToolDto {
  return {
    id: 't-1',
    sourceId: 's-1',
    name: 'get_asset',
    qualifiedName: 'hudu__get_asset',
    description: 'Fetch one asset',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: {},
    proposedTier: 1,
    tier: 1,
    enabled: false,
    reviewNeeded: false,
    revision: 'rev-1',
    discoveredAt: '2026-10-16T00:00:00.000Z',
    removedAt: null,
    lastError: null,
    ...overrides,
  };
}

function renderTable(tools: ToolSourceToolDto[], onChanged = vi.fn()) {
  render(<DiscoveredToolsTable sourceId="s-1" tools={tools} onChanged={onChanged} onTest={vi.fn()} />);
  return onChanged;
}

beforeEach(() => {
  vi.clearAllMocks();
  patchSourceTool.mockImplementation(async (_f, _s, _t, body) => tool({ ...body }));
  bulkTools.mockResolvedValue({ mode: 'enable_reads', updated: 3 });
});

describe('DiscoveredToolsTable', () => {
  it('enabling a tool PATCHes { enabled: true }', async () => {
    const user = userEvent.setup();
    renderTable([tool()]);
    await user.click(screen.getByTestId('tool-row-t-1-enabled'));
    await waitFor(() => expect(patchSourceTool).toHaveBeenCalled());
    expect(patchSourceTool.mock.calls[0]!.slice(1)).toEqual(['s-1', 't-1', { enabled: true }]);
  });

  it('changing the risk tier PATCHes { tier }', async () => {
    const user = userEvent.setup();
    renderTable([tool()]);
    await user.selectOptions(screen.getByTestId('tool-row-t-1-tier'), '2');
    await waitFor(() => expect(patchSourceTool).toHaveBeenCalled());
    expect(patchSourceTool.mock.calls[0]!.slice(1)).toEqual(['s-1', 't-1', { tier: 2 }]);
  });

  it('offers the test call for a Tier-1 tool only', () => {
    renderTable([tool(), tool({ id: 't-2', qualifiedName: 'hudu__create_asset', tier: 3 })]);
    expect(screen.getByTestId('tool-row-t-1-test')).toBeTruthy();
    expect(screen.queryByTestId('tool-row-t-2-test')).toBeNull();
  });

  it('a tool removed upstream cannot be enabled or re-tiered', () => {
    renderTable([tool({ removedAt: '2026-10-16T01:00:00.000Z' })]);
    expect((screen.getByTestId('tool-row-t-1-enabled') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('tool-row-t-1-tier') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByTestId('tool-row-t-1-flag-removed')).toBeTruthy();
  });

  it('an unaddressable name cannot be enabled — it can never resolve', () => {
    renderTable([tool({ lastError: 'name_not_addressable' })]);
    expect((screen.getByTestId('tool-row-t-1-enabled') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('tool-row-t-1-flag-not-addressable')).toBeTruthy();
  });

  it('flags a tool whose upstream definition changed as needing review', () => {
    renderTable([tool({ reviewNeeded: true })]);
    expect(screen.getByTestId('tool-row-t-1-flag-review')).toBeTruthy();
  });

  it('a tool still flagged reviewNeeded cannot be enabled from its own switch — the tier select is the review', () => {
    renderTable([tool({ reviewNeeded: true })]);
    expect((screen.getByTestId('tool-row-t-1-enabled') as HTMLButtonElement).disabled).toBe(true);
    // Setting the tier IS the review (matches the API contract), and stays enabled.
    expect((screen.getByTestId('tool-row-t-1-tier') as HTMLSelectElement).disabled).toBe(false);
  });

  it('a reviewNeeded tool that is already enabled can still be turned off', () => {
    renderTable([tool({ reviewNeeded: true, enabled: true })]);
    expect((screen.getByTestId('tool-row-t-1-enabled') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the tier the discovery PROPOSED next to the effective one', () => {
    renderTable([tool({ proposedTier: 3, tier: 1 })]);
    const row = screen.getByTestId('tool-row-t-1');
    // The proposal is what the server judged from the tool's own annotations;
    // an operator lowering it below that is a decision they should see.
    expect(within(row).getByTestId('tool-row-t-1-proposed').textContent).toContain('3');
  });

  it('bulk actions call the bulk route, not a per-row fan-out', async () => {
    const user = userEvent.setup();
    renderTable([tool(), tool({ id: 't-2' })]);
    await user.click(screen.getByTestId('tools-enable-reads'));
    await user.click(screen.getByTestId('tools-enable-reads-confirm'));
    await waitFor(() => expect(bulkTools).toHaveBeenCalled());
    expect(bulkTools.mock.calls[0]!.slice(1)).toEqual(['s-1', 'enable_reads']);
    expect(patchSourceTool).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('tools-disable-all'));
    await waitFor(() => expect(bulkTools).toHaveBeenCalledTimes(2));
    expect(bulkTools.mock.calls[1]!.slice(1)).toEqual(['s-1', 'disable_all']);
  });

  it('Enable Reads asks for confirmation and enumerates exactly the tools it will enable', async () => {
    const user = userEvent.setup();
    renderTable([
      tool({ id: 't-1', qualifiedName: 'hudu__get_asset' }),
      // Already enabled — not part of what this action WOULD change.
      tool({ id: 't-2', qualifiedName: 'hudu__list_assets', enabled: true }),
      // Still needs human review — must not be offered for auto-enable.
      tool({ id: 't-3', qualifiedName: 'hudu__get_secret', reviewNeeded: true }),
      // Tier 3 — enable_reads only ever touches tier-1 tools server-side.
      tool({ id: 't-4', qualifiedName: 'hudu__delete_asset', tier: 3 }),
    ]);

    await user.click(screen.getByTestId('tools-enable-reads'));

    expect(bulkTools).not.toHaveBeenCalled();
    const dialog = screen.getByTestId('tools-enable-reads-dialog');
    expect(within(dialog).getByText('hudu__get_asset')).toBeTruthy();
    expect(within(dialog).queryByText('hudu__list_assets')).toBeNull();
    expect(within(dialog).queryByText('hudu__get_secret')).toBeNull();
    expect(within(dialog).queryByText('hudu__delete_asset')).toBeNull();

    await user.click(screen.getByTestId('tools-enable-reads-confirm'));
    await waitFor(() => expect(bulkTools).toHaveBeenCalled());
  });

  it('Enable Reads confirmation can be cancelled without calling the bulk route', async () => {
    const user = userEvent.setup();
    renderTable([tool()]);
    await user.click(screen.getByTestId('tools-enable-reads'));
    expect(screen.getByTestId('tools-enable-reads-dialog')).toBeTruthy();
    await user.click(screen.getByText('Cancel'));
    expect(screen.queryByTestId('tools-enable-reads-dialog')).toBeNull();
    expect(bulkTools).not.toHaveBeenCalled();
  });

  it('Enable Reads confirmation disables the confirm button with nothing eligible', async () => {
    const user = userEvent.setup();
    renderTable([tool({ enabled: true })]);
    await user.click(screen.getByTestId('tools-enable-reads'));
    const confirmButton = screen.getByTestId('tools-enable-reads-confirm') as HTMLButtonElement;
    expect(confirmButton.getAttribute('aria-disabled')).toBe('true');
  });

  it('clicking Test hands the tool to the drawer instead of calling the API itself', async () => {
    const user = userEvent.setup();
    const onTest = vi.fn();
    render(<DiscoveredToolsTable sourceId="s-1" tools={[tool()]} onChanged={vi.fn()} onTest={onTest} />);
    await user.click(screen.getByTestId('tool-row-t-1-test'));
    expect(onTest).toHaveBeenCalledWith(expect.objectContaining({ id: 't-1' }));
    expect(patchSourceTool).not.toHaveBeenCalled();
  });

  it('a FAILED patch does not report a change, and leaves the row usable again', async () => {
    const user = userEvent.setup();
    patchSourceTool.mockRejectedValueOnce(new ActionError('Forbidden', 403));
    const onChanged = renderTable([tool()]);

    await user.click(screen.getByTestId('tool-row-t-1-enabled'));

    await waitFor(() => expect(patchSourceTool).toHaveBeenCalled());
    // The caller must not refetch as if it worked…
    expect(onChanged).not.toHaveBeenCalled();
    // …and the control must not be left permanently disabled by the busy flag.
    await waitFor(() =>
      expect((screen.getByTestId('tool-row-t-1-enabled') as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('a FAILED bulk action does not report a change either', async () => {
    const user = userEvent.setup();
    bulkTools.mockRejectedValueOnce(new ActionError('Forbidden', 403));
    const onChanged = renderTable([tool()]);

    await user.click(screen.getByTestId('tools-enable-reads'));
    await user.click(screen.getByTestId('tools-enable-reads-confirm'));

    await waitFor(() => expect(bulkTools).toHaveBeenCalled());
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('renders the empty state rather than a headerless table', () => {
    renderTable([]);
    expect(screen.getByTestId('tools-empty')).toBeTruthy();
  });
});
