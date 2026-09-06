import { describe, expect, it } from 'vitest';
import { aiToolLabel, toolRowStatus, toolRowSuffix } from './toolIndicatorLogic';

describe('toolRowStatus (#5107)', () => {
  it('reads an approved-executing handoff as approved, not failed', () => {
    // The bug: the user approved a service restart on their phone, the durable
    // approval worker took the action, and the chat then painted
    // "MANAGE_SERVICES · FAILED" in deny-red. The server now publishes this
    // outcome with isError:false and a machine-readable status.
    expect(toolRowStatus({ isError: false, output: { status: 'approved_executing' } })).toBe('approved');
  });

  it('trusts the status field even if isError were somehow still set', () => {
    // Defense in depth: a stale API (or a replayed message row persisted
    // before this fix) must not resurrect the red FAILED row.
    expect(toolRowStatus({ isError: true, output: { status: 'approved_executing' } })).toBe('approved');
  });

  it('still distinguishes denial from generic failure', () => {
    expect(toolRowStatus({ isError: true, output: { error: 'Tool execution was rejected' } })).toBe('denied');
    expect(toolRowStatus({ isError: true, output: { error: 'Access denied' } })).toBe('denied');
    expect(toolRowStatus({ isError: true, output: { error: 'ECONNRESET' } })).toBe('failed');
    expect(toolRowStatus({ isError: true, output: undefined })).toBe('failed');
  });

  it('treats an ordinary result as completed', () => {
    expect(toolRowStatus({ isError: false, output: { devices: [] } })).toBe('completed');
    expect(toolRowStatus({})).toBe('completed');
  });

  it('does not mistake a tool that merely mentions the phrase for a handoff', () => {
    // The handoff is a STATUS FIELD, never a string match — the whole point of
    // #5107's contract. A tool whose output happens to contain the words must
    // not be re-coloured.
    expect(toolRowStatus({ isError: false, output: { message: 'approved_executing' } })).toBe('completed');
    expect(toolRowStatus({ isError: false, output: 'approved_executing' })).toBe('completed');
  });
});

describe('toolRowSuffix', () => {
  it('says approved and running for a handoff', () => {
    expect(toolRowSuffix('approved')).toBe('APPROVED · RUNNING');
  });

  it('keeps the existing captions for the other states', () => {
    expect(toolRowSuffix('completed')).toBe('DONE');
    expect(toolRowSuffix('denied')).toBe('DENIED');
    expect(toolRowSuffix('failed')).toBe('FAILED');
  });
});

describe('aiToolLabel (mobile mirror of packages/shared)', () => {
  it('reads as an action, not a symbol', () => {
    expect(aiToolLabel('manage_alerts', 'completed')).toBe('Updated alerts');
    expect(aiToolLabel('get_fleet_findings', 'completed')).toBe('Checked fleet findings');
    expect(aiToolLabel('search_logs', 'completed')).toBe('Searched logs');
    expect(aiToolLabel('manage_services', 'running')).toBe('Updating services');
  });

  it('falls back to readable title case for an unmapped tool', () => {
    expect(aiToolLabel('disk_cleanup', 'completed')).toBe('Disk cleanup');
    expect(aiToolLabel('brand_new_tool_nobody_mapped', 'running')).toBe('Brand new tool nobody mapped');
  });

  it('strips the mcp__server__ prefix and never emits an underscore', () => {
    expect(aiToolLabel('mcp__breeze__manage_alerts', 'completed')).toBe('Updated alerts');
    for (const name of ['', '__', 'get_', 'mcp__breeze__']) {
      expect(aiToolLabel(name, 'completed')).not.toContain('_');
      expect(aiToolLabel(name, 'completed').length).toBeGreaterThan(0);
    }
  });
});
