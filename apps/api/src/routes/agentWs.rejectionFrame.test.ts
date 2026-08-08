import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  buildAgentMessageRejection,
  MAX_ECHOED_FIELD_CHARS,
  MAX_ECHOED_ISSUES,
  MAX_PRECISE_RESULT_MEASURE_BYTES,
} from './agentWs';
import { MAX_COMMAND_RESULT_BYTES } from './agents/schemas';

// The Go parser that consumes the frame this module emits.
const GO_CLIENT_PATH = resolve(__dirname, '../../../../agent/internal/websocket/client.go');

function issues(count = 1): z.ZodIssue[] {
  return Array.from({ length: count }, (_, i) => ({
    code: 'custom',
    path: ['result'],
    message: `issue ${i}`,
  })) as unknown as z.ZodIssue[];
}

describe('agent rejection frame (#3001)', () => {
  it('escalates a rejected command_result to error and names the job', () => {
    const { level, log, frame } = buildAgentMessageRejection({
      agentId: 'agent-1',
      message: { type: 'command_result', commandId: 'cmd-7', status: 'completed', result: { a: 1 } },
      frameBytes: 2_100_000,
      issues: issues(),
    });

    // A lost terminal status is not a warning: nothing downstream of this
    // branch runs, so this line is the only record the job ever produces.
    expect(level).toBe('error');
    expect(log).toContain('cmd-7');
    expect(log).toContain('frameBytes=2100000');
    expect(log).toContain(`resultLimitBytes=${MAX_COMMAND_RESULT_BYTES}`);
    expect(log).toContain('reaper');
    expect(frame.commandId).toBe('cmd-7');
    expect(frame.messageType).toBe('command_result');
  });

  it('keeps other invalid messages at warn', () => {
    const { level, log } = buildAgentMessageRejection({
      agentId: 'agent-1',
      message: { type: 'heartbeat' },
      frameBytes: 120,
      issues: issues(),
    });
    expect(level).toBe('warn');
    expect(log).toContain('type=heartbeat');
  });

  it('skips the precise measurement on a huge frame rather than stalling the event loop', () => {
    // No maxPayload is set on the agent WS server, so `ws` accepts up to
    // 100 MiB and pre-fix agents still send unbounded results. Re-serialising
    // one synchronously to fill a log field is the stall this guard prevents.
    const { log } = buildAgentMessageRejection({
      agentId: 'agent-1',
      message: { type: 'command_result', commandId: 'c1', result: { a: 1 } },
      frameBytes: MAX_PRECISE_RESULT_MEASURE_BYTES,
      issues: issues(),
    });
    expect(log).toContain('resultBytes=unmeasured');
    expect(log).toContain(String(MAX_PRECISE_RESULT_MEASURE_BYTES));
  });

  it('measures precisely just below the threshold', () => {
    const { log } = buildAgentMessageRejection({
      agentId: 'agent-1',
      message: { type: 'command_result', commandId: 'c1', result: { a: 1 } },
      frameBytes: MAX_PRECISE_RESULT_MEASURE_BYTES - 1,
      issues: issues(),
    });
    expect(log).toContain(`resultBytes=${JSON.stringify({ a: 1 }).length}`);
  });

  it('reports an unencodable result body without throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { log } = buildAgentMessageRejection({
      agentId: 'agent-1',
      message: { type: 'command_result', commandId: 'c1', result: cyclic },
      frameBytes: 500,
      issues: issues(),
    });
    expect(log).toContain('resultBytes=unencodable');
  });

  it('clamps agent-supplied strings echoed back in the frame', () => {
    // messageType and commandId come off an UNVALIDATED message — the entire
    // reason this branch exists — so their length is the agent's choice.
    const { frame } = buildAgentMessageRejection({
      agentId: 'agent-1',
      message: { type: 'x'.repeat(5000), commandId: 'y'.repeat(5000) },
      frameBytes: 10_000,
      issues: issues(50),
    });
    expect(frame.messageType.length).toBe(MAX_ECHOED_FIELD_CHARS);
    expect(frame.commandId!.length).toBe(MAX_ECHOED_FIELD_CHARS);
    expect(frame.details.length).toBe(MAX_ECHOED_ISSUES);
  });

  it('survives a message that is not an object at all', () => {
    for (const message of [null, undefined, 5, 'a string', []]) {
      const { level, frame } = buildAgentMessageRejection({
        agentId: 'agent-1',
        message,
        frameBytes: 4,
        issues: issues(),
      });
      expect(level).toBe('warn');
      expect(frame.messageType).toBe('unknown');
      expect(frame.commandId).toBeUndefined();
    }
  });

  it('emits the exact field names the Go agent parses off the frame', () => {
    // THE contract test. logServerErrorFrame in the Go client reads these keys
    // to attribute a rejection to a command. A rename on either side puts the
    // agent back to logging nothing for a lost terminal status — #3001's
    // defining symptom — and nothing else would catch it, because both sides
    // keep compiling and every other test keeps passing.
    const { frame } = buildAgentMessageRejection({
      agentId: 'agent-1',
      message: { type: 'command_result', commandId: 'cmd-7' },
      frameBytes: 100,
      issues: issues(),
    });

    const source = readFileSync(GO_CLIENT_PATH, 'utf8');
    for (const [key, value] of Object.entries(frame)) {
      expect(value).toBeDefined();
      expect(
        source.includes(`json:"${key}"`),
        `the Go error-frame parser has no field tagged json:"${key}"; ` +
          `agent/internal/websocket/client.go logServerErrorFrame must be updated in the same commit`
      ).toBe(true);
    }
  });
});
