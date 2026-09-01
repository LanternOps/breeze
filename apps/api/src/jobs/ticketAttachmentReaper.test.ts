import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeMock, deleteObjectKeysMock, ctx } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  deleteObjectKeysMock: vi.fn(),
  // Tracks how deep inside withSystemDbAccessContext each side effect happens.
  // A held context is an OPEN transaction pinning a pooled connection, so the
  // object-store round trip must observe depth 0 (#1105) while the row claim
  // must observe depth >= 1 (a contextless statement resolves scope 'none' and
  // would silently see nothing).
  ctx: { depth: 0 },
}));

vi.mock('../db', () => ({
  withSystemDbAccessContext: async <T,>(fn: () => Promise<T>): Promise<T> => {
    ctx.depth++;
    try {
      return await fn();
    } finally {
      ctx.depth--;
    }
  },
  db: { execute: executeMock },
}));

vi.mock('../services/ticketAttachmentStorage', () => ({
  deleteObjectKeys: deleteObjectKeysMock,
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('bullmq', () => ({
  Queue: class { async getRepeatableJobs() { return []; } async add() {} async close() {} },
  Worker: class { on() {} async close() {} },
  Job: class {},
}));

import { reapPendingAttachments, TICKET_ATTACHMENT_REAPER_SCHEDULE_KEY } from './ticketAttachmentReaper';
import { jobSchedule, JOB_SCHEDULES } from './scheduleRegistry';

/**
 * Render a drizzle SQL tree back to text so the PREDICATE can be asserted.
 * Recurses because `sql.raw(...)` nests a whole SQL node rather than a plain
 * string chunk.
 */
function renderSql(node: unknown): string {
  if (node === null || typeof node !== 'object') return '';
  if (Array.isArray(node)) return node.map(renderSql).join('');
  const rec = node as Record<string, unknown>;
  if (Array.isArray(rec.queryChunks)) return renderSql(rec.queryChunks);
  if (Array.isArray(rec.value)) return (rec.value as string[]).join('');
  if (typeof rec.value === 'string') return rec.value;
  return '$'; // bound parameter
}
function sqlText(call: unknown[]): string {
  return renderSql(call[0]);
}

describe('ticketAttachmentReaper (W08 #3902)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockReset();
    deleteObjectKeysMock.mockReset();
    deleteObjectKeysMock.mockResolvedValue(undefined);
    ctx.depth = 0;
  });

  it('claims ONLY pending rows older than 24 hours, capped at 500', async () => {
    executeMock.mockResolvedValue([]);
    await reapPendingAttachments();
    const text = sqlText(executeMock.mock.calls[0]!);
    expect(text).toContain('comment_id IS NULL');
    expect(text).toContain("interval '24 hours'");
    expect(text).toContain('LIMIT 500');
    // The single most damaging bug this job could have: reaping ATTACHED rows.
    expect(text).not.toMatch(/comment_id IS NOT NULL/);
  });

  it('takes the candidate rows under a ROW LOCK in the same statement that deletes them', async () => {
    // The claim must be ONE atomic statement. An unlocked SELECT followed by a
    // separate DELETE lets addTicketComment claim the row in between — and the
    // reaper would already have destroyed its object by then. SKIP LOCKED
    // leaves a row another transaction is mid-claim on for the next sweep.
    executeMock.mockResolvedValue([]);
    await reapPendingAttachments();
    const text = sqlText(executeMock.mock.calls[0]!);
    expect(text).toContain('DELETE FROM ticket_attachments');
    expect(text).toContain('FOR UPDATE SKIP LOCKED');
    expect(text).toContain('RETURNING');
    // ...and there must be no second statement racing the first.
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when there is no backlog', async () => {
    executeMock.mockResolvedValue([]);
    expect(await reapPendingAttachments()).toBe(0);
    expect(executeMock).toHaveBeenCalledTimes(1); // the claim only
    expect(deleteObjectKeysMock).not.toHaveBeenCalled();
  });

  it('deletes the ROWS before the OBJECTS, and only for rows the claim actually won', async () => {
    const order: string[] = [];
    executeMock.mockImplementationOnce(async () => {
      order.push('claim-rows');
      // a3 is deliberately absent from RETURNING: a concurrent addTicketComment
      // claimed it, so the DELETE's locking sub-select dropped it. Its object
      // must NOT be touched — that row is live customer data now.
      return [
        { id: 'a1', storage_backend: 's3', storage_key: 'ticket-attachments/a1' },
        { id: 'a2', storage_backend: 'db', storage_key: null },
      ];
    });
    deleteObjectKeysMock.mockImplementation(async () => { order.push('delete-objects'); });

    expect(await reapPendingAttachments()).toBe(2);
    expect(order).toEqual(['claim-rows', 'delete-objects']);
    // Exactly one statement: a trailing "now really delete the rows" DELETE
    // would mean the objects were destroyed before the rows were claimed.
    expect(executeMock).toHaveBeenCalledTimes(1);
    // Only the s3-backed CLAIMED row contributes a key; db rows carry their
    // bytes in the row and went with the DELETE.
    expect(deleteObjectKeysMock).toHaveBeenCalledWith(['ticket-attachments/a1']);
  });

  it('runs the row claim INSIDE a db context and the object-store call OUTSIDE it', async () => {
    // #1105: a held withSystemDbAccessContext is an open transaction pinning a
    // pooled connection. An S3 round trip inside it sits idle-in-transaction
    // and is killed by idle_in_transaction_session_timeout under load. The
    // claim, conversely, MUST be in a context — contextless is scope 'none',
    // which sees nothing and reports success having done no work.
    let depthAtClaim = -1;
    let depthAtObjectDelete = -1;
    executeMock.mockImplementationOnce(async () => {
      depthAtClaim = ctx.depth;
      return [{ id: 'a1', storage_backend: 's3', storage_key: 'ticket-attachments/a1' }];
    });
    deleteObjectKeysMock.mockImplementation(async () => { depthAtObjectDelete = ctx.depth; });

    await reapPendingAttachments();
    expect(depthAtClaim).toBeGreaterThanOrEqual(1);
    expect(depthAtObjectDelete).toBe(0);
    expect(ctx.depth).toBe(0);
  });

  it('issues no object delete when every claimed row is db-backed', async () => {
    executeMock.mockResolvedValueOnce([{ id: 'a1', storage_backend: 'db', storage_key: null }]);
    await reapPendingAttachments();
    expect(deleteObjectKeysMock).not.toHaveBeenCalled();
  });

  it('surfaces an object-store fault and names the orphaned keys', async () => {
    // The rows are already gone by this point (that is the price of never
    // deleting an object out from under a live row). The bytes are therefore
    // orphaned with no row to find them by, so the fault must be loud and the
    // keys must be recoverable from the log — never swallowed.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    executeMock.mockResolvedValueOnce([{ id: 'a1', storage_backend: 's3', storage_key: 'ticket-attachments/a1' }]);
    deleteObjectKeysMock.mockRejectedValue(new Error('s3 down'));

    await expect(reapPendingAttachments()).rejects.toThrow('s3 down');
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('ticket-attachments/a1');
    errorSpy.mockRestore();
  });

  it('uses an allocated sub-daily slot, never an inline cron string', () => {
    expect(TICKET_ATTACHMENT_REAPER_SCHEDULE_KEY).toBe('ticket-attachment-pending-reaper');
    const pattern = jobSchedule(TICKET_ATTACHMENT_REAPER_SCHEDULE_KEY);
    expect(pattern).toBe('32 * * * *');
    // Sub-daily lane convention: minutes congruent to 2 mod 5.
    const minute = Number(pattern.split(' ')[0]);
    expect(minute % 5).toBe(2);
    // ...and it must not collide with any other allocated slot's minute+hour.
    const same = Object.entries(JOB_SCHEDULES).filter(([, p]) => p === pattern);
    expect(same).toHaveLength(1);
  });
});
