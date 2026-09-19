import { describe, expect, it } from 'vitest';
import { aiToolLabel, toolRowErrorText, toolRowStatus, toolRowSuffix } from './toolIndicatorLogic';

describe('toolRowStatus (#5107)', () => {
  it('reads a server-asserted handoff as approved, not failed', () => {
    // The bug: the user approved a service restart on their phone, the durable
    // approval worker took the action, and the chat then painted
    // "MANAGE_SERVICES · FAILED" in deny-red. The server now publishes this
    // outcome with isError:false and a trusted `handoff` marker.
    expect(toolRowStatus({ isError: false, handoff: 'approved_executing' })).toBe('approved');
  });

  it('accepts output.status as a history-replay fallback', () => {
    // The SSE-level `handoff` field is not persisted on the message row, so a
    // conversation reloaded from history has only the payload to go on.
    expect(toolRowStatus({ isError: false, output: { status: 'approved_executing' } })).toBe('approved');
  });

  it('does NOT let a failing tool repaint itself as approved via its own output', () => {
    // A tool owns its output payload. Without the isError gate, any tool —
    // including a third-party extension — could emit this alongside a real
    // error and have the chat show APPROVED · RUNNING in brand colour. On
    // mobile that row has no expand affordance, so the error text would be
    // unreachable in the UI: the original bug, inverted and worse.
    expect(
      toolRowStatus({ isError: true, output: { error: 'restart failed', status: 'approved_executing' } }),
    ).toBe('failed');
    // ...and a rejection still reads as a rejection, not as an approval.
    expect(
      toolRowStatus({ isError: true, output: { error: 'Access denied', status: 'approved_executing' } }),
    ).toBe('denied');
  });

  it('still honours the trusted marker when isError is set', () => {
    // The server said handoff; that outranks a stale/contradictory isError,
    // because unlike `output` it cannot be forged by the tool.
    expect(toolRowStatus({ isError: true, handoff: 'approved_executing' })).toBe('approved');
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

describe('toolRowErrorText (#5170)', () => {
  it('reads output.error', () => {
    expect(toolRowErrorText({ error: 'restart failed: service not found' })).toBe(
      'restart failed: service not found',
    );
  });

  it('falls back to output.message when there is no error field', () => {
    expect(toolRowErrorText({ message: 'connection refused' })).toBe('connection refused');
  });

  it('prefers error over message when both are present', () => {
    expect(toolRowErrorText({ error: 'primary', message: 'secondary' })).toBe('primary');
  });

  it('returns null when there is nothing readable', () => {
    expect(toolRowErrorText(undefined)).toBeNull();
    expect(toolRowErrorText(null)).toBeNull();
    expect(toolRowErrorText('a bare string output')).toBeNull();
    expect(toolRowErrorText({ other: 'field' })).toBeNull();
    expect(toolRowErrorText({ error: '   ' })).toBeNull();
  });

  it('stringifies a nested error object instead of dropping it (#5170)', () => {
    // A backend shape like `{ error: { code, message } }` must still produce
    // SOMETHING tappable — silently falling back to the plain caption here
    // reproduces the exact bug this feature exists to fix, just for
    // object-typed errors instead of missing ones.
    const result = toolRowErrorText({ error: { code: 'E_TIMEOUT', message: 'timed out' } });
    expect(result).not.toBeNull();
    expect(result).toContain('E_TIMEOUT');
    expect(result).toContain('timed out');
  });

  it('returns null for a non-string, non-object error field (e.g. a bare number)', () => {
    expect(toolRowErrorText({ error: 42 })).toBeNull();
  });

  it('trims to ~400 chars with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const result = toolRowErrorText({ error: long });
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(401);
    expect(result!.endsWith('…')).toBe(true);
  });

  it('passes exactly 400 chars through untouched, truncates at 401', () => {
    const exactly400 = 'a'.repeat(400);
    expect(toolRowErrorText({ error: exactly400 })).toBe(exactly400);

    const exactly401 = 'a'.repeat(401);
    const truncated = toolRowErrorText({ error: exactly401 });
    expect(truncated).toBe(`${'a'.repeat(400)}…`);
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

  it('reads as a check, not a mutation, when input.action is read-only (#5170)', () => {
    // "Updated automations · DONE" when the assistant only listed automations
    // reads as a change the tech never asked for. A read-only `action` on the
    // call forces the `get` verb forms regardless of the leading verb.
    expect(aiToolLabel('manage_automations', 'completed', { action: 'list' })).toBe(
      'Checked automations',
    );
    expect(aiToolLabel('manage_automations', 'running', { action: 'list' })).toBe(
      'Checking automations',
    );
    for (const action of ['list', 'get', 'search', 'status', 'show', 'read', 'query', 'describe', 'check', 'preview', 'view']) {
      expect(aiToolLabel('manage_services', 'completed', { action })).toBe('Checked services');
    }
    // Case-insensitive.
    expect(aiToolLabel('manage_automations', 'completed', { action: 'LIST' })).toBe(
      'Checked automations',
    );
  });

  it('leaves the verb alone when input.action is a mutation or absent', () => {
    expect(aiToolLabel('manage_automations', 'completed', { action: 'create' })).toBe(
      'Updated automations',
    );
    expect(aiToolLabel('manage_automations', 'completed')).toBe('Updated automations');
    expect(aiToolLabel('manage_automations', 'completed', {})).toBe('Updated automations');
    // A non-string action is ignored, not crashed on.
    expect(aiToolLabel('manage_automations', 'completed', { action: 42 })).toBe(
      'Updated automations',
    );
  });
});
