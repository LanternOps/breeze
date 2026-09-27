/**
 * #7130: several AI chat tool schemas hid constraints that the server or agent
 * enforce, so the model guessed wrong and paid for a failed round-trip (up to
 * 14s for a device dispatch) before finding out. Each case below asserts BOTH
 * halves: the schema exposed to the model must SHOW the constraint (via enum,
 * maxLength, or an explicit description), and `validateToolInput` — the same
 * gate `executeTool` runs before any handler or agent dispatch — must ENFORCE
 * exactly that constraint. A schema/enforcement drift is exactly the bug.
 *
 * No vi.mock — real registry and real Zod schemas throughout.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateToolInput } from './aiToolSchemas';
import { buildBreezeSdkTools } from './aiAgentSdkTools';

const TEST_UUID = '00000000-0000-0000-0000-000000000001';

function emittedTool(toolName: string) {
  const tools = buildBreezeSdkTools(() => { throw new Error('handlers must not run'); });
  const found = tools.find((t) => t.name === toolName);
  if (!found) throw new Error(`tool "${toolName}" not emitted by buildBreezeSdkTools`);
  return found;
}

function emittedInputSchema(toolName: string): Record<string, unknown> {
  return z.toJSONSchema(z.object(emittedTool(toolName).inputSchema), { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
}

describe('execute_command / event_logs_query level (#7130 case 1)', () => {
  it('the model-facing schema documents the accepted level vocabulary', () => {
    const schema = emittedInputSchema('execute_command');
    const text = JSON.stringify(schema);
    // Matches agent/internal/remote/tools/eventlogs_query.go levelToNumber exactly.
    for (const level of ['critical', 'error', 'warning', 'information', 'info', 'verbose']) {
      expect(text).toContain(level);
    }
  });

  it('rejects an unknown level before the handler/agent ever sees it', () => {
    const result = validateToolInput('execute_command', {
      deviceId: TEST_UUID,
      commandType: 'event_logs_query',
      payload: { level: 'all' },
    });
    expect(result.success).toBe(false);
  });

  it.each(['critical', 'error', 'warning', 'information', 'info', 'verbose', 1, 5])(
    'accepts a real level value (%s)',
    (level) => {
      expect(
        validateToolInput('execute_command', {
          deviceId: TEST_UUID,
          commandType: 'event_logs_query',
          payload: { level },
        }),
      ).toEqual({ success: true });
    },
  );

  it('rejects a level number out of the agent\'s 1-5 range', () => {
    const result = validateToolInput('execute_command', {
      deviceId: TEST_UUID,
      commandType: 'event_logs_query',
      payload: { level: 9 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a numeric-string level/eventId (the agent\'s own ParsePayloadInt accepts numeric strings)', () => {
    expect(
      validateToolInput('execute_command', {
        deviceId: TEST_UUID,
        commandType: 'event_logs_query',
        payload: { level: '3', eventId: '4624' },
      }),
    ).toEqual({ success: true });
  });

  it('still accepts kill_process/list_processes keys the payload schema does not name explicitly (passthrough)', () => {
    // The typed keys above only cover event_logs_query/service/file ops; other
    // commandTypes (list_processes' search/sortBy/sortDesc, kill_process's
    // force) must keep flowing through untyped rather than being dropped or
    // rejected by a schema that only knows about the documented cases.
    expect(
      validateToolInput('execute_command', {
        deviceId: TEST_UUID,
        commandType: 'list_processes',
        payload: { search: 'chrome', sortBy: 'cpu', sortDesc: true },
      }),
    ).toEqual({ success: true });
    expect(
      validateToolInput('execute_command', {
        deviceId: TEST_UUID,
        commandType: 'kill_process',
        payload: { pid: 1234, processName: 'notepad.exe', force: true },
      }),
    ).toEqual({ success: true });
  });

  it('documents that list_processes cpuPercent is per-core, not per-machine', () => {
    // No zod constraint expresses this (it describes an OUTPUT field the Go
    // agent computes as 100*cpuSeconds/wallSeconds, i.e. 100% == one core) —
    // the only surface for it is the tool description text.
    expect(emittedTool('execute_command').description).toMatch(/per-core/i);
  });
});

describe('propose_script / verification (#7130 case 2)', () => {
  it('the model-facing schema exposes the real discriminated union, not an opaque object', () => {
    const schema = emittedInputSchema('propose_script');
    const text = JSON.stringify(schema);
    for (const kind of ['exit_code', 'service_running', 'process_absent', 'file_exists', 'output_matches']) {
      expect(text).toContain(kind);
    }
  });

  const base = {
    language: 'bash',
    content: 'echo hi',
    goal: 'test',
    expectedEffect: 'nothing',
    deviceIds: ['11111111-1111-4111-8111-111111111111'],
  };

  it('rejects a verification claim missing its kind-specific field', () => {
    const result = validateToolInput('propose_script', { ...base, verification: { kind: 'service_running' } });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown discriminator value', () => {
    const result = validateToolInput('propose_script', { ...base, verification: { kind: 'not_a_real_kind' } });
    expect(result.success).toBe(false);
  });

  it('accepts a well-formed claim for each kind', () => {
    const claims = [
      { kind: 'exit_code', equals: 0 },
      { kind: 'service_running', name: 'spooler' },
      { kind: 'process_absent', name: 'notepad.exe' },
      { kind: 'file_exists', path: 'C:\\temp\\done.txt' },
      { kind: 'output_matches', regex: 'ok' },
    ];
    for (const verification of claims) {
      expect(validateToolInput('propose_script', { ...base, verification })).toEqual({ success: true });
    }
  });
});

describe('set_device_context / summary length (#7130 case 3)', () => {
  it('the model-facing schema states the 255-char limit in text, not just maxLength', () => {
    const schema = emittedInputSchema('set_device_context');
    const properties = (schema as { properties?: Record<string, { description?: string }> }).properties ?? {};
    expect(properties.summary?.description ?? '').toContain('255');
  });

  it('rejects a summary over 255 chars before the handler runs', () => {
    const result = validateToolInput('set_device_context', {
      deviceId: TEST_UUID,
      contextType: 'issue',
      summary: 'x'.repeat(256),
    });
    expect(result.success).toBe(false);
  });

  it('accepts a summary at exactly the 255-char limit', () => {
    expect(
      validateToolInput('set_device_context', {
        deviceId: TEST_UUID,
        contextType: 'issue',
        summary: 'x'.repeat(255),
      }),
    ).toEqual({ success: true });
  });
});
