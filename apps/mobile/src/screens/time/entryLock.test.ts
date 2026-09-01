import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/api', () => ({ coreRequest: vi.fn() }));

import { entryLock } from './entryLock';
import type { BillingStatus, TimeEntry } from '../../services/timeEntries';

function entry(overrides: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: 'e1',
    ticketId: 'k1',
    startedAt: '2026-08-23T10:00:00Z',
    endedAt: '2026-08-23T11:00:00Z',
    durationMinutes: 60,
    isBillable: true,
    billingStatus: 'not_billed',
    isApproved: false,
    description: 'onsite',
    ...overrides,
  };
}

describe('entryLock', () => {
  it('lets a billed entry keep its description editable, as the server does', () => {
    // BILLED_LOCKED_ENTRY_FIELDS (timeEntryService.ts) deliberately excludes
    // `description`, and the 409 says "only its description can change". Hiding
    // Edit here strands a technician who cannot fix a typo the API accepts.
    const lock = entryLock(entry({ billingStatus: 'billed' }));

    expect(lock.canEditDescription).toBe(true);
    expect(lock.canToggleBillable).toBe(false);
    expect(lock.badge).toBe('Billed');
    expect(lock.note).toMatch(/description/i);
  });

  it('locks an approved entry completely — assertCanMutate rejects every field', () => {
    const lock = entryLock(entry({ isApproved: true }));

    expect(lock.canEditDescription).toBe(false);
    expect(lock.canToggleBillable).toBe(false);
    expect(lock.badge).toBe('Approved');
    expect(lock.note).toMatch(/approv/i);
  });

  it('keeps approval as the stronger lock when an entry is both approved and billed', () => {
    const lock = entryLock(entry({ isApproved: true, billingStatus: 'billed' }));
    expect(lock.canEditDescription).toBe(false);
    expect(lock.badge).toBe('Approved');
  });

  it('leaves an ordinary entry fully editable', () => {
    const lock = entryLock(entry());
    expect(lock).toEqual({
      canEditDescription: true,
      canToggleBillable: true,
      badge: null,
      note: null,
    });
  });

  it.each<BillingStatus>(['not_billed', 'no_charge', 'contract'])(
    'does not lock billingStatus %s — only an issued invoice freezes an entry',
    (billingStatus) => {
      const lock = entryLock(entry({ billingStatus }));
      expect(lock.canEditDescription).toBe(true);
      expect(lock.canToggleBillable).toBe(true);
      expect(lock.badge).toBeNull();
    }
  );
});
