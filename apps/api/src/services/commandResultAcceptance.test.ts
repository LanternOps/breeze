import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  commandAcceptsAgentResult,
  commandAcceptsAgentResultCondition,
  ACCEPTED_COMMAND_RESULT_STATUSES,
  SERVER_TIMEOUT_RESULT_STATUS,
} from './commandResultAcceptance';

describe('commandAcceptsAgentResult (#3607)', () => {
  it('accepts the in-flight statuses', () => {
    for (const status of ACCEPTED_COMMAND_RESULT_STATUSES) {
      expect(commandAcceptsAgentResult(status, null)).toBe(true);
    }
  });

  it('accepts a row terminalized by a server-side timeout', () => {
    // Exactly what waitForCommandResult writes at its deadline.
    expect(
      commandAcceptsAgentResult('failed', {
        status: SERVER_TIMEOUT_RESULT_STATUS,
        error: 'Command timed out after 60000ms',
      }),
    ).toBe(true);

    // …and what jobs/staleCommandReaper.ts writes.
    expect(
      commandAcceptsAgentResult('failed', {
        status: SERVER_TIMEOUT_RESULT_STATUS,
        error: 'Server-side timeout',
        timedOutBy: 'server',
      }),
    ).toBe(true);
  });

  it('rejects an agent-reported failure so a duplicate frame cannot rewrite it', () => {
    // buildStoredCommandResult stores the AGENT's status verbatim, and
    // AgentCommandResult.status is only ever completed|failed. This is the
    // discriminator the whole fix rests on: once a real result lands, the row
    // stops being acceptable and double-delivery is still a no-op.
    expect(
      commandAcceptsAgentResult('failed', { status: 'failed', exitCode: 1, stdout: 'boom' }),
    ).toBe(false);
  });

  it('rejects completed and cancelled rows', () => {
    expect(commandAcceptsAgentResult('completed', { status: 'completed', exitCode: 0 })).toBe(false);
    expect(commandAcceptsAgentResult('cancelled', { status: 'cancelled' })).toBe(false);
    // A cancellation that raced onto an already-failed row still stores a
    // 'cancelled' result status, so it is not reopened either.
    expect(commandAcceptsAgentResult('failed', { status: 'cancelled' })).toBe(false);
  });

  it('rejects a failed row with no result payload at all', () => {
    expect(commandAcceptsAgentResult('failed', null)).toBe(false);
    expect(commandAcceptsAgentResult('failed', undefined)).toBe(false);
    expect(commandAcceptsAgentResult('failed', {})).toBe(false);
  });

  it('treats a missing status as acceptable (matches the route\'s pre-read guard)', () => {
    expect(commandAcceptsAgentResult(null, null)).toBe(true);
    expect(commandAcceptsAgentResult(undefined, null)).toBe(true);
  });
});

describe('commandAcceptsAgentResultCondition (#3607)', () => {
  it('compiles to a pending/sent OR timeout-marker predicate with bound params', () => {
    // Compile for real rather than inspecting the builder object: a
    // token-scan of the AST would still pass if the timeout branch were
    // dropped, and the bound-parameter check is what proves the discriminator
    // is not string-interpolated.
    const { sql: text, params } = new PgDialect().sqlToQuery(
      commandAcceptsAgentResultCondition(),
    );

    expect(text).toContain('"status" in');
    expect(text).toContain(`"result"->>'status' =`);
    expect(text).toContain(' or ');
    // Every literal rides as a placeholder, in predicate order.
    expect(params).toEqual([
      ...ACCEPTED_COMMAND_RESULT_STATUSES,
      'failed',
      SERVER_TIMEOUT_RESULT_STATUS,
    ]);
    expect(text).not.toContain(SERVER_TIMEOUT_RESULT_STATUS);
  });
});
