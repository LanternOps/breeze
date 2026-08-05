import { describe, it, expect } from 'vitest';
import { terminalCommandResultSchema } from './agentWs';

// #3167: the schema's `result` is `.strict()` and used to list only
// event/sessionId/exitCode — none of which is what the agent sends. Every
// successful terminal command_result therefore failed validation and was dropped
// as malformed, and the ack was never sent.
//
// These parse the schema directly. An earlier draft drove the WS message handler
// instead and was VACUOUS: with a valid `status` the handler never reaches the
// drop path in that harness, so "expect not dropped" passed against the broken
// schema too. Verified by reverting the schema and watching those tests stay
// green. Asserting the schema object is the thing that can actually fail.
describe('terminalCommandResultSchema accepts what the agent sends (#3167)', () => {
  const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const envelope = (result: Record<string, unknown>) => ({
    type: 'command_result' as const,
    commandId: `term-start-${SESSION}`,
    status: 'completed' as const,
    result,
  });

  // Exactly the payloads agent/internal/remote/tools/terminal.go returns.
  const agentShapes: Array<[string, Record<string, unknown>]> = [
    ['StartTerminal', { sessionId: SESSION, cols: 80, rows: 24, started: true }],
    ['WriteTerminal', { sessionId: SESSION, written: 12 }],
    ['ResizeTerminal', { sessionId: SESSION, cols: 120, rows: 40, resized: true }],
    ['StopTerminal', { sessionId: SESSION, stopped: true }],
  ];

  for (const [name, result] of agentShapes) {
    it(`accepts the ${name} result`, () => {
      const parsed = terminalCommandResultSchema.safeParse(envelope(result));
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
    });
  }

  it('still rejects an undeclared key, so .strict() is intact', () => {
    const parsed = terminalCommandResultSchema.safeParse(
      envelope({ sessionId: SESSION, somethingNobodyDeclared: 1 })
    );
    expect(parsed.success).toBe(false);
  });

  it('still rejects a malformed session id', () => {
    const parsed = terminalCommandResultSchema.safeParse(envelope({ sessionId: 'x' }));
    expect(parsed.success).toBe(false);
  });

  it('keeps the unconsumed event enum working for agents that do send it', () => {
    // No server code reads result.event on the terminal path — the only readers
    // of fastResult.event are the desktop schema's peer_disconnected /
    // consent_denied. Kept so an agent build that starts sending it is not
    // rejected, which would be this same bug again.
    const parsed = terminalCommandResultSchema.safeParse(
      envelope({ event: 'session_ended', sessionId: SESSION, exitCode: 0 })
    );
    expect(parsed.success).toBe(true);
  });
});
