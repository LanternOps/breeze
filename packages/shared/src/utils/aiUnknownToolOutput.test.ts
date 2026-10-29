import { describe, expect, it } from 'vitest';
import { isAiUnknownToolOutput, isUnknownToolErrorText } from './aiUnknownToolOutput';

describe('unknown-tool drop (#9855)', () => {
  it('recognises the Agent SDK CLI error for a nonexistent tool', () => {
    expect(isUnknownToolErrorText('<tool_use_error>Error: No such tool available: mcp__breeze__list_processes_placeholder</tool_use_error>')).toBe(true);
    expect(isUnknownToolErrorText('MCP error -32602: Input validation error: Invalid arguments for tool set_device_context')).toBe(false);
    expect(isUnknownToolErrorText('')).toBe(false);
  });

  it('accepts only the server-written dropped-call shape', () => {
    expect(isAiUnknownToolOutput({ error: 'x', droppedBeforeExecution: true, unknownTool: true })).toBe(true);
    expect(isAiUnknownToolOutput({ error: 'x', unknownTool: true })).toBe(false);
    expect(isAiUnknownToolOutput({ error: 'x', droppedBeforeExecution: true })).toBe(false);
    expect(isAiUnknownToolOutput({ droppedBeforeExecution: true, unknownTool: true })).toBe(false);
    expect(isAiUnknownToolOutput([{ unknownTool: true }])).toBe(false);
    expect(isAiUnknownToolOutput(null)).toBe(false);
    expect(isAiUnknownToolOutput('No such tool available: x')).toBe(false);
  });
});
