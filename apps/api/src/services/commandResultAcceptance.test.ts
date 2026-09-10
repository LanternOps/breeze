import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  commandAcceptsAgentResult,
  commandAcceptsAgentResultCondition,
  ACCEPTED_COMMAND_RESULT_STATUSES,
  SERVER_TIMEOUT_RESULT_STATUS,
  BACKUP_QUEUE_ACK_RESULT_STATUS,
} from './commandResultAcceptance';
import { QUEUED_BACKUP_WORKLOAD_COMMAND_TYPES } from './commandTypes';

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

  // D20-D: a queued-workload command (mssql_backup, hyperv_backup) is
  // terminalized 'completed' on its FIRST reply so executeCommand()'s
  // waitForCommandResult poll returns promptly with the queue-admission ack —
  // but that ack is not the real outcome, so the row must still accept the
  // real terminal result that arrives later on the same commandId. The
  // BACKUP_QUEUE_ACK_RESULT_STATUS marker (written into the stored
  // result.status, NOT the top-level device_commands.status column) is what
  // keeps this reopenable, exactly like the SERVER_TIMEOUT_RESULT_STATUS
  // marker above.
  describe('D20 — queue-admission ack marker (mssql_backup, hyperv_backup)', () => {
    it('accepts a completed row whose stored result is a queue-ack for a queued-workload type', () => {
      for (const type of QUEUED_BACKUP_WORKLOAD_COMMAND_TYPES) {
        expect(
          commandAcceptsAgentResult(
            'completed',
            { status: BACKUP_QUEUE_ACK_RESULT_STATUS, stdout: '{"queued":true}' },
            type,
          ),
        ).toBe(true);
      }
    });

    it('rejects the same marker for a command type that is not a queued workload', () => {
      // Narrow on purpose (mirrors the timeout-marker discriminator): a
      // completely unrelated command type must never be reopened just
      // because its stored result happens to carry this string.
      expect(
        commandAcceptsAgentResult(
          'completed',
          { status: BACKUP_QUEUE_ACK_RESULT_STATUS },
          'run_script',
        ),
      ).toBe(false);
    });

    it('rejects a genuinely completed queued-workload row (the real result already landed)', () => {
      expect(
        commandAcceptsAgentResult('completed', { status: 'completed' }, 'mssql_backup'),
      ).toBe(false);
    });

    it('ignores the marker when no type is passed (backward compatible default)', () => {
      expect(
        commandAcceptsAgentResult('completed', { status: BACKUP_QUEUE_ACK_RESULT_STATUS }),
      ).toBe(false);
    });
  });
});

describe('commandAcceptsAgentResultCondition (#3607)', () => {
  it('compiles to a pending/sent OR timeout-marker OR queue-ack-marker predicate with bound params', () => {
    // Compile for real rather than inspecting the builder object: a
    // token-scan of the AST would still pass if a branch were dropped, and
    // the bound-parameter check is what proves every discriminator is bound,
    // not string-interpolated.
    const { sql: text, params } = new PgDialect().sqlToQuery(
      commandAcceptsAgentResultCondition(),
    );

    expect(text).toContain('"status" in');
    expect(text).toContain(`"result"->>'status' =`);
    expect(text).toContain('"type" in');
    expect(text).toContain(' or ');
    // Every literal rides as a placeholder, in predicate order.
    expect(params).toEqual([
      ...ACCEPTED_COMMAND_RESULT_STATUSES,
      'failed',
      SERVER_TIMEOUT_RESULT_STATUS,
      'completed',
      ...QUEUED_BACKUP_WORKLOAD_COMMAND_TYPES,
      BACKUP_QUEUE_ACK_RESULT_STATUS,
    ]);
    expect(text).not.toContain(SERVER_TIMEOUT_RESULT_STATUS);
    expect(text).not.toContain(BACKUP_QUEUE_ACK_RESULT_STATUS);
  });
});
