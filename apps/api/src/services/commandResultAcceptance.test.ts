import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  commandAcceptsAgentResult,
  commandAcceptsAgentResultCondition,
  ACCEPTED_COMMAND_RESULT_STATUSES,
  SERVER_TIMEOUT_RESULT_STATUS,
  BACKUP_QUEUE_ACK_RESULT_STATUS,
  TIMEOUT_REOPEN_EXCLUDED_COMMAND_TYPES,
  RESULT_PROCESSING_FAILED_RESULT_STATUS,
  RESULT_PROCESSING_FAILED_REOPEN_EXCLUDED_COMMAND_TYPES,
} from './commandResultAcceptance';
import { QUEUED_BACKUP_WORKLOAD_COMMAND_TYPES } from './commandTypes';

describe('commandAcceptsAgentResult (#3607)', () => {
  it('accepts the in-flight statuses', () => {
    for (const status of ACCEPTED_COMMAND_RESULT_STATUSES) {
      expect(commandAcceptsAgentResult(status, null)).toBe(true);
    }
  });

  it('never reopens a timed-out diagnostic whose plan authority has lapsed', () => {
    for (const type of TIMEOUT_REOPEN_EXCLUDED_COMMAND_TYPES) {
      expect(
        commandAcceptsAgentResult('failed', { status: SERVER_TIMEOUT_RESULT_STATUS }, type),
      ).toBe(false);
      expect(commandAcceptsAgentResult('sent', null, type)).toBe(true);
    }
  });

  it('accepts a row terminalized by a server-side timeout', () => {
    // Exactly what waitForCommandResult writes at its deadline.
    expect(
      commandAcceptsAgentResult('failed', {
        status: SERVER_TIMEOUT_RESULT_STATUS,
        error: 'Command timed out after 60000ms',
        timedOutBy: 'server',
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

    // …and what routes/backup/verificationScheduled.ts writes — a different
    // literal `timedOutBy` value than 'server', which is why the predicate
    // checks the key's presence rather than one specific string.
    expect(
      commandAcceptsAgentResult('failed', {
        status: SERVER_TIMEOUT_RESULT_STATUS,
        error: 'Verification timed out after 30 minutes',
        timedOutBy: 'verification-timeout-check',
      }),
    ).toBe(true);
  });

  // SEC follow-up: buildStoredCommandResult never copies `timedOutBy` from the
  // agent's own payload — the marker is only ever set by a server-side
  // writer. A stored row whose status collides with the server's own
  // SERVER_TIMEOUT_RESULT_STATUS literal but carries no marker cannot have
  // come from one of the three legitimate writers, so it must not be
  // reopenable — otherwise an agent could report its OWN `status:'timeout'`
  // (a value commandResultSchema allows) and keep that row reopenable
  // indefinitely for a later result.
  it('rejects a stored timeout status with no server timedOutBy marker', () => {
    expect(
      commandAcceptsAgentResult('failed', {
        status: SERVER_TIMEOUT_RESULT_STATUS,
        error: 'Agent reported a timeout',
      }),
    ).toBe(false);
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
    expect(text).toContain(`"result"->>'timedOutBy' IS NOT NULL`);
    expect(text).toContain('"type" in');
    expect(text).toContain(' or ');
    // The timedOutBy existence check carries no literal — no agent-supplied
    // value is ever bound for it.
    // Every OTHER literal rides as a placeholder, in predicate order.
    expect(params).toEqual([
      ...ACCEPTED_COMMAND_RESULT_STATUSES,
      'failed',
      ...TIMEOUT_REOPEN_EXCLUDED_COMMAND_TYPES,
      SERVER_TIMEOUT_RESULT_STATUS,
      'completed',
      ...QUEUED_BACKUP_WORKLOAD_COMMAND_TYPES,
      BACKUP_QUEUE_ACK_RESULT_STATUS,
      'failed',
      ...RESULT_PROCESSING_FAILED_REOPEN_EXCLUDED_COMMAND_TYPES,
      RESULT_PROCESSING_FAILED_RESULT_STATUS,
    ]);
    expect(text).toContain(`"result"->>'processingFailedAt' IS NOT NULL`);
    expect(text).not.toContain(SERVER_TIMEOUT_RESULT_STATUS);
    expect(text).not.toContain(BACKUP_QUEUE_ACK_RESULT_STATUS);
    expect(text).not.toContain(RESULT_PROCESSING_FAILED_RESULT_STATUS);
  });
});

// #3530 — a result whose per-type persistence failed is rolled back and the
// row parked as `failed` + this marker, so the history never reads
// "completed" for a result that was not recorded, and a resubmitted result is
// accepted and reprocessed instead of short-circuited as a duplicate.
describe('result-processing-failed marker (#3530)', () => {
  const marked = {
    status: RESULT_PROCESSING_FAILED_RESULT_STATUS,
    agentStatus: 'completed',
    processingFailedAt: '2026-09-28T00:00:00.000Z',
  };

  it('reopens a row parked by a server-side processing failure, for any command type', () => {
    expect(commandAcceptsAgentResult('failed', marked)).toBe(true);
    expect(commandAcceptsAgentResult('failed', marked, 'script')).toBe(true);
    expect(commandAcceptsAgentResult('failed', marked, 'backup_verify')).toBe(true);
  });

  it('requires the server-only processingFailedAt stamp, like timedOutBy', () => {
    expect(
      commandAcceptsAgentResult('failed', { status: RESULT_PROCESSING_FAILED_RESULT_STATUS }),
    ).toBe(false);
  });

  it('never reopens a type whose command row must not be rewritten after it goes terminal', () => {
    // network_diagnostic: plan authority lapses (same reason as the timeout
    // exclusion). PAM: late evidence enters only the frozen PAM result
    // transaction, never a rewrite of the command row.
    for (const type of RESULT_PROCESSING_FAILED_REOPEN_EXCLUDED_COMMAND_TYPES) {
      expect(commandAcceptsAgentResult('failed', marked, type)).toBe(false);
    }
    expect(RESULT_PROCESSING_FAILED_REOPEN_EXCLUDED_COMMAND_TYPES).toEqual(
      expect.arrayContaining(['network_diagnostic', 'pam_apply_v2', 'pam_cleanup_v2']),
    );
  });

  it('only reopens a failed row — never a completed one carrying the marker', () => {
    expect(commandAcceptsAgentResult('completed', marked)).toBe(false);
    expect(commandAcceptsAgentResult('cancelled', marked)).toBe(false);
  });
});
