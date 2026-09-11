import { describe, it, expect } from 'vitest';
import { isAllowedForSession, stripMcpPrefix } from './mcpToolNames';

/**
 * These two pure helpers gate two security decisions — which tools a session
 * may invoke (`isAllowedForSession`, aiAgentSdk.createSessionPreToolUse) and
 * which tool results must be sealed (`stripMcpPrefix`, via
 * secretBearingTools.isSecretBearingTool). Both fail OPEN if the
 * normalization is ever narrowed to a single hard-coded server prefix, so the
 * leaf's contract is pinned here rather than only inferred from its callers.
 */
describe('stripMcpPrefix', () => {
  it('strips the prefix for ANY MCP server, not just mcp__breeze__', () => {
    expect(stripMcpPrefix('mcp__breeze__run_script')).toBe('run_script');
    expect(stripMcpPrefix('mcp__script_builder__execute_script_on_device'))
      .toBe('execute_script_on_device');
    expect(stripMcpPrefix('mcp__some_future_server__m365_reset_password'))
      .toBe('m365_reset_password');
  });

  it('leaves an already-bare name alone', () => {
    expect(stripMcpPrefix('run_script')).toBe('run_script');
    expect(stripMcpPrefix('')).toBe('');
  });

  it('leaves a malformed prefix alone rather than guessing', () => {
    // No second separator: there is no server segment to remove, and inventing
    // one would let `mcp__run_script` masquerade as the bare `run_script`.
    expect(stripMcpPrefix('mcp__run_script')).toBe('mcp__run_script');
    expect(stripMcpPrefix('notmcp__breeze__run_script')).toBe('notmcp__breeze__run_script');
  });

  it('keeps only the first server segment, so a nested-looking name is not over-stripped', () => {
    expect(stripMcpPrefix('mcp__breeze__mcp__evil__run_script')).toBe('mcp__evil__run_script');
  });
});

describe('isAllowedForSession', () => {
  const allowlist = [
    'mcp__script_builder__query_devices',
    'mcp__script_builder__execute_script_on_device',
  ];

  it('matches regardless of which side carries the prefix', () => {
    expect(isAllowedForSession('mcp__script_builder__query_devices', allowlist)).toBe(true);
    expect(isAllowedForSession('query_devices', allowlist)).toBe(true);
    expect(isAllowedForSession('mcp__breeze__query_devices', allowlist)).toBe(true);
  });

  it('denies anything the allowlist does not name', () => {
    for (const denied of [
      'run_script',                    // the handler behind execute_script_on_device (#4883)
      'mcp__script_builder__run_script',
      'execute_command',
      'mcp__breeze__execute_command',
      'query_device',                  // near-miss, not a prefix match
      'query_devices_extra',
    ]) {
      expect(isAllowedForSession(denied, allowlist), `${denied} must be denied`).toBe(false);
    }
  });

  it('denies everything against an empty allowlist, including the empty name', () => {
    expect(isAllowedForSession('query_devices', [])).toBe(false);
    expect(isAllowedForSession('', [])).toBe(false);
    // Fails CLOSED: no real allowlist entry normalizes to the empty string.
    expect(isAllowedForSession('', allowlist)).toBe(false);
  });
});
