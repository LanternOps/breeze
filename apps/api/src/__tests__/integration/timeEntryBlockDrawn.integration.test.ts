/** Block hours W02 (#8181): a block-drawn entry is frozen except its description. */
import './setup';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { timeEntries } from '../../db/schema';
import { deleteTimeEntry, updateTimeEntry } from '../../services/timeEntryService';
import { seedBlockFixture, seedEntry, systemActor } from './hourBlockFixtures';

async function readEntry(id: string) {
  const [r] = await withSystemDbAccessContext(() => db.select().from(timeEntries).where(eq(timeEntries.id, id)));
  return r!;
}

async function draw(id: string, lineId: string) {
  await withSystemDbAccessContext(() => db.update(timeEntries)
    .set({ billingStatus: 'contract', contractLineId: lineId }).where(eq(timeEntries.id, id)));
}

describe('block-drawn entry edits (real DB) #8181', () => {
  it('description edit keeps coverage, rate, billable minutes and the block stamp', async () => {
    const f = await seedBlockFixture();
    const id = await seedEntry(f, { minutes: 20, billableMinutes: 30, endedAt: '2026-07-10T12:00:00Z', hourlyRate: '120.00' });
    await draw(id, f.blockLineId);
    const before = await readEntry(id);
    await withSystemDbAccessContext(() => updateTimeEntry(id, { description: 'clarified' }, systemActor(f)));
    const after = await readEntry(id);
    expect(after).toMatchObject({
      description: 'clarified', billingStatus: 'contract', contractLineId: f.blockLineId,
      coverage: before.coverage, hourlyRate: before.hourlyRate, billableMinutes: before.billableMinutes,
      minimumMinutes: before.minimumMinutes, durationMinutes: before.durationMinutes,
    });
  });

  it('a duration edit or a flip back to not_billed is refused and leaves the row unchanged', async () => {
    const f = await seedBlockFixture();
    const id = await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z' });
    await draw(id, f.blockLineId);
    const before = await readEntry(id);
    await expect(withSystemDbAccessContext(() => updateTimeEntry(id, { endedAt: new Date('2026-07-10T14:00:00Z') }, systemActor(f))))
      .rejects.toMatchObject({ status: 409, code: 'ENTRY_DRAWN_BY_BLOCK' });
    await expect(withSystemDbAccessContext(() => updateTimeEntry(id, { billingStatus: 'not_billed' }, systemActor(f))))
      .rejects.toMatchObject({ status: 409, code: 'ENTRY_DRAWN_BY_BLOCK' });
    await expect(withSystemDbAccessContext(() => deleteTimeEntry(id, systemActor(f))))
      .rejects.toMatchObject({ status: 409, code: 'ENTRY_DRAWN_BY_BLOCK' });
    expect(await readEntry(id)).toEqual(before);
  });
});
