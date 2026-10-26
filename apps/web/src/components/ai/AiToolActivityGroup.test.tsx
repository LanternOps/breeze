import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AiToolActivityGroup from './AiToolActivityGroup';
import type { ChatRow, ChatUnit, ToolCall } from './aiChatGrouping';

type ToolsUnit = Extract<ChatUnit, { kind: 'tools' }>;

const T0 = new Date('2026-10-25T09:00:00Z');
const row = (id: string, role: ChatRow['role'], toolName: string, extra: Partial<ChatRow> = {}): ChatRow => ({
  id, role, content: '', toolName, createdAt: T0, ...extra,
});
const call = (key: string, toolName: string, opts: { done?: boolean; isError?: boolean; input?: Record<string, unknown> } = {}): ToolCall => ({
  key,
  toolName,
  input: opts.input,
  use: row(key, 'tool_use', toolName),
  result: opts.done === false ? null : row(`r-${key}`, 'tool_result', toolName, { isError: opts.isError }),
});
const group = (calls: ToolCall[], extra: Partial<ToolsUnit> = {}): ToolsUnit => ({
  kind: 'tools',
  id: `tools-${calls[0]?.key}`,
  calls,
  executing: calls.some((c) => c.result === null),
  failed: calls.filter((c) => c.result?.isError).length,
  handoff: false,
  startedAt: T0,
  finishedAt: calls.some((c) => c.result === null) ? null : new Date(T0.getTime() + 4_000),
  ...extra,
});
const renderCall = (c: ToolCall) => <div data-testid="rendered-call">{c.key}</div>;
const root = () => screen.getByTestId('ai-tool-group');
const toggle = () => screen.getByRole('button');

describe('AiToolActivityGroup', () => {
  it('collapsed row lists every label and the elapsed time', () => {
    render(
      <AiToolActivityGroup
        group={group([call('a', 'query_devices'), call('b', 'list_organizations'), call('c', 'manage_alerts', { input: { action: 'list' } })])}
        renderCall={renderCall}
      />,
    );
    expect(root().getAttribute('data-state')).toBe('done');
    expect(root().textContent).toContain('Searched devices · Listed organizations · Checked alerts');
    expect(root().textContent).toContain('4 s');
    expect(screen.queryByTestId('rendered-call')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false');
  });

  it('collapses repeated labels into a count', () => {
    render(
      <AiToolActivityGroup
        group={group([call('a', 'query_devices'), call('b', 'query_devices'), call('c', 'list_sites')])}
        renderCall={renderCall}
      />,
    );
    expect(root().textContent).toContain('Searched devices ×2 · Listed sites');
  });

  it('omits the elapsed time when it rounds below a second', () => {
    render(<AiToolActivityGroup group={group([call('a', 'query_devices')], { finishedAt: T0 })} renderCall={renderCall} />);
    expect(root().textContent).not.toMatch(/\d s/);
  });

  it('executing shows the current label and the done count', () => {
    render(
      <AiToolActivityGroup
        group={group([call('a', 'query_devices'), call('b', 'list_sites'), call('c', 'manage_alerts', { done: false })])}
        renderCall={renderCall}
      />,
    );
    expect(root().getAttribute('data-state')).toBe('executing');
    expect(root().textContent).toContain('Updating alerts');
    expect(root().textContent).toContain('2 done');
    expect(root().textContent).not.toContain('Searched devices');
    expect(screen.getByTestId('ai-tool-group-spinner')).toBeTruthy();
  });

  it('a failed call starts expanded and shows the red count', () => {
    render(
      <AiToolActivityGroup
        group={group([call('a', 'query_devices'), call('b', 'restart_service', { isError: true })])}
        renderCall={renderCall}
      />,
    );
    expect(root().getAttribute('data-state')).toBe('failed');
    const failed = screen.getByTestId('ai-tool-group-failed');
    expect(failed.textContent).toBe('1 failed');
    expect(failed.className).toContain('text-destructive');
    expect(screen.getAllByTestId('rendered-call').map((n) => n.textContent)).toEqual(['a', 'b']);
  });

  it('opens by itself when a call fails after it rendered collapsed, unless the user chose', () => {
    const calls = [call('a', 'query_devices'), call('b', 'list_sites', { done: false })];
    const { rerender } = render(<AiToolActivityGroup group={group(calls)} renderCall={renderCall} />);
    expect(screen.queryByTestId('rendered-call')).toBeNull();
    const failedCalls = [calls[0] as ToolCall, call('b', 'list_sites', { isError: true })];
    rerender(<AiToolActivityGroup group={group(failedCalls)} renderCall={renderCall} />);
    expect(screen.getAllByTestId('rendered-call')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByTestId('rendered-call')).toBeNull();
  });

  it('an approval handoff in the group starts expanded', () => {
    render(<AiToolActivityGroup group={group([call('a', 'restart_service')], { handoff: true })} renderCall={renderCall} />);
    expect(screen.getAllByTestId('rendered-call')).toHaveLength(1);
  });

  it('defaultExpanded forces it open', () => {
    render(<AiToolActivityGroup group={group([call('a', 'query_devices')])} renderCall={renderCall} defaultExpanded />);
    expect(screen.getAllByTestId('rendered-call')).toHaveLength(1);
  });

  it('toggle expands to the rendered calls in order and collapses again', () => {
    render(<AiToolActivityGroup group={group([call('a', 'query_devices'), call('b', 'list_sites')])} renderCall={renderCall} />);
    fireEvent.click(toggle());
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByTestId('rendered-call').map((n) => n.textContent)).toEqual(['a', 'b']);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByTestId('rendered-call')).toBeNull();
  });

  it('labels an orphan result with no tool name', () => {
    const orphan: ToolCall = { key: 'o', toolName: '', use: null, result: row('o', 'tool_result', '') };
    render(<AiToolActivityGroup group={group([orphan])} renderCall={renderCall} />);
    expect(root().textContent).toContain('Tool result');
  });
});
