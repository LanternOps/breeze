/**
 * Tool catalog W01 PR C (#5216) — the Tier-1 test drawer.
 *
 * This is the one surface in the feature that performs a LIVE call against a
 * customer's system on a button press, so the assertions are about what it
 * refuses: malformed arguments never leave the browser, and a failed call
 * renders as a failure — the route answers HTTP 200 for one, and a green
 * result block over a failed call is the exact lie `runAction`'s
 * `{success:false}` rule exists to prevent.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const testSourceTool = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ testSourceTool }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { ToolTestDrawer, seedInput } from './ToolTestDrawer';
import { ActionError } from '../../lib/runAction';
import type { ToolSourceToolDto } from './api';

function tool(overrides: Partial<ToolSourceToolDto> = {}): ToolSourceToolDto {
  return {
    id: 't-1',
    sourceId: 's-1',
    name: 'get_asset',
    qualifiedName: 'hudu__get_asset',
    description: 'Fetch one asset',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, verbose: { type: 'boolean' } },
      required: ['id'],
    },
    annotations: {},
    proposedTier: 1,
    tier: 1,
    enabled: true,
    reviewNeeded: false,
    revision: 'rev-1',
    discoveredAt: '2026-10-16T00:00:00.000Z',
    removedAt: null,
    lastError: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  testSourceTool.mockResolvedValue({ result: '{"id":"a-1"}', isError: false, durationMs: 12 });
});

describe('seedInput', () => {
  it('seeds exactly the schema\'s required keys, not every property', () => {
    expect(JSON.parse(seedInput({ properties: { a: {}, b: {} }, required: ['a'] }))).toEqual({ a: '' });
  });

  it('tolerates a schema with no required list, or a malformed one', () => {
    expect(JSON.parse(seedInput({ type: 'object' }))).toEqual({});
    expect(JSON.parse(seedInput({ required: 'id' } as unknown as Record<string, unknown>))).toEqual({});
    expect(JSON.parse(seedInput({ required: ['a', 7] } as unknown as Record<string, unknown>))).toEqual({ a: '' });
  });
});

describe('ToolTestDrawer', () => {
  it('seeds the editor from the schema and runs the call with the parsed arguments', async () => {
    const user = userEvent.setup();
    render(<ToolTestDrawer sourceId="s-1" tool={tool()} onClose={vi.fn()} />);

    const input = screen.getByTestId('tool-test-input') as HTMLTextAreaElement;
    expect(JSON.parse(input.value)).toEqual({ id: '' });

    await user.clear(input);
    await user.type(input, '{{"id":"a-1"}');
    await user.click(screen.getByTestId('tool-test-run'));

    await waitFor(() => expect(testSourceTool).toHaveBeenCalled());
    expect(testSourceTool.mock.calls[0]!.slice(1)).toEqual(['s-1', 't-1', { id: 'a-1' }]);
    expect((await screen.findByTestId('tool-test-result')).textContent).toContain('a-1');
  });

  it('refuses unparseable arguments without ever calling the API', async () => {
    const user = userEvent.setup();
    render(<ToolTestDrawer sourceId="s-1" tool={tool()} onClose={vi.fn()} />);

    const input = screen.getByTestId('tool-test-input');
    await user.clear(input);
    await user.type(input, 'not json');
    await user.click(screen.getByTestId('tool-test-run'));

    expect(testSourceTool).not.toHaveBeenCalled();
    expect(screen.getByTestId('tool-test-error')).toBeTruthy();
    expect(screen.queryByTestId('tool-test-result')).toBeNull();
  });

  it('a FAILED call renders as an error and never as a result', async () => {
    const user = userEvent.setup();
    testSourceTool.mockRejectedValueOnce(
      new ActionError('MCP call failed: 502', 200, 'tool_test_failed', { success: false }),
    );
    render(<ToolTestDrawer sourceId="s-1" tool={tool()} onClose={vi.fn()} />);

    await user.click(screen.getByTestId('tool-test-run'));

    expect((await screen.findByTestId('tool-test-error')).textContent).toContain('502');
    expect(screen.queryByTestId('tool-test-result')).toBeNull();
  });

  it('a later failure clears the previous success, so a stale green result cannot linger', async () => {
    const user = userEvent.setup();
    render(<ToolTestDrawer sourceId="s-1" tool={tool()} onClose={vi.fn()} />);

    await user.click(screen.getByTestId('tool-test-run'));
    await screen.findByTestId('tool-test-result');

    testSourceTool.mockRejectedValueOnce(new ActionError('boom', 200, 'tool_test_failed', {}));
    await user.click(screen.getByTestId('tool-test-run'));

    await waitFor(() => expect(screen.queryByTestId('tool-test-result')).toBeNull());
    expect(screen.getByTestId('tool-test-error')).toBeTruthy();
  });

  // #6102: a tool whose source has flipped to `error` must read as a
  // distinct, actionable message — not the generic 404 a real access/missing
  // problem gets. `testSourceTool` (api.ts) already surfaces the server's
  // `code` on the thrown ActionError; `runAction`'s existing `errors:<CODE>`
  // lookup (see lib/runAction.ts) picks it up and swaps in the translated
  // copy before ToolTestDrawer ever sees the raw server string.
  it('renders the translated tool_source_unavailable message, not the raw server text', async () => {
    const user = userEvent.setup();
    testSourceTool.mockRejectedValueOnce(
      new ActionError(
        'Tool source "Hudu" is not active (status: error)',
        503,
        'tool_source_unavailable',
        { error: 'Tool source "Hudu" is not active (status: error)', code: 'tool_source_unavailable', sourceStatus: 'error' },
      ),
    );
    render(<ToolTestDrawer sourceId="s-1" tool={tool()} onClose={vi.fn()} />);

    await user.click(screen.getByTestId('tool-test-run'));

    expect((await screen.findByTestId('tool-test-error')).textContent).toBe(
      "This tool's source is currently unavailable",
    );
    expect(screen.queryByTestId('tool-test-result')).toBeNull();
  });

  it('leaves a 401 to the auth redirect rather than painting it inline', async () => {
    const user = userEvent.setup();
    testSourceTool.mockRejectedValueOnce(new ActionError('Unauthorized', 401));
    render(<ToolTestDrawer sourceId="s-1" tool={tool()} onClose={vi.fn()} />);

    await user.click(screen.getByTestId('tool-test-run'));

    await waitFor(() => expect(testSourceTool).toHaveBeenCalled());
    expect(screen.queryByTestId('tool-test-error')).toBeNull();
  });
});
