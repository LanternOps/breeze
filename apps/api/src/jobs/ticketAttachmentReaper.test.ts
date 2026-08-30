import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeMock, deleteObjectKeysMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  deleteObjectKeysMock: vi.fn(),
}));

vi.mock('../db', () => ({
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>): Promise<T> => fn(),
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
  });

  it('selects ONLY pending rows older than 24 hours, capped at 500', async () => {
    executeMock.mockResolvedValue([]);
    await reapPendingAttachments();
    const text = sqlText(executeMock.mock.calls[0]!);
    expect(text).toContain('comment_id IS NULL');
    expect(text).toContain("interval '24 hours'");
    expect(text).toContain('LIMIT 500');
    // The single most damaging bug this job could have: reaping ATTACHED rows.
    expect(text).not.toMatch(/comment_id IS NOT NULL/);
  });

  it('does nothing at all when there is no backlog', async () => {
    executeMock.mockResolvedValue([]);
    expect(await reapPendingAttachments()).toBe(0);
    expect(executeMock).toHaveBeenCalledTimes(1); // the SELECT only
    expect(deleteObjectKeysMock).not.toHaveBeenCalled();
  });

  it('deletes the OBJECTS before the ROWS', async () => {
    const order: string[] = [];
    executeMock
      .mockImplementationOnce(async () => {
        order.push('select');
        return [
          { id: 'a1', storage_backend: 's3', storage_key: 'ticket-attachments/a1' },
          { id: 'a2', storage_backend: 'db', storage_key: null },
        ];
      })
      .mockImplementationOnce(async () => { order.push('delete-rows'); return []; });
    deleteObjectKeysMock.mockImplementation(async () => { order.push('delete-objects'); });

    expect(await reapPendingAttachments()).toBe(2);
    expect(order).toEqual(['select', 'delete-objects', 'delete-rows']);
    // Only the s3-backed row contributes a key; db rows carry their bytes in
    // the row and go with the DELETE.
    expect(deleteObjectKeysMock).toHaveBeenCalledWith(['ticket-attachments/a1']);
  });

  it('issues no object delete when every pending row is db-backed', async () => {
    executeMock
      .mockResolvedValueOnce([{ id: 'a1', storage_backend: 'db', storage_key: null }])
      .mockResolvedValueOnce([]);
    await reapPendingAttachments();
    expect(deleteObjectKeysMock).not.toHaveBeenCalled();
  });

  it('ABORTS on an object-store fault and leaves the rows for the next run', async () => {
    executeMock.mockResolvedValueOnce([{ id: 'a1', storage_backend: 's3', storage_key: 'ticket-attachments/a1' }]);
    deleteObjectKeysMock.mockRejectedValue(new Error('s3 down'));
    await expect(reapPendingAttachments()).rejects.toThrow('s3 down');
    // The row DELETE must NOT have run — otherwise the bytes survive with no
    // row left to find them by.
    expect(executeMock).toHaveBeenCalledTimes(1);
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
